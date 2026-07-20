import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
let tmpDir;

const run = (command) => execSync(`node ${CLI} ${command}`, {
  cwd: tmpDir,
  encoding: 'utf-8',
  timeout: 15000,
});

function state() {
  return readFileSync(join(tmpDir, '.gantry/planning/STATE.md'), 'utf-8');
}

function writeArtifact(changeId, name, content) {
  writeFileSync(join(tmpDir, '.gantry/specs', changeId, name), content, 'utf-8');
}

beforeEach(() => {
  tmpDir = join(import.meta.dirname, `.tmp-pipeline-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  run('install --tool codex');
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('pipeline CLI', () => {
  it('change 默认 full，不再根据 fix/bug 自动降级', () => {
    const output = run('change --id fix-typo "fix README typo"');
    assert.match(output, /管线: full/);
    assert.match(state(), /模式\*\*: `full`/);
  });

  it('首次命令把旧 standard 配置和状态一次性迁移为 full', () => {
    const configPath = join(tmpDir, '.gantry/planning/config.json');
    const statePath = join(tmpDir, '.gantry/planning/STATE.md');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.pipeline = 'standard';
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    writeFileSync(statePath, state().replace('`full`', '`standard`'));

    assert.match(run('status'), /pipeline 迁移.*→ full/);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf-8')).pipeline, 'full');
    assert.match(state(), /模式\*\*: `full`/);
  });

  it('只有显式参数才创建 light change', () => {
    const output = run('change --pipeline light --id fix-typo "fix README typo"');
    assert.match(output, /管线: light/);
    assert.match(state(), /模式\*\*: `light`/);
  });

  it('显式 light 命中高风险时拒绝且不创建 change', () => {
    assert.throws(
      () => run('change --pipeline light --id risky "新增数据库 migration"'),
      /light 不允许高风险变更/,
    );
    assert.match(state(), /活跃 Change\*\*: `无`/);
    assert.equal(existsSync(join(tmpDir, '.gantry/specs/risky')), false);
  });

  it('pipeline full 只允许活跃 change 从 light 单向提升', () => {
    run('change --pipeline light --id fix-typo "fix README typo"');
    assert.match(run('pipeline full'), /light → full/);
    assert.match(state(), /模式\*\*: `full`/);
    assert.throws(() => run('pipeline light'), /只允许 light → full/);
  });

  it('fast 中提升 full 时回到 change 边界，不能直接进入 integration', () => {
    run('change --pipeline light --id fix-typo "fix README typo"');
    writeArtifact('fix-typo', 'PROPOSAL.md',
      '# PROPOSAL\n\n修复 README 拼写\n\n## 待澄清问题\n\n无\n');
    run('advance');
    assert.match(state(), /当前阶段\*\*: `fast`/);
    run('pipeline full');
    assert.match(state(), /当前阶段\*\*: `change`/);
    assert.match(run('advance'), /change → requirement/);
  });

  it('light 完整执行 change → fast → integration', () => {
    run('change --pipeline light --id fix-typo "fix README typo"');
    writeArtifact('fix-typo', 'PROPOSAL.md',
      '# PROPOSAL\n\n- **uiImpact**: false\n\n修复 README 拼写\n\n## 待澄清问题\n\n无\n');
    assert.match(run('advance'), /change → fast/);
    writeArtifact('fix-typo', 'EXECUTION.md', '# EXECUTION\n\nverify: PASS\n');
    assert.match(run('advance'), /fast → integration/);
  });

  it('Proposal 后发现高风险时 advance --skip 也不能绕过', () => {
    run('change --pipeline light --id risky-later "调整订单逻辑"');
    writeArtifact('risky-later', 'PROPOSAL.md',
      '# PROPOSAL\n\n新增数据库 migration\n\n## 待澄清问题\n\n无\n');
    assert.throws(() => run('advance --skip'), /light 不允许高风险变更/);
    assert.match(state(), /当前阶段\*\*: `change`/);
  });
});
