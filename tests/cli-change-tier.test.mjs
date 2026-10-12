import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
const TIER_ROUTER = join(import.meta.dirname, '..', 'src', 'lib', 'tier-router.mjs');
let tmpDir;

const run = (args) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd: tmpDir, encoding: 'utf-8', timeout: 20000 });

// 需要断言非零退出 / 读取 stderr 的用例用 spawnSync 包一层
const runResult = (args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: tmpDir, encoding: 'utf-8', timeout: 20000 });

function state() {
  return readFileSync(join(tmpDir, '.gantry/planning/STATE.md'), 'utf-8');
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cli-change-tier-'));
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('change --dry-run tier 决策（AC-2：默认 full，不再软打分）', () => {
  it('空 diff 下 dry-run → pipeline full，无 score / hits 字段', () => {
    const out = run(['change', '--dry-run', 'fix: README typo']);
    const j = JSON.parse(out);
    assert.equal(j.tier, 'full');
    assert.equal(j.pipeline, 'full');
    assert.equal(j.code, 'tier_dry_run');
    assert.equal(j.score, undefined, 'dry-run 不应再有 score');
    assert.equal(j.hits, undefined, 'dry-run 不应再有 hits');
  });

  it('描述命中红线也只是 full（创建期不再升档，红线在执行期守卫）', () => {
    const out = run(['change', '--dry-run', '重构 auth 模块']);
    const j = JSON.parse(out);
    assert.equal(j.tier, 'full');
    assert.equal(j.hits, undefined);
  });

  it('--tier full 覆写 → dry-run 仍报告 full', () => {
    const out = run(['change', '--dry-run', '--tier', 'full', 'fix: README typo']);
    const j = JSON.parse(out);
    assert.equal(j.tier, 'full');
    assert.equal(j.pipeline, 'full');
  });

  it('--pipeline 作为 deprecated alias，取值同为 light|full', () => {
    const out = run(['change', '--dry-run', '--pipeline', 'full', 'fix: README typo']);
    const j = JSON.parse(out);
    assert.equal(j.tier, 'full');
  });
});

describe('AC-2 · tier-router 软打分引擎已移除', () => {
  it('src/lib/tier-router.mjs 不存在', () => {
    assert.equal(existsSync(TIER_ROUTER), false);
  });

  it('非 dry-run 的 EXECUTION.md 不含 score: / hits: / auto: 行', () => {
    run(['install', '--tool', 'claude']);
    run(['change', '--id', 'no-score', 'fix: README typo']);

    const exec = readFileSync(join(tmpDir, '.gantry/specs/no-score/EXECUTION.md'), 'utf-8');
    assert.match(exec, /## tier-decision/);
    assert.match(exec, /tier: full/);
    assert.match(exec, /source: default/);
    assert.doesNotMatch(exec, /score:/);
    assert.doesNotMatch(exec, /hits:/);
    assert.doesNotMatch(exec, /auto:/);
  });
});

describe('AC-1 · pipeline 枚举收敛为 light|full', () => {
  it('--tier micro 非零退出，且允许列表不含 micro', () => {
    const r = runResult(['change', '--tier', 'micro', 'fix: README typo']);
    assert.notEqual(r.status, 0, '应非零退出');
    const message = `${r.stdout}${r.stderr}`;
    assert.equal(/micro/i.test(message), false, `错误信息不应出现 micro: ${message}`);
    assert.match(message, /light\|full/, '错误信息应列出可选值 light|full');
  });

  it('--pipeline micro 同样被拒绝', () => {
    const r = runResult(['change', '--pipeline', 'micro', 'fix: README typo']);
    assert.notEqual(r.status, 0);
    assert.equal(/micro/i.test(`${r.stdout}${r.stderr}`), false);
  });
});

describe('change 非 dry-run 落 STATE 与 EXECUTION', () => {
  it('默认建 full@change，EXECUTION 记录 source: default，code: tier_decided', () => {
    run(['install', '--tool', 'claude']);
    const out = run(['change', '--id', 'auto-test', 'fix: README typo']);
    assert.match(out, /code: tier_decided/);
    assert.match(state(), /模式\*\*: `full`/);
    assert.match(state(), /当前阶段\*\*: `change`/);

    const exec = readFileSync(join(tmpDir, '.gantry/specs/auto-test/EXECUTION.md'), 'utf-8');
    assert.match(exec, /tier: full/);
    assert.match(exec, /source: default/);
    assert.doesNotMatch(exec, /reason:/);
  });

  it('--tier full 记录 source: override，code: tier_override_recorded', () => {
    run(['install', '--tool', 'claude']);
    const out = run(['change', '--tier', 'full', '--id', 'override-test', 'fix: README typo']);
    assert.match(out, /code: tier_override_recorded/);
    assert.match(state(), /模式\*\*: `full`/);

    const exec = readFileSync(join(tmpDir, '.gantry/specs/override-test/EXECUTION.md'), 'utf-8');
    assert.match(exec, /tier: full/);
    assert.match(exec, /source: override/);
    assert.doesNotMatch(exec, /score:/);
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
    const out = run(['knowledge', 'maintain']);
    const j = JSON.parse(out);
    assert.ok(typeof j.code === 'string', 'result 应含 code 字段');
    assert.match(j.code, /^maintenance_(promoted|archived|no_op)$/);
  });
});
