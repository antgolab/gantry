import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGate, writeGateResult } from '../src/lib/gate.mjs';
import { groupWaves, parseTasks } from '../src/lib/tasks.mjs';
import { assemblePrompt } from '../src/lib/agents.mjs';

const TMP_PARENT = join(import.meta.dirname, '.tmp-integration-parent');
const TMP = join(TMP_PARENT, 'change-123');

function setup() {
  if (existsSync(TMP_PARENT)) rmSync(TMP_PARENT, { recursive: true });
  mkdirSync(TMP, { recursive: true });
}

function teardown() {
  if (existsSync(TMP_PARENT)) rmSync(TMP_PARENT, { recursive: true });
}

describe('integration: full gate flow', () => {
  it('happy path — task with valid evidence passes all gates', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T01" status="pending">
Implement login form
write_files: [src/login.mjs, src/login.test.mjs]
verify: $ node --test src/login.test.mjs
3 passing
exit code: 0
</task>
`);
    const result = runGate('T01', TMP, {
      pipeline: 'standard',
      actualFiles: ['src/login.mjs', 'src/login.test.mjs'],
    });
    assert.equal(result.passed, true);
    assert.equal(result.forced, false);
    assert.ok(result.checks.every(c => c.passed));
    teardown();
  });

  it('failure path — speculative language blocks gate', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T02" status="pending">
Fix the auth bug
write_files: [src/auth.mjs]
verify: I think this should pass now. Looks good.
</task>
`);
    const result = runGate('T02', TMP, {
      pipeline: 'light',
      actualFiles: ['src/auth.mjs'],
    });
    assert.equal(result.passed, false);
    const verifyCheck = result.checks.find(c => c.gate === 'verify-evidence');
    assert.equal(verifyCheck.passed, false);
    assert.ok(verifyCheck.issues.some(i => i.includes('Speculative')));
    teardown();
  });

  it('scope violation — modifying undeclared file blocks gate', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T03" status="pending">
Update styles
write_files: [src/styles.css]
verify: $ npm run lint
0 errors
PASS
</task>
`);
    const result = runGate('T03', TMP, {
      pipeline: 'light',
      actualFiles: ['src/styles.css', 'src/index.mjs'],
    });
    assert.equal(result.passed, false);
    const scopeCheck = result.checks.find(c => c.gate === 'scope-guard');
    assert.equal(scopeCheck.passed, false);
    assert.ok(scopeCheck.violations.includes('src/index.mjs'));
    teardown();
  });

  it('force bypass — records to LESSONS and passes', () => {
    setup();
    mkdirSync(join(TMP, '..', '.tmp-integration-parent'), { recursive: true });
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T04" status="pending">
Quick hotfix
write_files: [src/hotfix.mjs]
</task>
`);
    // Create LESSONS.md at parent level for bypass recording
    const parentDir = join(TMP, '..');
    if (!existsSync(join(parentDir, 'LESSONS.md'))) {
      writeFileSync(join(parentDir, 'LESSONS.md'), '# LESSONS\n');
    }
    const result = runGate('T04', TMP, {
      force: true,
      pipeline: 'light',
      actualFiles: ['src/hotfix.mjs'],
    });
    assert.equal(result.passed, true);
    assert.equal(result.forced, true);
    teardown();
  });

  it('conflict detection — overlapping write_files forces sequential', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), `
<task id="T01" status="pending" parallel="true">
Task A
write_files: [src/shared.mjs, src/a.mjs]
</task>
<task id="T02" status="pending" parallel="true">
Task B
write_files: [src/shared.mjs, src/b.mjs]
</task>
<task id="T03" status="pending" parallel="true">
Task C
write_files: [src/c.mjs]
</task>
`);
    const tasks = parseTasks(join(TMP, 'TASK.md'));
    const waves = groupWaves(tasks);
    // T01 and T02 conflict on src/shared.mjs — should not be in same wave
    const firstWave = waves[0];
    const firstWaveIds = firstWave.map(t => t.id);
    const bothInFirst = firstWaveIds.includes('T01') && firstWaveIds.includes('T02');
    assert.equal(bothInFirst, false, 'Conflicting tasks T01 and T02 should not be in same wave');
    teardown();
  });

  it('writeGateResult preserves existing task content', () => {
    setup();
    const taskMd = join(TMP, 'TASK.md');
    writeFileSync(taskMd, `
<task id="T01" status="pending">
Important task
write_files: [src/a.mjs]
verify: $ npm test
5 passing
</task>

<task id="T02" status="done">
Already done
write_files: [src/b.mjs]
</task>
`);
    const result = { passed: false, checks: [{ gate: 'verify-evidence', passed: false, issues: ['No evidence'] }], timestamp: '2026-05-25T00:00:00Z', forced: false };
    writeGateResult(taskMd, 'T01', result);
    const content = readFileSync(taskMd, 'utf-8');
    assert.ok(content.includes('<gate_result>'));
    assert.ok(content.includes('FAILED'));
    // T02 should be untouched
    assert.ok(content.includes('Already done'));
    assert.ok(content.includes('id="T02"'));
    teardown();
  });

  it('assemblePrompt includes lessonsContext when LESSONS has hits', () => {
    setup();
    const specsDir = join(TMP, 'change-01');
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, 'TASK.md'), `
<task id="T01" status="pending">
Fix auth module
write_files: [src/auth.mjs]
</task>
`);
    writeFileSync(join(TMP, 'LESSONS.md'), `# LESSONS

## auth 模块 token 过期问题
auth.mjs 中 token refresh 逻辑有竞态条件，需要加锁。
`);
    const result = assemblePrompt('dev', {
      specsDir,
      projectRoot: TMP,
      changeId: 'change-01',
      taskId: 'T01',
    });
    assert.ok(result.lessonsContext.includes('LESSONS 命中'));
    assert.ok(result.lessonsContext.includes('auth'));
    assert.ok(['fast', 'standard', 'deep'].includes(result.model));
    teardown();
  });
});
