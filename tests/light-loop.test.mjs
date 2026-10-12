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
