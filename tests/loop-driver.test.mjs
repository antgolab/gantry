/**
 * loop-driver.test.mjs — loop.sh 端到端契约(mock CLI)
 *
 * 对齐 SPEC AC-5 / AC-6。用 GANTRY_BIN 环境变量指向 mock 脚本,
 * 隔离真实 CLI 副作用,只验证 driver 的循环 / 派发 / stuck 检测。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOOP_SH = join(import.meta.dirname, '..', '.gantry', 'loop', 'loop.sh');

/**
 * 造一个 mock CLI:按预设的 token 序列依次返回,每次调用消费一行。
 * 状态存 sequence.txt(每行一 token);advance / loop-guard 独立分支。
 *
 * @param {string[]} nextTokens - loop-next 依次返回的 token
 * @param {object} opts - { guardBlockAt?: number, advanceFailAt?: number }
 */
function makeMockCli(nextTokens, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-driver-'));
  const seqPath = join(dir, 'sequence.txt');
  const counterPath = join(dir, 'counter.txt');
  const guardCounterPath = join(dir, 'guard-counter.txt');
  const advanceCounterPath = join(dir, 'advance-counter.txt');
  writeFileSync(seqPath, nextTokens.join('\n') + '\n', 'utf-8');
  writeFileSync(counterPath, '0', 'utf-8');
  writeFileSync(guardCounterPath, '0', 'utf-8');
  writeFileSync(advanceCounterPath, '0', 'utf-8');

  const mockScript = join(dir, 'mock-cli.sh');
  writeFileSync(mockScript, `#!/usr/bin/env bash
# 参数:$1 = 子命令(loop-next / loop-guard / advance / status)
set -euo pipefail
CMD="$1"
DIR="${dir}"

case "$CMD" in
  loop-next)
    n=$(cat "$DIR/counter.txt")
    n=$((n + 1))
    echo "$n" > "$DIR/counter.txt"
    line=$(sed -n "\${n}p" "$DIR/sequence.txt")
    if [ -z "$line" ]; then
      # 序列耗尽 → 输出 done 保底
      echo "done"
      exit 0
    fi
    echo "$line"
    if [ "$line" = "blocked" ]; then exit 2; fi
    exit 0
    ;;
  loop-guard)
    g=$(cat "$DIR/guard-counter.txt")
    g=$((g + 1))
    echo "$g" > "$DIR/guard-counter.txt"
    ${opts.guardBlockAt != null ? `if [ "$g" -eq ${opts.guardBlockAt} ]; then echo "blocked: mock context-exceeded"; exit 2; fi` : ''}
    echo "ok"
    exit 0
    ;;
  advance)
    a=$(cat "$DIR/advance-counter.txt")
    a=$((a + 1))
    echo "$a" > "$DIR/advance-counter.txt"
    ${opts.advanceFailAt != null ? `if [ "$a" -eq ${opts.advanceFailAt} ]; then echo "advance mock failure"; exit 5; fi` : ''}
    echo "mock: advanced"
    exit 0
    ;;
  status)
    # 支持 --json 分支,driver 读 currentStage
    echo '{"currentStage":"dev","pipeline":"full"}'
    exit 0
    ;;
  *)
    echo "mock: unknown $CMD"
    exit 1
    ;;
esac
`, 'utf-8');
  chmodSync(mockScript, 0o755);
  return { dir, mockScript };
}

function runDriver({ mockScript, extraEnv = {}, timeout = 10000 }) {
  return spawnSync('bash', [LOOP_SH], {
    encoding: 'utf-8',
    timeout,
    env: {
      ...process.env,
      GANTRY_BIN: mockScript,
      ...extraEnv,
    },
  });
}

test('AC-5 · done token → exit 0', () => {
  const { dir, mockScript } = makeMockCli(['gantry-task', 'gantry-dev', 'done']);
  try {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
    // 收敛前有 2 次 advance 调用
    assert.match(r.stdout, /token=gantry-task/);
    assert.match(r.stdout, /token=gantry-dev/);
    assert.match(r.stdout, /token=done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-5 · blocked token → exit 2', () => {
  const { dir, mockScript } = makeMockCli(['gantry-dev', 'blocked']);
  try {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /token=blocked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-6 · 日志行格式严格 [loop] step=N stage=<s> token=<t>', () => {
  const { dir, mockScript } = makeMockCli(['gantry-task', 'done']);
  try {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 0);
    const lines = r.stdout.split('\n').filter(l => l.startsWith('[loop] step='));
    assert.ok(lines.length >= 2, `期望 >=2 步日志,得到 ${lines.length}`);
    for (const line of lines) {
      assert.match(line, /^\[loop\] step=\d+ stage=[a-z-]+ token=[a-z-]+$/,
        `日志格式违约: ${line}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-5 · stuck 检测:同 token 连续 → exit 3', () => {
  // 3 次同 token → 第一次记录,第二次 stuck_count=1,第三次 stuck_count=2 命中 STUCK_LIMIT
  const { dir, mockScript } = makeMockCli(['gantry-dev', 'gantry-dev', 'gantry-dev']);
  try {
    const r = runDriver({ mockScript, extraEnv: { LOOP_STUCK_LIMIT: '2' } });
    assert.equal(r.status, 3, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /stuck/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-5 · guard 熔断 → exit 2', () => {
  const { dir, mockScript } = makeMockCli(['gantry-task', 'gantry-dev', 'done'], { guardBlockAt: 2 });
  try {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /guard tripped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-5 · advance 失败 → 透传 exit code', () => {
  const { dir, mockScript } = makeMockCli(['gantry-task', 'gantry-dev', 'done'], { advanceFailAt: 2 });
  try {
    const r = runDriver({ mockScript });
    assert.equal(r.status, 5, `advance rc 应透传`);
    assert.match(r.stdout, /advance failed rc=5/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
