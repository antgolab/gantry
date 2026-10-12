import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGate } from '../src/lib/phases.mjs';
import { readState } from '../src/lib/state.mjs';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
let tmpDir;

const run = (args) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd: tmpDir, encoding: 'utf-8', timeout: 20000 });

const runResult = (args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: tmpDir, encoding: 'utf-8', timeout: 20000 });

function state() {
  return readFileSync(join(tmpDir, '.gantry/planning/STATE.md'), 'utf-8');
}

function execFile(changeId) {
  return readFileSync(join(tmpDir, '.gantry/specs', changeId, 'EXECUTION.md'), 'utf-8');
}

function lightJson(changeId) {
  return readFileSync(join(tmpDir, '.gantry/specs', changeId, 'light.json'), 'utf-8');
}

function initGitRepo() {
  execFileSync('git', ['init', '-q'], { cwd: tmpDir });
  writeFileSync(join(tmpDir, 'README.md'), '# base\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: tmpDir });
}

const sha1 = (text) => createHash('sha1').update(text).digest('hex');

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'light-entry-'));
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('AC-3 · 一句话启动 light', () => {
  it('合法 scope 建 light.json + 意图头视图，STATE=light@fast，全程无确认', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);

    // 一个「已存在的零散改动」（untracked），应进入 baseline 并记录正确 sha1
    const strayContent = 'stray pending edit\n';
    writeFileSync(join(tmpDir, 'notes.txt'), strayContent);

    const out = run([
      'change', '--tier', 'light',
      '--scope', 'src/lib/foo.mjs',
      '--accept', '日志行数不变; 不破坏既有测试',
      '--verify', 'npm test',
      '--id', 'light-1',
      '调整 foo 模块的日志输出',
    ]);

    assert.match(out, /管线: light/);
    assert.match(out, /code: light_entered/);
    assert.doesNotMatch(out, /确认|approval|是否继续/i, 'light 入口不得出现确认提示');

    // light.json：意图固化
    const lj = JSON.parse(lightJson('light-1'));
    assert.equal(lj.intent.goal, '调整 foo 模块的日志输出');
    assert.deepEqual(lj.intent.accept, ['日志行数不变', '不破坏既有测试']);
    assert.deepEqual(lj.intent.scope, ['src/lib/foo.mjs']);
    assert.equal(lj.intent.verify, 'npm test');
    assert.match(lj.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    // baseline：含零散改动 + 正确 sha1；排除 .gantry/
    assert.equal(lj.baseline['notes.txt'], sha1(strayContent));
    assert.deepEqual(
      Object.keys(lj.baseline).filter((p) => p.startsWith('.gantry/') || p === '.gantry'),
      [],
      '.gantry/ 下的文件不应进入 baseline',
    );

    // EXECUTION 顶部意图头：3~5 行
    const exec = execFile('light-1');
    const intentBlock = exec.split('## tier-decision')[0];
    assert.match(intentBlock, /## light-intent/);
    assert.match(intentBlock, /- 目标: 调整 foo 模块的日志输出/);
    assert.match(intentBlock, /- 验收线: 日志行数不变; 不破坏既有测试/);
    assert.match(intentBlock, /- 允许改动范围: src\/lib\/foo\.mjs/);
    const bodyLines = intentBlock.split('\n').filter((l) => l.trim().startsWith('- '));
    assert.ok(bodyLines.length >= 3 && bodyLines.length <= 4, `意图头行数应在 3~5 之间，实际 ${bodyLines.length}`);

    // 无 PROPOSAL.md
    assert.equal(existsSync(join(tmpDir, '.gantry/specs/light-1/PROPOSAL.md')), false);

    // STATE
    assert.match(state(), /模式\*\*: `light`/);
    assert.match(state(), /当前阶段\*\*: `fast`/);

    // 出口门（fast）接受该 change
    const specsDir = join(tmpDir, '.gantry/specs/light-1');
    const gate = checkGate('fast', specsDir, {}, readState(tmpDir), tmpDir);
    assert.equal(gate.passed, true, `fast 门禁应放行: ${gate.reason}`);

    // readState 不把新 light 归一化为 full
    assert.equal(readState(tmpDir).pipeline, 'light');
    assert.equal(readState(tmpDir).currentStage, 'fast');
  });

  it('未给 --accept 时验收线回落为描述', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    run(['change', '--tier', 'light', '--scope', 'src/a.mjs', '--id', 'light-default-accept', '调整 a 模块']);

    const lj = JSON.parse(lightJson('light-default-accept'));
    assert.deepEqual(lj.intent.accept, ['调整 a 模块']);
    assert.equal(lj.intent.verify, undefined);
    // 无 verify 时意图头只有 3 行
    const bodyLines = execFile('light-default-accept')
      .split('## tier-decision')[0]
      .split('\n')
      .filter((l) => l.trim().startsWith('- '));
    assert.equal(bodyLines.length, 3);
  });
});

describe('AC-4 · 创建期红线预检命中直接走 full', () => {
  it('「新增数据库迁移」→ full@change，EXECUTION 记录 rule id，无 light.json', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);

    const out = run(['change', '--tier', 'light', '--scope', 'src/a.mjs', '--id', 'risky', '新增数据库迁移']);
    assert.match(out, /管线: full/);
    assert.match(out, /light 入口被拒绝/);
    assert.match(state(), /模式\*\*: `full`/);
    assert.match(state(), /当前阶段\*\*: `change`/);

    const exec = execFile('risky');
    assert.match(exec, /tier: full/);
    assert.match(exec, /source: light-fallback/);
    assert.match(exec, /reason: .*migration-change/);
    assert.equal(existsSync(join(tmpDir, '.gantry/specs/risky/light.json')), false);
  });
});

describe('AC-5 · 意图范围非法在入口即回落 full', () => {
  it('缺 --scope → reason: intent-scope-invalid', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);

    run(['change', '--tier', 'light', '--id', 'no-scope', '调整 b 模块']);
    const exec = execFile('no-scope');
    assert.match(exec, /tier: full/);
    assert.match(exec, /source: light-fallback/);
    assert.match(exec, /reason: intent-scope-invalid/);
    assert.equal(existsSync(join(tmpDir, '.gantry/specs/no-scope/light.json')), false);
    assert.match(state(), /当前阶段\*\*: `change`/);
  });

  it('--scope 含 ** → reason: intent-scope-invalid', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);

    run(['change', '--tier', 'light', '--scope', 'src/**', '--id', 'glob-scope', '调整 b 模块']);
    const exec = execFile('glob-scope');
    assert.match(exec, /source: light-fallback/);
    assert.match(exec, /reason: intent-scope-invalid/);
    assert.equal(existsSync(join(tmpDir, '.gantry/specs/glob-scope/light.json')), false);
  });
});

describe('D15 · 非 git 项目 light 入口回落 full', () => {
  it('非 git 目录 → full@change，reason: non-git', () => {
    run(['install', '--tool', 'claude']);

    const out = run(['change', '--tier', 'light', '--scope', 'src/a.mjs', '--id', 'non-git', '调整 c 模块']);
    assert.match(out, /管线: full/);
    assert.match(out, /light 入口被拒绝/);

    const exec = execFile('non-git');
    assert.match(exec, /tier: full/);
    assert.match(exec, /source: light-fallback/);
    assert.match(exec, /reason: non-git/);
    assert.equal(existsSync(join(tmpDir, '.gantry/specs/non-git/light.json')), false);
    assert.match(state(), /模式\*\*: `full`/);
    assert.match(state(), /当前阶段\*\*: `change`/);
  });

  it('非 git 目录下 --dry-run 报告回落原因且不写文件', () => {
    const r = runResult(['change', '--dry-run', '--tier', 'light', '--scope', 'src/a.mjs', '调整 c 模块']);
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.tier, 'full');
    assert.equal(j.pipeline, 'full');
    assert.equal(j.reason, 'non-git');
    assert.equal(existsSync(join(tmpDir, '.gantry/specs')), false, 'dry-run 不建目录');
  });
});

describe('light 入口描述解析：flag 值不进入描述', () => {
  it('--scope / --accept / --verify 的值被 stripFlags 剥离', () => {
    initGitRepo();
    run(['install', '--tool', 'claude']);
    run([
      'change', '--tier', 'light',
      '--scope', 'src/x.mjs', '--accept', 'A;B', '--verify', 'npm run verify',
      '--id', 'strip', '描述应为这一句',
    ]);
    const lj = JSON.parse(lightJson('strip'));
    assert.equal(lj.intent.goal, '描述应为这一句');
    assert.doesNotMatch(lj.intent.goal, /--scope|--accept|--verify|src\/x\.mjs/);
  });
});
