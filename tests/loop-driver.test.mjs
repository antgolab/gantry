/**
 * loop-driver.test.mjs — loop.sh 端到端契约(mock CLI)
 *
 * 用 GANTRY_BIN 环境变量指向 mock 脚本,隔离真实 CLI 副作用,
 * 只验证 driver 的循环 / 派发 / stuck / 重试 / 输出纪律。
 *
 * 2026-10-12 契约更新:
 *   - 默认「全显示」:每步头行 `[loop] step=N/MAX stage=.. token=.. attempt=K`
 *     + 流式转发 dispatch stdout;`--quiet` 才退回到单行摘要
 *   - dispatch / advance 失败带诊断退避重试,上限取 status.maxRetries;
 *     advance rc=2 是硬停,不重试
 * 旧断言(期望 `[loop] step=N stage=.. token=..` 与 `token=gantry-task`、静默
 * dispatch)对应 2026-10-10 之前的 loop.sh,已按新契约重写。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// driver 是随包分发的代码，住在 src/loop/（不进 .gantry/——那里只放运行时产物）
const LOOP_SH = join(import.meta.dirname, '..', 'src', 'loop', 'loop.sh');

/**
 * 造一个 mock CLI,行为由目录下的 plan 文件驱动:
 *   sequence.txt      loop-next 依次返回的 token
 *   advance-plan.txt  第 N 次 advance 调用的退出码(缺省 0);写 `blk` = exit 2
 *   dispatch-plan.txt 第 N 次 dispatch 调用的退出码(缺省 0)——由 mock dispatcher 读
 *   max-retries.txt   status --json 里报的 maxRetries(缺省不报)
 */
function makeMockCli(nextTokens, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-driver-'));
  writeFileSync(join(dir, 'sequence.txt'), nextTokens.join('\n') + '\n', 'utf-8');
  writeFileSync(join(dir, 'counter.txt'), '0', 'utf-8');
  writeFileSync(join(dir, 'advance-counter.txt'), '0', 'utf-8');
  writeFileSync(join(dir, 'dispatch-counter.txt'), '0', 'utf-8');
  writeFileSync(join(dir, 'advance-plan.txt'), (opts.advancePlan ?? []).join('\n') + '\n', 'utf-8');
  writeFileSync(join(dir, 'dispatch-plan.txt'), (opts.dispatchPlan ?? []).join('\n') + '\n', 'utf-8');
  if (opts.maxRetries != null) {
    writeFileSync(join(dir, 'max-retries.txt'), String(opts.maxRetries), 'utf-8');
  }

  const mockScript = join(dir, 'mock-cli.sh');
  writeFileSync(mockScript, `#!/usr/bin/env bash
# 参数:$1 = 子命令(loop-next / advance / status)
set -uo pipefail
CMD="$1"
DIR="${dir}"

nth_rc() {
  # nth_rc <file> <n> → 该行的退出码,越界或缺省为 0
  local f="$1" n="$2" line
  line=$(sed -n "\${n}p" "$f" 2>/dev/null)
  [[ -z "$line" ]] && { echo 0; return; }
  [[ "$line" = "blk" ]] && { echo 2; return; }
  echo "$line"
}

case "$CMD" in
  loop-next)
    n=$(cat "$DIR/counter.txt"); n=$((n + 1)); echo "$n" > "$DIR/counter.txt"
    line=$(sed -n "\${n}p" "$DIR/sequence.txt")
    if [ -z "$line" ]; then echo "done"; exit 0; fi
    echo "$line"
    if [ "$line" = "blocked" ]; then
      echo "[loop-next warn] blockedReason: mock gate" 1>&2
      exit 2
    fi
    exit 0
    ;;
  advance)
    a=$(cat "$DIR/advance-counter.txt"); a=$((a + 1)); echo "$a" > "$DIR/advance-counter.txt"
    rc=$(nth_rc "$DIR/advance-plan.txt" "$a")
    if [ "$rc" -eq 2 ]; then echo "[advance warn] max-stages-exceeded" 1>&2; exit 2; fi
    if [ "$rc" -ne 0 ]; then echo "✗ 门禁未通过 [1/3]: mock gate reason" 1>&2; exit "$rc"; fi
    echo "mock: advanced"
    exit 0
    ;;
  status)
    MR=""
    [[ -f "$DIR/max-retries.txt" ]] && MR=$(cat "$DIR/max-retries.txt")
    if [ -n "$MR" ]; then
      echo "{\\"currentStage\\":\\"dev\\",\\"pipeline\\":\\"full\\",\\"maxRetries\\":$MR}"
    else
      echo '{"currentStage":"dev","pipeline":"full"}'
    fi
    exit 0
    ;;
  *)
    echo "mock: unknown $CMD" 1>&2
    exit 1
    ;;
esac
`, 'utf-8');
  chmodSync(mockScript, 0o755);
  return { dir, mockScript };
}

/**
 * 造一个 mock dispatcher,行为同样由 plan 文件驱动,并把收到的重试上下文
 * 显式回显到 stdout —— 断言「重试带诊断」靠这行。
 */
function makeMockDispatcher(dir) {
  const p = join(dir, 'mock-dispatcher.sh');
  writeFileSync(p, `#!/usr/bin/env bash
set -uo pipefail
DIR="${dir}"
n=$(cat "$DIR/dispatch-counter.txt" 2>/dev/null || echo 0); n=$((n + 1))
echo "$n" > "$DIR/dispatch-counter.txt"

echo "[mock-dispatcher] phase=$1 call=$n"
if [[ -n "\${GANTRY_LOOP_RETRY_CONTEXT:-}" && -s "\${GANTRY_LOOP_RETRY_CONTEXT}" ]]; then
  echo "[mock-dispatcher] retry-ctx: $(tr '\\n' ' ' < "$GANTRY_LOOP_RETRY_CONTEXT")"
fi

line=$(sed -n "\${n}p" "$DIR/dispatch-plan.txt" 2>/dev/null)
if [[ -n "$line" && "$line" != "0" ]]; then
  echo "[mock-dispatcher] failing rc=$line" 1>&2
  exit "$line"
fi
exit 0
`, 'utf-8');
  chmodSync(p, 0o755);
  return p;
}

function runDriver({ mockScript, extraEnv = {}, timeout = 15000, client = 'claude', flags = [] }) {
  const dir = join(mockScript, '..');
  const dispatcher = makeMockDispatcher(dir);
  return spawnSync('bash', [LOOP_SH, client, ...flags], {
    encoding: 'utf-8',
    timeout,
    // cwd 指到 mock 目录:driver 的 PROJECT_ROOT=$(pwd),这样 metrics.jsonl /
    // last-dispatch.log / last-failure.txt 全落在临时目录,不污染真实仓库。
    cwd: dir,
    env: {
      ...process.env,
      GANTRY_BIN: mockScript,
      GANTRY_LOOP_DISPATCHER: dispatcher,
      GANTRY_LOOP_BACKOFF: '0',   // 测试不等待
      ...extraEnv,
    },
  });
}

function withMock(opts, nextTokens, fn) {
  const { dir, mockScript } = makeMockCli(nextTokens, opts);
  try {
    return fn({ dir, mockScript });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- 基本收敛契约 -------------------------------------------------------------

test('done token → exit 0', () => {
  withMock({}, ['gantry-task', 'gantry-dev', 'done'], ({ mockScript }) => {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.match(r.stdout, /token=gantry-task/);
    assert.match(r.stdout, /token=gantry-dev/);
    assert.match(r.stdout, /✓ done \(steps=3 elapsed=\d+ms\)/);
  });
});

test('blocked token → exit 2,带 reason', () => {
  withMock({}, ['gantry-dev', 'blocked'], ({ mockScript }) => {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /blocked stage=dev/);
    assert.match(r.stderr, /mock gate/);
  });
});

test('stuck 检测:同 token 连续 → exit 5', () => {
  withMock({}, ['gantry-dev', 'gantry-dev', 'gantry-dev'], ({ mockScript }) => {
    const r = runDriver({ mockScript, extraEnv: { LOOP_STUCK_LIMIT: '2' } });
    assert.equal(r.status, 5, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /stuck/);
  });
});

// --- 输出纪律:默认全显示 / --quiet -------------------------------------------

test('默认全显示:头行 + 流式转发 dispatch 输出', () => {
  withMock({}, ['gantry-task', 'done'], ({ mockScript }) => {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^\[loop\] step=1\/40 stage=\S+ token=gantry-task attempt=1$/m,
      `缺头行:\n${r.stdout}`);
    // dispatcher stdout 被转发到终端(默认不再静默)
    assert.match(r.stdout, /\[mock-dispatcher\] phase=task call=1/,
      `dispatch 输出未转发:\n${r.stdout}`);
    // 步末摘要行
    assert.match(r.stdout, /^\[loop\] step=1\/40 ok dispatch=\d+ms advance=\d+ms attempt=1$/m);
  });
});

test('--quiet:无头行、无 dispatch 转发,只有单行摘要', () => {
  withMock({}, ['gantry-task', 'done'], ({ mockScript }) => {
    const r = runDriver({ mockScript, flags: ['--quiet'] });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /\[loop\] step=/);
    assert.doesNotMatch(r.stdout, /\[mock-dispatcher\]/);
    assert.match(r.stdout, /^step=1\/40 stage=\S+ token=task dispatch=\d+ms advance=\d+ms rc=0$/m);
  });
});

test('--verbose 作为兼容别名被接受(不再报用法错)', () => {
  withMock({}, ['done'], ({ mockScript }) => {
    const r = runDriver({ mockScript, flags: ['--verbose'] });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
  });
});

// --- 重试与自主决策 -----------------------------------------------------------

test('advance 失败 → 带诊断重试 dispatch,恢复后继续到 done', () => {
  // 第 1 次 advance 失败(rc=1),第 2 次成功
  withMock({ advancePlan: ['1', '0'], maxRetries: 3 }, ['gantry-dev', 'done'], ({ mockScript, dir }) => {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    // 重试日志可见
    assert.match(r.stderr, /\[loop\] ↻ retry 1\/3 token=gantry-dev advance-rc=1/);
    // 第二次 dispatch 收到了失败上下文 —— 证明不是盲重试
    assert.match(r.stdout, /\[mock-dispatcher\] phase=dev call=2/);
    assert.match(r.stdout, /\[mock-dispatcher\] retry-ctx: .*门禁未通过/);
    // 失败上下文确实落盘过(driver 成功后删除,但 mock 目录里仍留有 dispatch 日志)
    assert.ok(existsSync(join(dir, '.gantry', 'loop', 'last-dispatch.log')));
  });
});

test('advance 持续失败 → 重试 N 次后透传 rc', () => {
  // maxRetries=2 → 1 次首发 + 2 次重试 = 3 次 advance 全失败 → exit 1
  withMock({ advancePlan: ['1', '1', '1', '1', '1'], maxRetries: 2 }, ['gantry-dev'], ({ mockScript }) => {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /\[loop\] ↻ retry 1\/2/);
    assert.match(r.stderr, /\[loop\] ↻ retry 2\/2/);
    assert.doesNotMatch(r.stderr, /retry 3\/2/);
    assert.match(r.stderr, /advance rc=1 phase=dev 重试 2 次仍失败/);
  });
});

test('dispatch 失败 → 退避重试,恢复后继续到 done', () => {
  withMock({ dispatchPlan: ['1', '0'], maxRetries: 3 }, ['gantry-dev', 'done'], ({ mockScript }) => {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /\[loop\] ↻ retry 1\/3 token=gantry-dev dispatch-rc=1/);
    assert.match(r.stdout, /\[mock-dispatcher\] phase=dev call=2/);
  });
});

test('dispatch 持续失败 → exit 4', () => {
  withMock({ dispatchPlan: ['1', '1', '1'], maxRetries: 2 }, ['gantry-dev'], ({ mockScript }) => {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 4, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /dispatch rc=1 phase=dev 重试 2 次仍失败/);
  });
});

test('dispatch rc=64(配置错)是硬停,不重试,exit 64', () => {
  // 未知 phase / phase 文件缺失这类确定性失败,退避重试只会白等
  withMock({ dispatchPlan: ['64'], maxRetries: 3 }, ['gantry-dev'], ({ mockScript }) => {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 64, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.doesNotMatch(r.stderr, /↻ retry/);
    assert.match(r.stderr, /dispatch rc=64 phase=dev 用法\/配置错,不重试/);
  });
});

test('advance rc=2(熔断)是硬停,不重试,透传 exit 2', () => {
  withMock({ advancePlan: ['blk'], maxRetries: 3 }, ['gantry-dev'], ({ mockScript }) => {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 2, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.doesNotMatch(r.stderr, /↻ retry/);
    assert.match(r.stderr, /blocked: advance rc=2 phase=dev/);
  });
});

test('重试上限默认取 status.maxRetries;env GANTRY_LOOP_RETRIES 可覆盖', () => {
  withMock({ advancePlan: ['1', '1', '1', '1'], maxRetries: 1 }, ['gantry-dev'], ({ mockScript }) => {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /retry 1\/1/);
    assert.doesNotMatch(r.stderr, /retry 2\/1/);
  });
  withMock({ advancePlan: ['1', '1', '1', '1'], maxRetries: 1 }, ['gantry-dev'], ({ mockScript }) => {
    const r = runDriver({ mockScript, extraEnv: { GANTRY_LOOP_RETRIES: '3' } });
    assert.match(r.stderr, /retry 3\/3/, `env 覆盖未生效:\n${r.stderr}`);
  });
});

test('重试成功后清掉失败上下文(不污染下一步)', () => {
  withMock({ advancePlan: ['1', '0'], maxRetries: 3 }, ['gantry-dev', 'done'], ({ mockScript }) => {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    // 重试上下文只在 retry 轮次出现;成功收尾时文件应已删除,
    // 所以 call=2 有 ctx,而后续(若有)不会带旧 ctx
    const ctxLines = r.stdout.split('\n').filter(l => l.includes('retry-ctx:'));
    assert.equal(ctxLines.length, 1, `ctx 应只出现在重试轮:\n${r.stdout}`);
  });
});

// --- 用法 ---------------------------------------------------------------------

test('loop.sh · 缺 client 参数 → exit 64', () => {
  const r = spawnSync('bash', [LOOP_SH], { encoding: 'utf-8', timeout: 5000 });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /缺 client 参数/);
});

test('loop.sh · 未知 client → exit 64', () => {
  const r = spawnSync('bash', [LOOP_SH, 'bogus'], { encoding: 'utf-8', timeout: 5000 });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /未知参数 'bogus'|缺 client 参数/);
});

test('loop.sh · 未知 flag → exit 64', () => {
  const r = spawnSync('bash', [LOOP_SH, 'claude', '--nope'], { encoding: 'utf-8', timeout: 5000 });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /未知参数 '--nope'/);
});

// --- metrics ------------------------------------------------------------------

test('metrics.jsonl 每步落一行,含 attempt 字段', () => {
  withMock({}, ['gantry-task', 'done'], ({ mockScript, dir }) => {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 0);
    const metrics = join(dir, '.gantry', 'loop', 'metrics.jsonl');
    assert.ok(existsSync(metrics), 'metrics.jsonl 未生成');
    const rows = readFileSync(metrics, 'utf-8').trim().split('\n')
      .map(l => JSON.parse(l))
      .filter(x => x.token === 'gantry-task');
    assert.ok(rows.length >= 1, 'gantry-task 步未落指标');
    assert.equal(rows[rows.length - 1].attempt, 1);
  });
});
