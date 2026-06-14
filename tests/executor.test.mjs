import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectModel, escalateModel, resolveModelId } from '../src/lib/model-router.mjs';
import { buildPromptPackage, assembleWave, assembleAllWaves } from '../src/lib/executor.mjs';
import { scheduleWaves } from '../src/lib/tasks.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(import.meta.dirname, '.tmp-executor-test');

function setup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  mkdirSync(TMP, { recursive: true });
}

function teardown() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
}

// --- model-router tests ---

describe('model-router', () => {
  it('selects deep for architecture tasks', () => {
    const task = { id: 'T01', title: 'Design new architecture', writeFiles: [] };
    const { tier } = selectModel(task, { stage: 'design' });
    assert.equal(tier, 'deep');
  });

  it('selects fast for simple tasks', () => {
    const task = { id: 'T02', title: 'Fix typo in readme', writeFiles: ['README.md'] };
    const { tier } = selectModel(task, { stage: 'dev' });
    assert.equal(tier, 'fast');
  });

  it('selects standard for normal implementation', () => {
    const task = { id: 'T03', title: 'Add user login form', writeFiles: ['src/login.mjs', 'src/login.test.mjs'] };
    const { tier } = selectModel(task, { stage: 'dev' });
    assert.equal(tier, 'standard');
  });

  it('auto-escalates after 2 retries', () => {
    const task = { id: 'T04', title: 'Simple fix', writeFiles: ['src/a.mjs'] };
    const { tier } = selectModel(task, { stage: 'dev', retryCount: 2 });
    assert.equal(tier, 'deep');
  });

  it('selects deep for many write_files', () => {
    const task = { id: 'T05', title: 'Refactor module', writeFiles: Array(10).fill('src/x.mjs') };
    const { tier } = selectModel(task, { stage: 'dev' });
    assert.equal(tier, 'deep');
  });

  it('escalateModel upgrades fast → standard', () => {
    assert.equal(escalateModel('fast', 1), 'standard');
  });

  it('escalateModel upgrades standard → deep at retry 2', () => {
    assert.equal(escalateModel('standard', 2), 'deep');
  });

  it('escalateModel keeps deep as deep', () => {
    assert.equal(escalateModel('deep', 3), 'deep');
  });

  it('resolveModelId maps tiers to claude-code models', () => {
    assert.equal(resolveModelId('fast', 'claude-code'), 'haiku');
    assert.equal(resolveModelId('standard', 'claude-code'), 'sonnet');
    assert.equal(resolveModelId('deep', 'claude-code'), 'opus');
  });

  it('resolveModelId maps tiers to codex models', () => {
    assert.equal(resolveModelId('fast', 'codex'), 'gpt-4o-mini');
    assert.equal(resolveModelId('deep', 'codex'), 'o3');
  });
});

// --- executor tests ---

describe('executor', () => {
  it('buildPromptPackage produces complete package', () => {
    setup();
    const specsDir = TMP;
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T01" status="pending">
Implement feature
write_files: [src/feat.mjs]
read_files: []
</task>
`);
    const task = { id: 'T01', title: 'Implement feature', writeFiles: ['src/feat.mjs'], readFiles: [], body: 'Implement feature' };
    const pkg = buildPromptPackage(task, { specsDir, projectRoot: TMP, stage: 'dev', pipeline: 'standard' });

    assert.equal(pkg.taskId, 'T01');
    assert.ok(['fast', 'standard', 'deep'].includes(pkg.model));
    assert.ok(pkg.metadata.stage === 'dev');
    assert.deepEqual(pkg.metadata.writeFiles, ['src/feat.mjs']);
    assert.ok(typeof pkg.modelReason === 'string');
    assert.equal(pkg.executionPlan.runtime, 'subagent');
    assert.equal(pkg.executionPlan.isolation, 'shared-worktree');
    teardown();
  });

  it('assembleWave produces packages for all tasks in wave', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T01" status="pending">
Task A
write_files: [src/a.mjs]
</task>
<task id="T02" status="pending">
Task B
write_files: [src/b.mjs]
</task>
`);
    const wave = [
      { id: 'T01', title: 'Task A', writeFiles: ['src/a.mjs'], readFiles: [], body: 'Task A' },
      { id: 'T02', title: 'Task B', writeFiles: ['src/b.mjs'], readFiles: [], body: 'Task B' },
    ];
    const packages = assembleWave(wave, { specsDir: TMP, projectRoot: TMP, stage: 'dev' });
    assert.equal(packages.length, 2);
    assert.equal(packages[0].taskId, 'T01');
    assert.equal(packages[1].taskId, 'T02');
    teardown();
  });

  it('assembleAllWaves groups tasks into waves with prompt packages', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T01" status="done">
Done task
write_files: [src/done.mjs]
</task>
<task id="T02" status="pending" depends="T01">
Pending task
write_files: [src/pending.mjs]
</task>
`);
    const result = assembleAllWaves(TMP, { projectRoot: TMP, stage: 'dev' });
    assert.equal(result.progress.total, 2);
    assert.equal(result.progress.done, 1);
    assert.ok(result.waves.length >= 1);
    assert.equal(result.waves[0][0].taskId, 'T02');
    teardown();
  });

  it('scheduleWaves auto-repairs unique dependency id typos in memory', () => {
    const tasks = [
      { id: 'T01', status: 'done', parallel: true, depends: [], writeFiles: ['src/base.mjs'], readFiles: [], estimate: 1, risk: 'medium' },
      { id: 'T02', status: 'pending', parallel: true, depends: ['t001'], writeFiles: ['src/a.mjs'], readFiles: [], estimate: 1, risk: 'medium' },
    ];
    const plan = scheduleWaves(tasks);
    assert.equal(plan.waves[0][0].id, 'T02');
    assert.ok(plan.repairs.some(r => r.action === 'replace-dependency' && r.from === 't001' && r.to === 'T01'));
    assert.deepEqual(tasks[1].depends, ['t001']);
  });

  it('scheduleWaves rejects unrecoverable missing dependencies with diagnostics', () => {
    const tasks = [
      { id: 'T01', status: 'pending', parallel: true, depends: ['T99'], writeFiles: ['src/a.mjs'], readFiles: [], estimate: 1, risk: 'medium' },
    ];
    assert.throws(() => scheduleWaves(tasks), /Invalid task dependencies/);
  });

  it('scheduleWaves auto-removes self and duplicate dependencies in memory', () => {
    const tasks = [
      { id: 'T01', status: 'done', parallel: true, depends: [], writeFiles: ['src/base.mjs'], readFiles: [], estimate: 1, risk: 'medium' },
      { id: 'T02', status: 'pending', parallel: true, depends: ['T02', 'T01', 'T01'], writeFiles: ['src/a.mjs'], readFiles: [], estimate: 1, risk: 'medium' },
    ];
    const plan = scheduleWaves(tasks);
    assert.equal(plan.waves.length, 1);
    assert.equal(plan.waves[0][0].id, 'T02');
    assert.ok(plan.repairs.some(r => r.action === 'remove-dependency' && r.taskId === 'T02' && r.dependency === 'T02'));
    assert.ok(plan.repairs.some(r => r.action === 'remove-duplicate-dependency' && r.dependency === 'T01'));
    assert.deepEqual(tasks[1].depends, ['T02', 'T01', 'T01']);
  });

  it('scheduleWaves auto-breaks a cycle only when there is one weak edge', () => {
    const tasks = [
      { id: 'T01', title: 'unrelated wrapper', body: 'unrelated wrapper', status: 'pending', parallel: true, depends: ['T03'], writeFiles: ['src/a.mjs'], readFiles: [], estimate: 1, risk: 'medium' },
      { id: 'T02', title: 'consume a', body: 'consume a', status: 'pending', parallel: true, depends: ['T01'], writeFiles: ['src/b.mjs'], readFiles: ['src/a.mjs'], estimate: 1, risk: 'medium' },
      { id: 'T03', title: 'consume b', body: 'consume b', status: 'pending', parallel: true, depends: ['T02'], writeFiles: ['src/c.mjs'], readFiles: ['src/b.mjs'], estimate: 1, risk: 'medium' },
    ];
    const plan = scheduleWaves(tasks);
    assert.equal(plan.waves.length, 3);
    assert.equal(plan.waves[0][0].id, 'T01');
    assert.ok(plan.repairs.some(r => r.action === 'remove-dependency' && r.taskId === 'T01' && r.dependency === 'T03'));
  });

  it('scheduleWaves respects maxParallelism and keeps waves bounded', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({
      id: `T0${i + 1}`,
      status: 'pending',
      parallel: true,
      depends: [],
      writeFiles: [`src/${i}.mjs`],
      readFiles: [],
      estimate: 1,
      risk: 'low',
    }));
    const plan = scheduleWaves(tasks, { maxParallelism: 3 });
    assert.equal(plan.waves.length, 3);
    assert.equal(plan.waves[0].length, 3);
    assert.equal(plan.waves[1].length, 3);
    assert.equal(plan.waves[2].length, 1);
  });

  it('scheduleWaves keeps read/write risk in diagnostics without forcing extra waves', () => {
    const tasks = [
      { id: 'T01', status: 'pending', parallel: true, depends: [], writeFiles: ['src/shared.mjs'], readFiles: [], estimate: 1, risk: 'medium' },
      { id: 'T02', status: 'pending', parallel: true, depends: [], writeFiles: ['src/other.mjs'], readFiles: ['src/shared.mjs'], estimate: 1, risk: 'medium' },
    ];
    const plan = scheduleWaves(tasks, { maxParallelism: 4 });
    assert.equal(plan.waves.length, 1);
    assert.equal(plan.waves[0].length, 2);
    assert.ok(plan.diagnostics.some(d => d.type === 'read-write-risk'));
  });

  it('buildPromptPackage reads task files for context isolation', () => {
    setup();
    mkdirSync(join(TMP, 'src'), { recursive: true });
    writeFileSync(join(TMP, 'src', 'existing.mjs'), 'export const x = 42;');
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T01" status="pending">
Use existing module
read_files: [src/existing.mjs]
write_files: [src/new.mjs]
</task>
`);
    const task = { id: 'T01', title: 'Use existing module', writeFiles: ['src/new.mjs'], readFiles: ['src/existing.mjs'], body: '' };
    const pkg = buildPromptPackage(task, { specsDir: TMP, projectRoot: TMP, stage: 'dev' });
    assert.equal(pkg.taskFiles.length, 1);
    assert.equal(pkg.taskFiles[0].path, 'src/existing.mjs');
    assert.ok(pkg.taskFiles[0].content.includes('export const x = 42'));
    teardown();
  });

  it('model metadata is included in prompt package', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T01" status="pending">
Security audit of auth module
write_files: [src/auth.mjs]
</task>
`);
    const task = { id: 'T01', title: 'Security audit of auth module', writeFiles: ['src/auth.mjs'], readFiles: [], body: 'Security audit of auth module' };
    const pkg = buildPromptPackage(task, { specsDir: TMP, projectRoot: TMP, stage: 'dev' });
    assert.equal(pkg.model, 'deep');
    assert.equal(pkg.agentName, 'reviewer');
    assert.equal(pkg.executionPlan.specialization, 'security-review');
    assert.equal(pkg.executionPlan.runtime, 'subagent');
    assert.deepEqual(pkg.executionPlan.workflow, ['reviewer']);
    teardown();
  });

  it('buildPromptPackage routes docs tasks to low-cost researcher documentation subagent', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T01" status="pending">
Update README docs
write_files: [README.md]
</task>
`);
    const task = { id: 'T01', title: 'Update README docs', writeFiles: ['README.md'], readFiles: [], body: 'Update README docs', risk: 'low' };
    const pkg = buildPromptPackage(task, { specsDir: TMP, projectRoot: TMP, stage: 'dev' });
    assert.equal(pkg.agentName, 'researcher');
    assert.equal(pkg.executionPlan.requestedAgent, 'writer');
    assert.equal(pkg.executionPlan.specialization, 'documentation');
    assert.equal(pkg.model, 'fast');
    assert.equal(pkg.executionPlan.runtime, 'subagent');
    assert.deepEqual(pkg.executionPlan.workflow, ['researcher']);
    teardown();
  });

  it('assembleAllWaves marks repaired tasks for deep workflow execution', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T01" status="done">
Base task
write_files: [src/base.mjs]
</task>
<task id="T02" status="pending" depends="t001">
Use repaired dependency
write_files: [src/use-base.mjs]
</task>
`);
    const result = assembleAllWaves(TMP, { projectRoot: TMP, stage: 'dev' });
    const pkg = result.waves[0][0];
    assert.ok(result.repairs.some(r => r.taskId === 'T02'));
    assert.equal(pkg.model, 'deep');
    assert.equal(pkg.executionPlan.runtime, 'workflow');
    assert.ok(pkg.executionPlan.reasons.some(r => r.includes('auto-repair')));
    teardown();
  });

  it('buildPromptPackage constrains test-engineer to reviewer test specialization', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T01" status="pending">
Review coverage for auth flow
write_files: [src/auth.test.mjs]
</task>
`);
    const task = { id: 'T01', title: 'Review coverage for auth flow', writeFiles: ['src/auth.test.mjs'], readFiles: ['src/auth.mjs'], body: 'Review coverage for auth flow', risk: 'medium' };
    const pkg = buildPromptPackage(task, { specsDir: TMP, projectRoot: TMP, stage: 'dev' });
    assert.equal(pkg.executionPlan.requestedAgent, 'test-engineer');
    assert.equal(pkg.agentName, 'reviewer');
    assert.equal(pkg.executionPlan.specialization, 'test');
    assert.equal(pkg.executionPlan.runtime, 'subagent');
    teardown();
  });

  it('buildPromptPackage keeps executor security workflow within supported agents', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T01" status="pending">
Implement auth hardening
write_files: [src/auth.mjs, src/auth.test.mjs]
</task>
`);
    const task = { id: 'T01', title: 'Implement auth hardening', writeFiles: ['src/auth.mjs', 'src/auth.test.mjs'], readFiles: [], body: 'Implement auth hardening', risk: 'high' };
    const pkg = buildPromptPackage(task, { specsDir: TMP, projectRoot: TMP, stage: 'dev' });
    assert.equal(pkg.agentName, 'executor');
    assert.equal(pkg.executionPlan.specialization, 'security');
    assert.equal(pkg.executionPlan.runtime, 'workflow');
    assert.deepEqual(pkg.executionPlan.workflow, ['executor', 'reviewer']);
    assert.equal(pkg.model, 'deep');
    teardown();
  });
});
