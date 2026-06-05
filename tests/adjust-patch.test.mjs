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
  tmpDir = join(import.meta.dirname, '..', '.test-tmp-adjust-' + Date.now());
  mkdirSync(tmpDir, { recursive: true });
  execSync(`node ${CLI} init --tool claude`, { cwd: tmpDir, encoding: 'utf-8' });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function seedActiveChangeAt(changeId, targetStage) {
  const specsDir = join(tmpDir, '.specs', changeId);
  mkdirSync(specsDir, { recursive: true });
  writeFileSync(join(specsDir, 'CHANGE.md'), `# CHANGE — ${changeId}\n`);
  writeFileSync(join(specsDir, 'REQUIREMENT.md'), `# REQUIREMENT — ${changeId}\n`);
  writeFileSync(join(specsDir, 'DESIGN.md'), `# DESIGN — ${changeId}\n`);
  writeFileSync(join(specsDir, 'UI-DESIGN.md'), `# UI-DESIGN — ${changeId}\n`);
  writeFileSync(join(specsDir, 'TASK.md'), `# TASK — ${changeId}\n<task id="T01" status="done"></task>\n`);
  writeFileSync(join(specsDir, 'TEST.md'), `# TEST — ${changeId}\n`);
  writeFileSync(join(specsDir, 'REVIEW.md'), `# REVIEW — ${changeId}\n`);

  run(`change "${changeId}"`);
  const path = ['change', 'requirement', 'design', 'ui-design', 'task', 'dev', 'test', 'review', 'integration'];
  while (path[path.indexOf(readStage())] !== targetStage) run('next');
}

function readStage() {
  const state = readFileSync(join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
  return state.match(/当前阶段\*\*:\s*`(.+?)`/)?.[1];
}

describe('adjust patch', () => {
  it('创建 PATCH.md，并在技术方案变化时回退到 design', () => {
    seedActiveChangeAt('demo-feat', 'test');

    const out = run('adjust "压测发现同步批量查询不可行，改异步任务"');
    assert.ok(out.includes('已创建 Patch'));
    assert.ok(out.includes('阶段回退: test → design'));

    const patch = readFileSync(join(tmpDir, '.specs', 'demo-feat', 'PATCH.md'), 'utf-8');
    assert.ok(patch.includes('- status: open'));
    assert.ok(patch.includes('压测发现同步批量查询不可行'));
    assert.ok(patch.includes('- [ ] DESIGN.md:'));
    assert.ok(patch.includes('- [ ] TASK.md:'));
    assert.ok(patch.includes('- [ ] DEV:'));
    assert.equal(readStage(), 'design');
  });

  it('已有 open patch 时追加记录并合并必须更新项', () => {
    seedActiveChangeAt('demo-feat', 'dev');

    run('adjust "实现发现漏了空状态处理"');
    run('adjust "测试发现少覆盖边界用例"');

    const patch = readFileSync(join(tmpDir, '.specs', 'demo-feat', 'PATCH.md'), 'utf-8');
    assert.equal((patch.match(/## 状态/g) || []).length, 1);
    assert.ok(patch.includes('实现发现漏了空状态处理'));
    assert.ok(patch.includes('测试发现少覆盖边界用例'));
    assert.ok(patch.includes('- [ ] TEST.md:'));
  });

  it('next 阻止当前阶段未勾选的 patch 项', () => {
    seedActiveChangeAt('demo-feat', 'dev');
    run('adjust "实现发现漏了空状态处理"');

    assert.throws(() => run('next'), /Patch 门禁未通过/);

    const patchPath = join(tmpDir, '.specs', 'demo-feat', 'PATCH.md');
    const patch = readFileSync(patchPath, 'utf-8').replace('- [ ] DEV:', '- [x] DEV:');
    writeFileSync(patchPath, patch, 'utf-8');

    const out = run('next');
    assert.ok(out.includes('阶段推进: dev → test'));
  });

  it('ship 阻止未闭环 patch，全部勾选后关闭 patch', () => {
    seedActiveChangeAt('demo-feat', 'integration');
    const patchPath = join(tmpDir, '.specs', 'demo-feat', 'PATCH.md');
    writeFileSync(patchPath, `# PATCH — demo-feat

## 状态

- status: open

## 必须更新

- [ ] TEST.md: 增加回归项

## 关闭条件

- [ ] 所有必须更新项已完成
`, 'utf-8');

    assert.throws(() => run('ship'), /Patch 尚未闭环/);

    const closedChecklist = readFileSync(patchPath, 'utf-8').replaceAll('- [ ]', '- [x]');
    writeFileSync(patchPath, closedChecklist, 'utf-8');

    run('ship');
    const patch = readFileSync(patchPath, 'utf-8');
    assert.ok(patch.includes('- status: closed'));
  });
});
