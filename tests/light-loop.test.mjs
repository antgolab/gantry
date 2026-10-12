/**
 * light-loop.test.mjs — light 出口门端到端契约（AC-6 / AC-7 / AC-8 CLI 路径 /
 * AC-9 CLI 路径 / AC-11），以及 A.9 的 loop/fence 收敛信号。
 *
 * 通过真实 `src/cli.mjs` 在临时 git 项目里跑完整闭环：
 *   change --tier light → 实施改动 → advance（出口门）
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readState } from '../src/lib/state.mjs';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
let tmpDir;

const run = (args) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd: tmpDir, encoding: 'utf-8', timeout: 30000 });

const runResult = (args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: tmpDir, encoding: 'utf-8', timeout: 30000 });

function state() {
  return readState(tmpDir);
}

function execText(changeId) {
  return readFileSync(join(tmpDir, '.gantry/specs', changeId, 'EXECUTION.md'), 'utf-8');
}

function archived(changeId) {
  return existsSync(join(tmpDir, '.gantry/specs/_archive', changeId));
}

function changelog() {
  const p = join(tmpDir, '.gantry/specs/CHANGELOG.md');
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

function write(rel, content) {
  const abs = join(tmpDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function appendDiagnosis(changeId, text) {
  const p = join(tmpDir, '.gantry/specs', changeId, 'EXECUTION.md');
  const cur = readFileSync(p, 'utf-8');
  writeFileSync(p, `${cur.replace(/\s*$/, '')}\n\n## diagnosis\n\n- ${text}\n`, 'utf-8');
}

/** 非 .gantry 的工作区快照（内容层面，避免 git diff HEAD 对 untracked 失效）。 */
function worktreeSnapshot() {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: tmpDir, encoding: 'utf-8',
  });
  return String(r.stdout || '')
    .split('\n')
    .filter((l) => l.trim() && !/\.gantry\//.test(l))
    .map((l) => l.trim())
    .sort()
    .join('\n');
}

function initGitRepo() {
  execFileSync('git', ['init', '-q'], { cwd: tmpDir });
  writeFileSync(join(tmpDir, 'README.md'), '# base\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: tmpDir });
}

function startLight({ id, scope, verify, desc }) {
  const args = ['change', '--tier', 'light', '--scope', scope, '--id', id];
  if (verify) args.push('--verify', verify);
  args.push(desc);
  return run(args);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'light-loop-'));
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('AC-7 · 出口门全通过后自动收尾（无人工关卡）', () => {
  it('in-scope 改动 + verify PASS → 自动归档 + CHANGELOG + STATE idle + loop done', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-ok',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');

    const out = run(['advance']);

    assert.match(out, /code: light_archived/);
    assert.doesNotMatch(out, /确认|approval|是否继续/i, 'light 收尾不得出现确认提示');
    assert.ok(archived('light-ok'), 'change 目录应移入 _archive/');

    const log = changelog();
    assert.match(log, /输出格式微调/, 'CHANGELOG 应含目标');
    assert.match(log, /src\/lib\/foo\.mjs/, 'CHANGELOG 应含改动文件摘要');

    const st = state();
    assert.equal(st.currentStage, 'idle');
    assert.equal(st.activeChange, null);

    // A.9：收尾后 loop driver 应看到 done，而非 gantry-change
    const lp = run(['loop-next']);
    assert.equal(lp.trim(), 'done');
  });
});

describe('AC-6 · verify 失败不静默放行（R2.5 三次自愈 + 暂停）', () => {
  it('连续不同诊断：第 4 次暂停 light-verify-failed，全程不归档', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-fail',
      scope: 'src/x.mjs',
      verify: 'node -e "process.exit(1)"',
      desc: '输出格式微调',
    });
    write('src/x.mjs', 'x\n');

    let r = runResult(['advance']);
    assert.equal(r.status, 1, '首次失败应非零退出');
    assert.equal(state().retries, 1);
    assert.equal(archived('light-fail'), false);
    assert.equal(changelog(), '', '失败不得写 CHANGELOG');

    appendDiagnosis('light-fail', '诊断 A');
    r = runResult(['advance']);
    assert.equal(r.status, 1);
    assert.equal(state().retries, 2);
    assert.equal(state().pauseReason, null, '第 2 次不应暂停');

    appendDiagnosis('light-fail', '诊断 B');
    r = runResult(['advance']);
    assert.equal(r.status, 1);
    assert.equal(state().retries, 3);
    assert.equal(state().pauseReason, null, '第 3 次不应暂停');

    appendDiagnosis('light-fail', '诊断 C');
    r = runResult(['advance']);
    assert.equal(r.status, 1);
    assert.equal(state().pauseReason, 'light-verify-failed');
    assert.equal(archived('light-fail'), false);
    assert.equal(changelog(), '', '暂停后也不得写 CHANGELOG');
  });

  it('重复同一诊断 → 立即暂停 light-verify-no-new-diagnosis', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-rep',
      scope: 'src/x.mjs',
      verify: 'node -e "process.exit(1)"',
      desc: '输出格式微调',
    });
    write('src/x.mjs', 'x\n');

    let r = runResult(['advance']);
    assert.equal(r.status, 1);
    assert.equal(state().retries, 1);

    appendDiagnosis('light-rep', '同一诊断');
    r = runResult(['advance']);
    assert.equal(r.status, 1);
    assert.equal(state().retries, 2, '新诊断应计为有效自愈');

    // 不再追加新诊断 → 与上一条相同
    r = runResult(['advance']);
    assert.equal(r.status, 1);
    assert.equal(state().pauseReason, 'light-verify-no-new-diagnosis');
    assert.equal(archived('light-rep'), false);
    assert.equal(changelog(), '');
  });
});

describe('AC-11 · 缺 fresh verify 证据不能收尾', () => {
  it('verify 过程改写 in-scope 文件 → 仅 stale-verify，回到 verify 不升档', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-stale',
      scope: 'src/lib/foo.mjs',
      verify: `node -e "require('fs').writeFileSync('src/lib/foo.mjs','from-verify')"`,
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'initial\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 1, '证据不新鲜应非零退出');
    assert.equal(archived('light-stale'), false);

    const st = state();
    assert.equal(st.pipeline, 'light', '不应升档');
    assert.equal(st.currentStage, 'fast');
    assert.equal(existsSync(join(tmpDir, '.gantry/specs/light-stale/PROPOSAL.md')), false, 'stale 不应触发升档');

    assert.match(execText('light-stale'), /stale-verify/, 'guard-decision 应记录 stale-verify');
  });
});

describe('AC-8 · 守卫红线命中自动升 full@change（CLI 路径）', () => {
  it('in-scope migrations/*.sql → full@change + PROPOSAL 初稿，工作区不动', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-red',
      scope: 'migrations/',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('migrations/001.sql', 'SELECT 1;\n');

    const before = worktreeSnapshot();
    const r = runResult(['advance']);

    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.equal(state().pipeline, 'full');
    assert.equal(state().currentStage, 'change');
    assert.ok(existsSync(join(tmpDir, '.gantry/specs/light-red/PROPOSAL.md')), '应生成 PROPOSAL 初稿');
    assert.equal(worktreeSnapshot(), before, '升档前后工作区应一致');
  });
});

describe('AC-9 · 越界修改自动升档（CLI 路径）', () => {
  it('范围外文件出现在 diff → out-of-scope 升档，文件列入 PROPOSAL', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-oos',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/bar.mjs', 'export const b = 1;\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /out-of-scope/);
    assert.equal(state().currentStage, 'change');

    const proposal = readFileSync(join(tmpDir, '.gantry/specs/light-oos/PROPOSAL.md'), 'utf-8');
    assert.match(proposal, /out-of-scope/);
    assert.match(proposal, /src\/lib\/bar\.mjs/);
  });
});

describe('D7/D14 · 无 verify 命令 → guard-error 升档', () => {
  it('既无 intent.verify 也无 test-commands.yml → guard-error(no-verify-command)', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    run(['change', '--tier', 'light', '--scope', 'src/lib/foo.mjs', '--id', 'light-noverify', '输出格式微调']);
    write('src/lib/foo.mjs', 'export const a = 1;\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /guard-error/);
    assert.match(r.stdout, /no-verify-command/);
    assert.equal(state().currentStage, 'change');
  });
});

describe('light 出口门不可跳过', () => {
  it('advance --skip → 非零退出，未归档', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-skip',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');

    const r = runResult(['advance', '--skip']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /light 出口门不可跳过/);
    assert.equal(archived('light-skip'), false);
    assert.equal(state().pipeline, 'light');
  });
});

describe('baseline · 已存在且未改动的零散文件不算越界', () => {
  it('预先存在的 untracked 文件（哈希未变）不触发 out-of-scope', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    write('notes.txt', 'stray pending edit\n'); // change 之前就在 → 进入 baseline
    startLight({
      id: 'light-base',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);
    assert.ok(archived('light-base'));
  });
});
