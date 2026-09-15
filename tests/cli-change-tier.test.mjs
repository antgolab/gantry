import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
let tmpDir;

const run = (args) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd: tmpDir, encoding: 'utf-8', timeout: 20000 });

function state() {
  return readFileSync(join(tmpDir, '.gantry/planning/STATE.md'), 'utf-8');
}

// 在 tmpDir 内初始化一个真实 git 仓库，提交 2 个文件后各改一笔，
// 使 git diff --name-only HEAD 返回 2 个 modifiedFiles（触发 soft:multi-file）。
function initGitRepoWithTwoModifiedFiles() {
  execFileSync('git', ['init', '-q'], { cwd: tmpDir });
  writeFileSync(join(tmpDir, 'a.txt'), 'a\n');
  writeFileSync(join(tmpDir, 'b.txt'), 'b\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: tmpDir });
  writeFileSync(join(tmpDir, 'a.txt'), 'a2\n');
  writeFileSync(join(tmpDir, 'b.txt'), 'b2\n');
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cli-change-tier-'));
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('change --dry-run tier 决策', () => {
  it('纯 README 修复 → tier: micro, hits: [], score: 0', () => {
    const out = run(['change', '--dry-run', 'fix: README typo']);
    const j = JSON.parse(out);
    assert.equal(j.tier, 'micro');
    assert.equal(j.pipeline, 'micro');
    assert.deepEqual(j.hits, []);
    assert.equal(j.score, 0);
    assert.equal(j.code, 'tier_dry_run');
  });

  it('--tier full 覆写生效，记录 auto-detected: micro', () => {
    const out = run(['change', '--dry-run', '--tier', 'full', 'fix: README typo']);
    const j = JSON.parse(out);
    assert.equal(j.tier, 'full');
    assert.equal(j.code, 'tier_dry_run');
    assert.equal(j.tierOverride, true);
    assert.match(j['tier-override'], /auto-detected: micro/);
  });

  it('描述命中硬红线 (auth) → tier: full, hits: [auth-keyword]', () => {
    const out = run(['change', '--dry-run', '重构 auth 模块']);
    const j = JSON.parse(out);
    assert.equal(j.tier, 'full');
    assert.deepEqual(j.hits, ['auth-keyword']);
    assert.equal(j.score, 0);
  });

  it('多文件改动软打分 → tier: light (soft:multi-file)', () => {
    initGitRepoWithTwoModifiedFiles();
    const out = run(['change', '--dry-run', '新增用户 dashboard']);
    const j = JSON.parse(out);
    assert.equal(j.tier, 'light');
    assert.deepEqual(j.hits, ['soft:multi-file']);
    assert.equal(j.score, 1);
  });

  it('--pipeline 作为 deprecated alias 映射到同档位', () => {
    const out = run(['change', '--dry-run', '--pipeline', 'light', 'fix: README typo']);
    const j = JSON.parse(out);
    assert.equal(j.tier, 'light');
  });
});

describe('change 非 dry-run 落 STATE 与 EXECUTION', () => {
  it('默认自动判定 micro，EXECUTION.md 写 tier-decision 段，code: tier_decided', () => {
    run(['install', '--tool', 'claude']);
    const out = run(['change', '--id', 'auto-test', 'fix: README typo']);
    assert.match(out, /code: tier_decided/);
    assert.match(state(), /模式\*\*: `micro`/);

    const exec = readFileSync(join(tmpDir, '.gantry/specs/auto-test/EXECUTION.md'), 'utf-8');
    assert.match(exec, /## tier-decision/);
    assert.match(exec, /auto: micro/);
    assert.match(exec, /hits: \[\]/);
    assert.match(exec, /score: 0/);
    assert.doesNotMatch(exec, /tier-override/);
  });

  it('--tier full 覆写生效，EXECUTION.md 记录 override 行，code: tier_override_recorded', () => {
    run(['install', '--tool', 'claude']);
    const out = run(['change', '--tier', 'full', '--id', 'override-test', 'fix: README typo']);
    assert.match(out, /code: tier_override_recorded/);
    assert.match(state(), /模式\*\*: `full`/);

    const exec = readFileSync(join(tmpDir, '.gantry/specs/override-test/EXECUTION.md'), 'utf-8');
    assert.match(exec, /auto: micro/);
    assert.match(exec, /tier-override: user requested full \(auto-detected: micro\)/);
  });
});

describe('knowledge 子命令组', () => {
  it('knowledge --help 列出 migrate / maintain 两条', () => {
    const out = run(['knowledge', '--help']);
    assert.match(out, /migrate/);
    assert.match(out, /maintain/);
  });

  it('knowledge migrate --dry-run 委托到 migrator 并返回结果', () => {
    mkdirSync(join(tmpDir, '.gantry', 'specs'), { recursive: true });
    writeFileSync(join(tmpDir, '.gantry', 'specs', 'LESSONS.md'), '# LESSONS\n\n## L-001 · [arch] test\n\nbody\n');

    const out = run(['knowledge', 'migrate', '--dry-run']);
    const j = JSON.parse(out);
    assert.equal(j.code, 'migration_completed');
    assert.ok(j.written.includes('team/L-001.md'));
  });

  it('knowledge maintain 委托到 maintainer 并返回 JSON 结果 (T13 实装后)', () => {
    // T13 完成后,maintainer.mjs 已存在;此处只断言子命令正常委托、输出可解析、含 code 字段。
    // 具体 promoted/archived 语义由 tests/knowledge-maintain.test.mjs 覆盖。
    const out = run(['knowledge', 'maintain']);
    const j = JSON.parse(out);
    assert.ok(typeof j.code === 'string', 'result 应含 code 字段');
    assert.match(j.code, /^maintenance_(promoted|archived|no_op)$/);
  });
});
