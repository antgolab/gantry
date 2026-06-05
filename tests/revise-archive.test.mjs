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
  const specsDir = join(tmpDir, '.specs', changeId);
  mkdirSync(specsDir, { recursive: true });
  writeFileSync(join(specsDir, 'CHANGE.md'), `# CHANGE — ${changeId}\n`);
  if (withRequirement) {
    writeFileSync(join(specsDir, 'REQUIREMENT.md'), `# REQUIREMENT — ${changeId}\n\n## AC\n- AC-1: foo\n`);
  }
  writeFileSync(join(specsDir, 'DESIGN.md'), `# DESIGN — ${changeId}\n`);
  writeFileSync(join(specsDir, 'TASK.md'), `# TASK — ${changeId}\n`);
}

describe('archive', () => {
  it('归档 change 到 _archive/<id>/', () => {
    seedShippedChange('demo-feat');
    const out = run('archive demo-feat');
    assert.ok(out.includes('已归档'));
    assert.ok(existsSync(join(tmpDir, '.specs', '_archive', 'demo-feat', 'REQUIREMENT.md')));
    // 源目录保留
    assert.ok(existsSync(join(tmpDir, '.specs', 'demo-feat', 'REQUIREMENT.md')));
  });

  it('追加 ARCHIVE.md 时间戳记录', () => {
    seedShippedChange('demo-feat');
    run('archive demo-feat');
    const log = readFileSync(join(tmpDir, '.specs', '_archive', 'demo-feat', 'ARCHIVE.md'), 'utf-8');
    assert.ok(log.includes('archived from .specs/demo-feat/'));
  });

  it('--keep-history 保留旧归档加版本后缀', () => {
    seedShippedChange('demo-feat');
    run('archive demo-feat');
    run('archive demo-feat --keep-history');
    assert.ok(existsSync(join(tmpDir, '.specs', '_archive', 'demo-feat')));
    assert.ok(existsSync(join(tmpDir, '.specs', '_archive', 'demo-feat.v2')));
  });

  it('默认覆盖式归档', () => {
    seedShippedChange('demo-feat');
    run('archive demo-feat');
    // 改动源后再归档
    writeFileSync(join(tmpDir, '.specs', 'demo-feat', 'NEW.md'), 'new content');
    run('archive demo-feat');
    assert.ok(existsSync(join(tmpDir, '.specs', '_archive', 'demo-feat', 'NEW.md')));
  });

  it('未找到 change 报错', () => {
    assert.throws(() => run('archive missing-id'), /未找到 change/);
  });

  it('参数缺失报错', () => {
    assert.throws(() => run('archive'), /用法/);
  });
});

describe('unarchive', () => {
  it('从 _archive 恢复 change 目录', () => {
    seedShippedChange('demo-feat');
    run('archive demo-feat');
    rmSync(join(tmpDir, '.specs', 'demo-feat'), { recursive: true });
    const out = run('unarchive demo-feat');
    assert.ok(out.includes('已恢复'));
    assert.ok(existsSync(join(tmpDir, '.specs', 'demo-feat', 'REQUIREMENT.md')));
  });

  it('--from 指定历史版本', () => {
    seedShippedChange('demo-feat');
    run('archive demo-feat');
    run('archive demo-feat --keep-history');
    rmSync(join(tmpDir, '.specs', 'demo-feat'), { recursive: true });
    run('unarchive demo-feat --from demo-feat.v2');
    assert.ok(existsSync(join(tmpDir, '.specs', 'demo-feat')));
  });

  it('目标目录已存在时拒绝覆盖', () => {
    seedShippedChange('demo-feat');
    run('archive demo-feat');
    assert.throws(() => run('unarchive demo-feat'), /目标已存在/);
  });

  it('归档不存在时报错', () => {
    assert.throws(() => run('unarchive missing-id'), /未找到归档/);
  });
});

describe('revise', () => {
  it('省略 change-id 时兼容转为当前活跃 change 的 PATCH.md', () => {
    seedShippedChange('demo-feat');
    run('change "demo-feat"');
    const out = run('revise "用户反馈"');
    assert.ok(out.includes('兼容转为 adjust'));
    assert.ok(out.includes('已创建 Patch'));
    const patch = readFileSync(join(tmpDir, '.specs', 'demo-feat', 'PATCH.md'), 'utf-8');
    assert.ok(patch.includes('用户反馈'));
  });

  it('显式当前 active change 时兼容转为 PATCH.md', () => {
    seedShippedChange('demo-feat');
    run('change "demo-feat"');
    const out = run('revise demo-feat "在位修订"');
    assert.ok(out.includes('兼容转为 adjust'));
    const patch = readFileSync(join(tmpDir, '.specs', 'demo-feat', 'PATCH.md'), 'utf-8');
    assert.ok(patch.includes('在位修订'));
    const state = readFileSync(join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!state.includes('修订父 Change'));
  });

  it('非 ship 状态的 revise 走 patch 回退逻辑', () => {
    seedShippedChange('demo-feat');
    run('change "demo-feat"');
    run('next'); // change -> requirement
    run('next'); // requirement -> design
    run('next'); // design -> ui-design
    run('next'); // ui-design -> task
    run('next'); // task -> dev
    run('next'); // dev -> test

    const out = run('revise demo-feat "测试发现需求漂移"');
    assert.ok(out.includes('兼容转为 adjust'));
    assert.ok(out.includes('阶段回退: test → requirement'));

    const state = readFileSync(join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('当前阶段**: `requirement`'));
    assert.ok(!state.includes('修订父 Change'));
  });

  it('历史 change 或非 active change 不再通过 revise 修订', () => {
    seedShippedChange('demo-feat');
    assert.throws(() => run('revise demo-feat "x"'), /当前无活跃 change/);

    run('change "another"');
    assert.throws(() => run('revise demo-feat "x"'), /只支持当前活跃 change/);
  });

  it('省略 change-id 且无活跃 change 时报用法错', () => {
    assert.throws(() => run('revise "原因"'), /当前无活跃 change/);
  });
});

describe('ship 归档', () => {
  it('ship 默认归档并保留 .specs/<id>/ 目录', () => {
    seedShippedChange('demo-feat');
    run('change "another-feat"');
    const out = run('ship --force');
    // 之前的 demo-feat 工件不动
    assert.ok(existsSync(join(tmpDir, '.specs', 'demo-feat')));
    // 当前收尾的 change 默认写入 _archive
    assert.ok(out.includes('已归档到 .specs/_archive/another-feat/'));
    assert.ok(existsSync(join(tmpDir, '.specs', 'another-feat')));
    assert.ok(existsSync(join(tmpDir, '.specs', '_archive', 'another-feat')));
    assert.ok(existsSync(join(tmpDir, '.specs', '_archive', 'another-feat', 'ARCHIVE.md')));
  });

  it('ship --no-archive 只收尾不归档', () => {
    run('change "another-feat"');
    const out = run('ship --force --no-archive');
    assert.ok(out.includes('已跳过归档'));
    assert.ok(existsSync(join(tmpDir, '.specs', 'another-feat')));
    assert.equal(existsSync(join(tmpDir, '.specs', '_archive', 'another-feat')), false);
  });

  it('ship 后 STATE 重置为 idle 且不再写修订字段', () => {
    seedShippedChange('demo-feat');
    run('change "demo-feat"');
    run('revise demo-feat "x"');
    run('ship --force');
    const state = readFileSync(join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(/当前阶段.*idle/.test(state));
    assert.ok(!state.includes('修订父 Change'));
  });
});
