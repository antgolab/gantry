import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');

let tmpDir;

const run = (cmd, opts = {}) =>
  execSync(`node ${CLI} ${cmd}`, { encoding: 'utf-8', timeout: 15000, cwd: tmpDir, ...opts });

beforeEach(() => {
  tmpDir = join(import.meta.dirname, '..', '.test-tmp-revise-' + Date.now());
  mkdirSync(tmpDir, { recursive: true });
  // 初始化项目骨架
  execSync(`node ${CLI} init --tool claude`, { cwd: tmpDir, encoding: 'utf-8' });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function seedShippedChange(changeId, { withRequirement = true } = {}) {
  const specsDir = join(tmpDir, '.gantry/specs', changeId);
  mkdirSync(specsDir, { recursive: true });
  writeFileSync(join(specsDir, 'CHANGE.md'), `# CHANGE — ${changeId}\n`);
  if (withRequirement) {
    writeFileSync(join(specsDir, 'REQUIREMENT.md'), `# REQUIREMENT — ${changeId}\n\n## AC\n- AC-1: foo\n`);
  }
  writeFileSync(join(specsDir, 'DESIGN.md'), `# DESIGN — ${changeId}\n`);
  writeFileSync(join(specsDir, 'TASK.md'), `# TASK — ${changeId}\n`);
}

describe('archive', () => {
  it('archive 收尾当前活跃 change 并归档到 _archive/<id>/', () => {
    seedShippedChange('demo-feat');
    run('change "another-feat"');
    const out = run('archive --force');
    assert.ok(out.includes('变更已收尾: another-feat'));
    assert.ok(out.includes('状态已重置为 idle'));
    assert.ok(out.includes('已归档到 .gantry/specs/_archive/another-feat/'));
    assert.ok(existsSync(join(tmpDir, '.gantry/specs', '_archive', 'another-feat', 'ARCHIVE.md')));
    assert.ok(existsSync(join(tmpDir, '.gantry/specs', 'another-feat')));
  });

  it('archive 追加 ARCHIVE.md 时间戳记录', () => {
    run('change "demo-feat"');
    run('archive --force');
    const log = readFileSync(join(tmpDir, '.gantry/specs', '_archive', 'demo-feat', 'ARCHIVE.md'), 'utf-8');
    assert.ok(log.includes('archived from .gantry/specs/demo-feat/'));
  });

  it('archive --keep-history 保留旧归档加版本后缀', () => {
    run('change "demo-feat"');
    run('archive --force');
    run('unarchive demo-feat');
    run('archive --force --keep-history');
    assert.ok(existsSync(join(tmpDir, '.gantry/specs', '_archive', 'demo-feat')));
    assert.ok(existsSync(join(tmpDir, '.gantry/specs', '_archive', 'demo-feat.v2')));
  });

  it('archive 默认覆盖式归档', () => {
    run('change "demo-feat"');
    run('archive --force');
    writeFileSync(join(tmpDir, '.gantry/specs', 'demo-feat', 'NEW.md'), 'new content');
    run('unarchive demo-feat');
    run('archive --force');
    assert.ok(existsSync(join(tmpDir, '.gantry/specs', '_archive', 'demo-feat', 'NEW.md')));
  });

  it('archive 不再接收 change-id', () => {
    assert.throws(() => run('archive missing-id'));
  });

  it('archive 无活跃 change 时报错', () => {
    assert.throws(() => run('archive'), /无活跃变更可收尾/);
  });
});

describe('unarchive', () => {
  it('从 _archive 恢复并重新激活 change', () => {
    run('change "demo-feat"');
    run('archive --force');
    rmSync(join(tmpDir, '.gantry/specs', 'demo-feat'), { recursive: true });
    const out = run('unarchive demo-feat');
    assert.ok(out.includes('已恢复并重新激活'));
    assert.ok(existsSync(join(tmpDir, '.gantry/specs', 'demo-feat')));
    const state = readFileSync(join(tmpDir, '.gantry/planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('活跃 Change**: `demo-feat`'));
    assert.ok(state.includes('当前阶段**: `integration`'));
  });

  it('--from 指定历史版本', () => {
    run('change "demo-feat"');
    run('archive --force');
    run('unarchive demo-feat');
    run('archive --force --keep-history');
    rmSync(join(tmpDir, '.gantry/specs', 'demo-feat'), { recursive: true });
    run('unarchive demo-feat --from demo-feat.v2');
    assert.ok(existsSync(join(tmpDir, '.gantry/specs', 'demo-feat')));
  });

  it('已有目标目录时仍可重新激活', () => {
    run('change "demo-feat"');
    run('archive --force');
    const out = run('unarchive demo-feat');
    assert.ok(out.includes('已恢复并重新激活'));
    assert.ok(existsSync(join(tmpDir, '.gantry/specs', 'demo-feat')));
  });

  it('已有活跃 change 时拒绝恢复其他 change', () => {
    run('change "demo-feat"');
    run('archive --force');
    run('change "other"');
    assert.throws(() => run('unarchive demo-feat'), /已有活跃 change/);
  });

  it('归档不存在时报错', () => {
    assert.throws(() => run('unarchive missing-id'), /未找到归档/);
  });
});
