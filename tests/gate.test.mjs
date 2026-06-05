import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidence, detectSpeculative } from '../src/lib/verify-evidence.mjs';
import { checkScope, detectConflicts } from '../src/lib/scope-guard.mjs';
import { queryBeforeWork, recordFailure, recordBypass } from '../src/lib/failure-memory.mjs';
import { runGate, writeGateResult } from '../src/lib/gate.mjs';
import { writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TMP = join(import.meta.dirname, '.tmp-test');

function setup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  mkdirSync(TMP, { recursive: true });
}

function teardown() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
}

// --- verify-evidence tests ---

describe('verify-evidence', () => {
  it('detects English speculative language', () => {
    const matches = detectSpeculative('This should pass without issues');
    assert.ok(matches.length > 0);
    assert.ok(matches[0].includes('should pass'));
  });

  it('detects Chinese speculative language', () => {
    const matches = detectSpeculative('这个修改应该可以正常工作');
    assert.ok(matches.length > 0);
  });

  it('returns empty for concrete evidence', () => {
    const matches = detectSpeculative('$ npm test\n5 passing\nexit code: 0');
    assert.equal(matches.length, 0);
  });

  it('checkEvidence passes with valid evidence', () => {
    setup();
    const specsDir = join(TMP, 'specs');
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, 'T01-SUMMARY.md'), '$ npm test\n12 passing\nexit code: 0');
    const task = { id: 'T01', verify: null, body: '' };
    const result = checkEvidence(task, specsDir);
    assert.equal(result.passed, true);
    teardown();
  });

  it('checkEvidence fails with speculative language', () => {
    setup();
    const specsDir = join(TMP, 'specs');
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, 'T01-SUMMARY.md'), 'This should pass. Looks good to me.');
    const task = { id: 'T01', verify: null, body: '' };
    const result = checkEvidence(task, specsDir);
    assert.equal(result.passed, false);
    assert.ok(result.issues.some(i => i.includes('Speculative')));
    teardown();
  });

  it('checkEvidence fails with no artifacts', () => {
    const task = { id: 'T99', verify: null, body: '' };
    const result = checkEvidence(task, '/nonexistent');
    assert.equal(result.passed, false);
    assert.ok(result.issues[0].includes('No verification artifacts'));
  });
});

// --- scope-guard tests ---

describe('scope-guard', () => {
  it('passes when all files within boundary', () => {
    const task = { writeFiles: ['src/lib/gate.mjs', 'src/lib/utils.mjs'] };
    const result = checkScope(task, ['src/lib/gate.mjs']);
    assert.equal(result.passed, true);
    assert.equal(result.violations.length, 0);
  });

  it('fails when file outside boundary', () => {
    const task = { writeFiles: ['src/lib/gate.mjs'] };
    const result = checkScope(task, ['src/lib/gate.mjs', 'package.json']);
    assert.equal(result.passed, false);
    assert.deepEqual(result.violations, ['package.json']);
  });

  it('supports glob patterns', () => {
    const task = { writeFiles: ['src/lib/*'] };
    const result = checkScope(task, ['src/lib/gate.mjs', 'src/lib/utils.mjs']);
    assert.equal(result.passed, true);
  });

  it('supports ** glob patterns', () => {
    const task = { writeFiles: ['src/**'] };
    const result = checkScope(task, ['src/lib/deep/file.mjs']);
    assert.equal(result.passed, true);
  });

  it('detects conflicts between tasks', () => {
    const tasks = [
      { id: 'T01', writeFiles: ['src/a.mjs', 'src/b.mjs'] },
      { id: 'T02', writeFiles: ['src/b.mjs', 'src/c.mjs'] },
      { id: 'T03', writeFiles: ['src/d.mjs'] },
    ];
    const { conflicts, forced } = detectConflicts(tasks);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].taskA, 'T01');
    assert.equal(conflicts[0].taskB, 'T02');
    assert.ok(conflicts[0].files.includes('src/b.mjs'));
    assert.ok(forced.includes('T02'));
    assert.ok(!forced.includes('T03'));
  });

  it('no conflicts when files are disjoint', () => {
    const tasks = [
      { id: 'T01', writeFiles: ['src/a.mjs'] },
      { id: 'T02', writeFiles: ['src/b.mjs'] },
    ];
    const { conflicts, forced } = detectConflicts(tasks);
    assert.equal(conflicts.length, 0);
    assert.equal(forced.length, 0);
  });
});

// --- failure-memory tests ---

describe('failure-memory', () => {
  it('queryBeforeWork returns empty when no LESSONS.md', () => {
    const task = { id: 'T01', title: 'test task', writeFiles: ['src/a.mjs'] };
    const result = queryBeforeWork('/nonexistent', task);
    assert.deepEqual(result.hits, []);
    assert.equal(result.context, '');
  });

  it('queryBeforeWork finds relevant entries', () => {
    setup();
    const specsDir = join(TMP, 'change-01');
    const parentDir = TMP;
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(parentDir, 'LESSONS.md'), `# LESSONS

## gate 模块测试失败
gate.mjs 的 scope 检查逻辑有 bug，glob 匹配不正确。

## 无关条目
这是一个完全无关的条目。
`);
    const task = { id: 'T01', title: 'fix gate scope check', writeFiles: ['orchestrator/lib/gate.mjs'] };
    const result = queryBeforeWork(specsDir, task);
    assert.ok(result.hits.length > 0);
    assert.ok(result.context.includes('LESSONS 命中'));
    teardown();
  });

  it('recordFailure appends to LESSONS.md', () => {
    setup();
    const specsDir = join(TMP, 'change-01');
    const parentDir = TMP;
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(parentDir, 'LESSONS.md'), '# LESSONS\n');
    recordFailure(specsDir, {
      taskId: 'T05',
      reason: 'glob matching failed for ** patterns',
      excludedApproaches: ['simple string match'],
      timestamp: '2026-05-25T00:00:00Z',
    });
    const content = readFileSync(join(parentDir, 'LESSONS.md'), 'utf-8');
    assert.ok(content.includes('T05'));
    assert.ok(content.includes('glob matching failed'));
    assert.ok(content.includes('simple string match'));
    teardown();
  });

  it('recordBypass appends bypass record', () => {
    setup();
    const specsDir = join(TMP, 'change-01');
    const parentDir = TMP;
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(parentDir, 'LESSONS.md'), '# LESSONS\n');
    recordBypass(specsDir, {
      taskId: 'T03',
      reason: 'deadline pressure',
      timestamp: '2026-05-25T00:00:00Z',
    });
    const content = readFileSync(join(parentDir, 'LESSONS.md'), 'utf-8');
    assert.ok(content.includes('GATE BYPASS'));
    assert.ok(content.includes('deadline pressure'));
    teardown();
  });
});

// --- gate orchestrator tests ---

describe('gate', () => {
  it('runGate fails when task not found', () => {
    const result = runGate('T99', '/nonexistent', {});
    assert.equal(result.passed, false);
    assert.ok(result.checks[0].evidence.includes('not found'));
  });

  it('runGate passes with valid task and evidence', () => {
    setup();
    const specsDir = TMP;
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, 'TASK.md'), `
<task id="T01" status="pending">
fix the bug
write_files: [src/a.mjs]
verify: $ npm test\n5 passing\nexit code: 0
</task>
`);
    const result = runGate('T01', specsDir, { pipeline: 'light', actualFiles: ['src/a.mjs'] });
    assert.equal(result.passed, true);
    assert.equal(result.forced, false);
    teardown();
  });

  it('runGate with --force bypasses failures', () => {
    setup();
    const specsDir = join(TMP, 'change-01');
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, 'TASK.md'), `
<task id="T01" status="pending">
fix the bug
write_files: [src/a.mjs]
</task>
`);
    writeFileSync(join(dirname(specsDir), 'LESSONS.md'), '# LESSONS\n');
    const result = runGate('T01', specsDir, { force: true, pipeline: 'light', actualFiles: [] });
    assert.equal(result.passed, true);
    assert.equal(result.forced, true);
    teardown();
  });

  it('writeGateResult injects gate_result into TASK.md', () => {
    setup();
    const taskMd = join(TMP, 'TASK.md');
    writeFileSync(taskMd, `
<task id="T01" status="pending">
do something
write_files: [src/a.mjs]
</task>
`);
    const result = { passed: true, checks: [], timestamp: '2026-05-25T00:00:00Z', forced: false };
    writeGateResult(taskMd, 'T01', result);
    const content = readFileSync(taskMd, 'utf-8');
    assert.ok(content.includes('<gate_result>'));
    assert.ok(content.includes('PASSED'));
    teardown();
  });
});
