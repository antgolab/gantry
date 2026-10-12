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
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readState } from '../src/lib/state.mjs';
import { requiresApproval } from '../src/lib/phases.mjs';

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

// fixture 更新（D31）：固定分支名 main —— 新用例要 `git checkout -b feat` / `git checkout main`
// 往返，不能依赖宿主 `init.defaultBranch` 的取值。
function initGitRepo() {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
  writeFileSync(join(tmpDir, 'README.md'), '# base\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: tmpDir });
}

/**
 * D31 用例专用：把 install 产物（.gantry/、.claude/、CLAUDE.md）写进 `.git/info/exclude`（不入库），
 * 使 `git stash -u` / `git add -A` 只作用于工作区改动：否则 light 状态（STATE / light.json / 锚定）
 * 会被 stash 或提交搬走，用例测的就不是「refs 漂移」了；而 stash→pop 往返还会刷新 CLAUDE.md 的
 * mtime，被 D17 的 `filterByBaseline`（哈希一致但仍需 mtime ≤ createdAt）判成改动。
 */
function excludeInstallArtifacts() {
  const p = join(tmpDir, '.git', 'info', 'exclude');
  const cur = existsSync(p) ? readFileSync(p, 'utf-8') : '';
  writeFileSync(p, `${cur.replace(/\s*$/, '')}\n.gantry/\n.claude/\nCLAUDE.md\n`, 'utf-8');
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

// --- D17 / F-01 · 意图锚定：篡改 light.json 一律升档，不归档 ---

function lightJsonPath(id) {
  return join(tmpDir, '.gantry/specs', id, 'light.json');
}

function readLightJson(id) {
  return JSON.parse(readFileSync(lightJsonPath(id), 'utf-8'));
}

function writeLightJson(id, obj) {
  writeFileSync(lightJsonPath(id), `${JSON.stringify(obj, null, 2)}\n`, 'utf-8');
}

function anchorPath() {
  return join(tmpDir, '.gantry/planning/light-anchor.json');
}

describe('D17 · 意图锚定（intent-tampered → 升档）', () => {
  /** 起一个 light change 并实施一处 in-scope 改动，返回 changeId。 */
  function setupTamper(id) {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id,
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
  }

  it('入口后锚定文件存在且 content 为 light.json 的规范化 sha256', () => {
    setupTamper('light-anchor-ok');
    assert.ok(existsSync(anchorPath()), '入口应写 .gantry/planning/light-anchor.json');
    const anchor = JSON.parse(readFileSync(anchorPath(), 'utf-8'));
    assert.equal(anchor.changeId, 'light-anchor-ok');
  });

  it('(a) 放宽 scope → intent-tampered 升档，不归档', () => {
    setupTamper('light-tamper-scope');
    const lj = readLightJson('light-tamper-scope');
    lj.intent.scope = ['migrations/'];
    writeLightJson('light-tamper-scope', lj);
    write('migrations/001.sql', 'DROP TABLE users;\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /intent-tampered/);
    assert.equal(archived('light-tamper-scope'), false, '篡改不得归档');
    assert.equal(state().currentStage, 'change');
    assert.ok(!existsSync(anchorPath()), '升档后应清理锚定');
  });

  it('(b) 把 intent.verify 改成 true → intent-tampered 升档', () => {
    setupTamper('light-tamper-verify');
    const lj = readLightJson('light-tamper-verify');
    lj.intent.verify = 'true';
    writeLightJson('light-tamper-verify', lj);

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /intent-tampered/);
    assert.equal(archived('light-tamper-verify'), false);
  });

  it('(c) 注入 baseline 哈希遮蔽越界文件 → intent-tampered 升档', () => {
    setupTamper('light-tamper-baseline');
    write('migrations/001.sql', 'DROP TABLE users;\n');
    const sha1 = createHash('sha1').update(readFileSync(join(tmpDir, 'migrations/001.sql'))).digest('hex');
    const lj = readLightJson('light-tamper-baseline');
    lj.baseline['migrations/001.sql'] = sha1;
    writeLightJson('light-tamper-baseline', lj);

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /intent-tampered/);
    assert.equal(archived('light-tamper-baseline'), false);
  });

  it('(d) 删除锚定文件 → intent-tampered(anchor-missing) 升档', () => {
    setupTamper('light-tamper-noanchor');
    rmSync(anchorPath());

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /intent-tampered/);
    assert.match(r.stdout, /anchor-missing/);
    assert.equal(archived('light-tamper-noanchor'), false);
  });

  it('未篡改的金路径仍正常收尾（锚定不误报）', () => {
    setupTamper('light-anchor-clean');
    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);
    assert.ok(archived('light-anchor-clean'));
    assert.ok(!existsSync(anchorPath()), '收尾后应清理锚定');
  });

  it('入口时已脏、入口后又改动的文件不被剔除 → out-of-scope 升档', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    write('src/cli.mjs', 'old\n'); // 入口前就脏 → 进 baseline
    startLight({
      id: 'light-edit-after',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
    write('src/cli.mjs', 'changed again after entry\n'); // 入口后再改 → 哈希变化，必须保留

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /out-of-scope/);
    assert.equal(archived('light-edit-after'), false);
  });
});

// --- D21 / F-02 · 改名拆成旧路径 D + 新路径 A ---

function commitFiles(files) {
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'base files'], { cwd: tmpDir });
}

/** 把当前工作区全部改动（含 .gantry/）提交 —— head-moved 用例的复现动作。 */
function commitAll(msg = 'sneak commit') {
  execFileSync('git', ['add', '-A'], { cwd: tmpDir });
  execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', msg], { cwd: tmpDir });
}

describe('D21 · 改名不得绕过守卫（--no-renames：旧路径 D + 新路径 A）', () => {
  const TEST_FILE = [
    'import { test } from "node:test";',
    'import assert from "node:assert";',
    'test("a", () => { assert.ok(1); });',
    'test("b", () => { assert.ok(2); });',
  ].join('\n');

  it('git mv tests/a.test.mjs src/a.mjs（scope 含 tests/ 与 src/）→ test-weakened 升档', () => {
    initGitRepo();
    commitFiles({ 'tests/a.test.mjs': `${TEST_FILE}\n` });
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-rename-test',
      scope: 'tests/,src/',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    execFileSync('git', ['mv', 'tests/a.test.mjs', 'src/a.mjs'], { cwd: tmpDir });

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /test-weakened/);
    assert.match(r.stdout, /tests\/a\.test\.mjs/);
    assert.equal(archived('light-rename-test'), false);
  });

  it('git mv openapi.yaml spec.txt（scope 含两者）→ 红线升档', () => {
    initGitRepo();
    commitFiles({ 'openapi.yaml': 'openapi: 3.0.0\n' });
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-rename-contract',
      scope: 'openapi.yaml,spec.txt',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    execFileSync('git', ['mv', 'openapi.yaml', 'spec.txt'], { cwd: tmpDir });

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /contract-change/);
    assert.equal(archived('light-rename-contract'), false);
  });

  it('范围内普通非测试、非红线文件改名 → 正常归档（不误报）', () => {
    initGitRepo();
    commitFiles({ 'src/old.mjs': 'export const x = 1;\n' });
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-rename-plain',
      scope: 'src/',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    execFileSync('git', ['mv', 'src/old.mjs', 'src/new.mjs'], { cwd: tmpDir });

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);
    assert.ok(archived('light-rename-plain'));
  });
});

// --- D21 / F-05 · 依赖增量结构化比对 ---

describe('D21 · 依赖增量结构化比对（长依赖表末尾追加也不漏）', () => {
  it('25 项依赖末尾追加一项 → dep-change 升档', () => {
    initGitRepo();
    const deps = {};
    for (let i = 1; i <= 25; i += 1) deps[`pkg${i}`] = `^${i}.0.0`;
    commitFiles({ 'package.json': `${JSON.stringify({ name: 'demo', dependencies: deps }, null, 2)}\n` });
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-dep-append',
      scope: 'package.json',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('package.json', `${JSON.stringify({ name: 'demo', dependencies: { ...deps, 'left-pad': '^1.3.0' } }, null, 2)}\n`);

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /dep-change/);
    assert.equal(archived('light-dep-append'), false);
  });
});

// --- D20 / F-03 · 预置 full 工件不得顶替升档初稿 ---

describe('F-03 · 预置「待澄清=无」的 PROPOSAL 不得顶替升档初稿（D20）', () => {
  it('预置 PROPOSAL + 红线改动 → 升档后 change 门禁仍锁，第二次 advance 停在 change', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-f03',
      scope: 'migrations/',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    // 执行者在 light 期间预置一份「待澄清=无」的 PROPOSAL —— F-03 复现前提
    write('.gantry/specs/light-f03/PROPOSAL.md', '# PROPOSAL: 预置\n\n## 待澄清问题\n\n无\n');
    write('migrations/001.sql', 'SELECT 1;\n'); // 范围内的红线改动

    const r1 = runResult(['advance']);
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /code: light_upgraded/);
    assert.match(r1.stdout, /forbidden-artifact/);

    const specsDir = join(tmpDir, '.gantry/specs/light-f03');
    // 升档初稿落在规范名上 → change 门禁读到 1 条未勾选待澄清项，保持锁
    assert.equal(requiresApproval('change', specsDir), true, 'change 门禁必须保持锁');
    assert.ok(existsSync(join(specsDir, 'PROPOSAL.pre-light.md')), '预置 PROPOSAL 应改名保留');

    // 第二次 advance 不得推进到 requirement：STATE 停在 change，非零退出
    const r2 = runResult(['advance']);
    assert.notEqual(r2.status, 0, '有未决问题的 change 门禁应阻断推进');
    assert.equal(state().currentStage, 'change', 'STATE 应停在 change');
    assert.equal(state().pipeline, 'full');
    assert.match(r2.stderr, /unresolved question/);
  });
});

describe('D20 · 仅有预置工件（无其他改动）→ forbidden-artifact 升档', () => {
  it('change 目录出现 SPEC.md → 升档并列出该文件', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-forbid',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('.gantry/specs/light-forbid/SPEC.md', '# SPEC: 预置\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /forbidden-artifact/);
    assert.match(r.stdout, /SPEC\.md/);
    assert.equal(state().currentStage, 'change');
    assert.equal(
      requiresApproval('change', join(tmpDir, '.gantry/specs/light-forbid')),
      true,
      '升档后 change 门禁应保持锁',
    );
  });
});

describe('D20 · 无预置工件的正常收尾不受影响', () => {
  it('light change 目录只有 light.json + EXECUTION.md → 仍自动归档', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-clean',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);
    assert.ok(archived('light-clean'));
  });
});

// --- D25 / F-14 / N18 · HEAD 锚定：light 期间 commit 让守卫采集面归零 ---

describe('D25 · 出口门拒绝 head-moved（F-14 / N18）', () => {
  it('入口后 commit 全部改动（含红线 migrations/001.sql）→ head-moved 升档，不归档、CHANGELOG 不写', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-head-moved',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
    write('migrations/001.sql', 'DROP TABLE users;\n'); // 红线文件
    commitAll(); // git add -A && commit：HEAD 移动，工作区 diff 归零

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /head-moved/);
    assert.equal(archived('light-head-moved'), false, 'HEAD 漂移不得归档');
    assert.equal(changelog(), '', 'CHANGELOG 不得写入');
    assert.equal(state().currentStage, 'change');
    assert.equal(state().pipeline, 'full');
  });

  it('入口后未 commit 的金路径仍正常归档（head-moved 不误报）', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-no-commit',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);
    assert.ok(archived('light-no-commit'));
  });
});

// --- D31 / F-19 / F-2 / F-3 · refs 漂移：改动藏进 stash / 别的分支 / tag ---

describe('D31 · 出口门拒绝 refs-moved（F-19 / F-2 / F-3）', () => {
  it('(a) git stash -u 后直接 advance → refs-moved 升档，不归档', () => {
    initGitRepo();
    excludeInstallArtifacts();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-stash',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
    write('migrations/001.sql', 'DROP TABLE users;\n'); // 红线文件藏进 stash
    execFileSync('git', ['stash', '-u'], { cwd: tmpDir });
    assert.ok(
      existsSync(join(tmpDir, '.gantry/specs/light-stash/light.json')),
      '前置：框架状态不应被 stash 掉（.gantry 已在 info/exclude）',
    );

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /refs-moved/);
    assert.equal(archived('light-stash'), false, 'stash 后不得归档');
    assert.equal(changelog(), '', 'CHANGELOG 不得写入');
    assert.equal(state().currentStage, 'change');
    assert.equal(state().pipeline, 'full');
  });

  it('(b) 切到别的分支 commit 红线文件后切回 → refs-moved 升档（HEAD 未动）', () => {
    initGitRepo();
    excludeInstallArtifacts();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-branch',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
    execFileSync('git', ['checkout', '-q', '-b', 'feat'], { cwd: tmpDir });
    write('migrations/001.sql', 'DROP TABLE users;\n');
    execFileSync('git', ['add', '-A'], { cwd: tmpDir });
    execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'sneak'], { cwd: tmpDir });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: tmpDir });

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /refs-moved/);
    assert.match(r.stdout, /refs\/heads\/feat/);
    assert.equal(archived('light-branch'), false);
    assert.equal(state().currentStage, 'change');
  });

  it('(c) 打 tag → refs-moved 升档', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-tag',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
    execFileSync('git', ['tag', 't1'], { cwd: tmpDir });

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /refs-moved/);
    assert.match(r.stdout, /refs\/tags\/t1/);
    assert.equal(archived('light-tag'), false);
  });

  it('(d) stash -u 后 pop（refs 恢复原状）→ 正常归档', () => {
    initGitRepo();
    excludeInstallArtifacts();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-stash-pop',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
    execFileSync('git', ['stash', '-u'], { cwd: tmpDir });
    execFileSync('git', ['stash', 'pop'], { cwd: tmpDir });

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);
    assert.equal(archived('light-stash-pop'), true);
  });

  it('(e) refs 未变的金路径仍正常归档', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-refs-clean',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);
    assert.ok(archived('light-refs-clean'));
  });
});

// --- D32 / F-1 · 被忽略红线文件基线（取代 D26 的 mtime 判据） ---

/** 把 ignore 规则写进 `.git/info/exclude`（不入库），用于构造被忽略文件场景。 */
function addGitInfoExclude(lines) {
  const p = join(tmpDir, '.git', 'info', 'exclude');
  const cur = existsSync(p) ? readFileSync(p, 'utf-8') : '';
  writeFileSync(p, `${cur.replace(/\s*$/, '')}\n${lines.join('\n')}\n`, 'utf-8');
}

describe('D32 · 被忽略红线文件基线（F-1）', () => {
  // drop reason：本 describe 由 D26 改写而来 —— D26 用 mtime > createdAt 推断「入口后新增」，
  // `touch -t` 可回拨 mtime 让红线文件被当成「入口前既有」而放行（F-1）。D32 改为入口记录
  // {path: sha1} 基线、出口比对哈希，mtime 不再参与。原来靠 mtime 通过的两条用例按新语义重写，
  // 命中面与「不误报」两侧的断言均保留（未弱化）。

  it('(a) 入口后新增 migrations/001.sql 且 touch -t 回拨 mtime → 仍红线升档', () => {
    initGitRepo();
    addGitInfoExclude(['migrations/']);
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-f1-mtime',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('migrations/001.sql', 'DROP TABLE users;\n');
    execFileSync('touch', ['-t', '202001010000', join(tmpDir, 'migrations/001.sql')]);

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /migration-change|sql-change/);
    assert.equal(archived('light-f1-mtime'), false);
  });

  it('(b) 入口前就存在、未改动的被忽略红线文件（dist/db/schema.sql）→ 不误报，正常归档', () => {
    initGitRepo();
    addGitInfoExclude(['dist/']);
    write('dist/db/schema.sql', 'CREATE TABLE t (id int);\n'); // 入口前既有 → 进 ignoredRedLineBaseline
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-f1-baseline',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);
    assert.doesNotMatch(r.stdout, /sql-change|out-of-scope/);
    assert.ok(archived('light-f1-baseline'));
  });

  it('(c) 入口后修改该被忽略红线文件 → 哈希变化 → 红线升档', () => {
    initGitRepo();
    addGitInfoExclude(['dist/']);
    write('dist/db/schema.sql', 'CREATE TABLE t (id int);\n');
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-f1-changed',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
    write('dist/db/schema.sql', 'DROP TABLE t;\n'); // 入口后改写 → 哈希变化

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /sql-change/);
    assert.equal(archived('light-f1-changed'), false);
  });

  it('(d) 入口后新写 __pycache__/x.pyc 与 dist/a.js（被忽略、不命中红线）→ 不误报，正常归档', () => {
    initGitRepo();
    addGitInfoExclude(['__pycache__/', 'dist/']);
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-f1-nonred',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
    write('__pycache__/x.pyc', 'binary-ish\n');
    write('dist/a.js', 'console.log(1);\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);
    assert.ok(archived('light-f1-nonred'));
  });
});

describe('D26 → D32 · 被忽略路径只送红线检查（.gitignore 场景回归）', () => {
  it('.gitignore 含 migrations/，入口后新增 migrations/001.sql → 红线升档', () => {
    initGitRepo();
    commitFiles({ '.gitignore': 'migrations/\n' });
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-ignored-red',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
    write('migrations/001.sql', 'DROP TABLE users;\n'); // 被 ignore 覆盖，两条常规采集命令都看不到

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /migration-change|sql-change/);
    assert.equal(archived('light-ignored-red'), false);
  });

  // drop reason：D32 之后这条用例的通过理由变了 —— 原来是「mtime ≤ createdAt 故不算新增」，
  // 现在是「入口基线记录了它的 sha1 且未变故不算变化」。断言与场景不变（不误报、正常归档）。
  it('入口前已存在的被忽略文件 + 入口后新写的 __pycache__ / dist（均被忽略）→ 不误报，正常归档', () => {
    initGitRepo();
    commitFiles({ '.gitignore': 'migrations/\n__pycache__/\ndist/\n' });
    write('migrations/old.sql', 'SELECT 1;\n'); // 入口前就存在 → 进 ignoredRedLineBaseline
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-ignored-ok',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
    write('__pycache__/x.pyc', 'binary-ish\n');
    write('dist/a.js', 'console.log(1);\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);
    assert.ok(archived('light-ignored-ok'));
  });
});

// --- D27 / N4 · 未跟踪基线文件被删除 ---

describe('D27 · 基线存在性探测（未跟踪文件被删）', () => {
  it('入口前有 notes.txt（不在 scope），入口后删除 → out-of-scope 升档', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    write('notes.txt', 'stray pending edit\n'); // change 之前就在 → 进 baseline
    startLight({
      id: 'light-del-oos',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
    rmSync(join(tmpDir, 'notes.txt')); // 未跟踪文件被删：git 两条命令都看不到

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /out-of-scope/);
    assert.equal(archived('light-del-oos'), false);
  });

  it('入口前有 notes.txt（在 scope），入口后删除 → 正常归档', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    write('notes.txt', 'stray pending edit\n');
    startLight({
      id: 'light-del-scope',
      scope: 'src/lib/foo.mjs,notes.txt',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');
    rmSync(join(tmpDir, 'notes.txt'));

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);
    assert.ok(archived('light-del-scope'));
  });
});

// --- D30 / F-16 · forbidden-artifact 名单派生自 ARTIFACT_ALIASES ---

describe('D30 · forbidden-artifact 覆盖别名 / 小写 / symlink', () => {
  it('预置 CHANGE.md（proposal 别名）→ forbidden-artifact 升档', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-fa-change',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('.gantry/specs/light-fa-change/CHANGE.md', '# CHANGE 预置\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /forbidden-artifact/);
    assert.match(r.stdout, /CHANGE\.md/);
  });

  it('预置小写 proposal.md → forbidden-artifact 升档', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-fa-lower',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('.gantry/specs/light-fa-lower/proposal.md', '# proposal 预置\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /forbidden-artifact/);
    assert.match(r.stdout, /proposal\.md/);
  });

  it('预置 symlink PROPOSAL.md → forbidden-artifact 升档', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-fa-link',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    const changeDir = join(tmpDir, '.gantry/specs/light-fa-link');
    symlinkSync(join(changeDir, 'EXECUTION.md'), join(changeDir, 'PROPOSAL.md'));

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_upgraded/);
    assert.match(r.stdout, /forbidden-artifact/);
    assert.match(r.stdout, /PROPOSAL\.md/);
  });
});

// --- D29 / F-15 · 归档留痕 ---

describe('D29 · 自动归档写 archive-trace（F-15）', () => {
  it('归档目录 EXECUTION.md 含 light.json sha256 + headSha + ISO 时间', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    startLight({
      id: 'light-trace',
      scope: 'src/lib/foo.mjs',
      verify: 'node -e "process.exit(0)"',
      desc: '输出格式微调',
    });
    write('src/lib/foo.mjs', 'export const a = 1;\n');

    const r = runResult(['advance']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code: light_archived/);

    const exec = readFileSync(join(tmpDir, '.gantry/specs/_archive/light-trace/EXECUTION.md'), 'utf-8');
    assert.match(exec, /## archive-trace/);
    assert.match(exec, /- light\.json sha256: [0-9a-f]{64}/);
    assert.match(exec, /- headSha: [0-9a-f]{7,}/);
    assert.match(exec, /- at: \d{4}-\d{2}-\d{2}T/);
  });
});
