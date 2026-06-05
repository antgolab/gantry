import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { route, estimateFromIntent, checkUpgrade } from '../src/lib/router.mjs';
import { evaluateAndAdvise, evaluateWave, checkSafetyValve, progressReport } from '../src/lib/loop.mjs';

// --- router tests ---

describe('router', () => {
  it('routes trivial intent to light pipeline', () => {
    const result = route('fix typo in readme');
    assert.equal(result.scale, 'trivial');
    assert.equal(result.pipeline, 'light');
    assert.equal(result.model, 'fast');
  });

  it('routes feature intent to standard pipeline', () => {
    const result = route('implement user authentication feature');
    assert.equal(result.scale, 'medium');
    assert.equal(result.pipeline, 'standard');
    assert.equal(result.model, 'standard');
  });

  it('routes architectural intent to full pipeline', () => {
    const result = route('migrate from monolith to microservices');
    assert.equal(result.scale, 'architectural');
    assert.equal(result.pipeline, 'full');
    assert.equal(result.model, 'deep');
  });

  it('routes bug fix to light pipeline', () => {
    const result = route('fix login bug');
    assert.equal(result.scale, 'small');
    assert.equal(result.pipeline, 'light');
  });

  it('estimateFromIntent detects Chinese keywords', () => {
    assert.equal(estimateFromIntent('重构整个架构'), 'architectural');
    assert.equal(estimateFromIntent('修复登录问题'), 'small');
    assert.equal(estimateFromIntent('新增用户功能'), 'medium');
  });

  it('checkUpgrade upgrades when task count exceeds threshold', () => {
    const { upgraded, newPipeline } = checkUpgrade('light', 5);
    assert.equal(upgraded, true);
    assert.equal(newPipeline, 'standard');
  });

  it('checkUpgrade does not upgrade when within threshold', () => {
    const { upgraded } = checkUpgrade('light', 2);
    assert.equal(upgraded, false);
  });

  it('checkUpgrade upgrades standard to full', () => {
    const { upgraded, newPipeline } = checkUpgrade('standard', 10);
    assert.equal(upgraded, true);
    assert.equal(newPipeline, 'full');
  });

  it('route includes rationale', () => {
    const result = route('add new feature');
    assert.ok(result.rationale.length > 0);
  });

  it('route includes stages array', () => {
    const result = route('implement feature');
    assert.ok(Array.isArray(result.stages));
    assert.ok(result.stages.length >= 2);
  });
});

// --- loop tests ---

describe('persistence-loop', () => {
  it('evaluateAndAdvise returns done when gate passes', () => {
    const task = { id: 'T01' };
    const gateResult = { passed: true, checks: [] };
    const result = evaluateAndAdvise(task, gateResult);
    assert.equal(result.action, 'done');
  });

  it('evaluateAndAdvise returns retry with prompt on failure', () => {
    const task = { id: 'T01', title: 'Fix bug' };
    const gateResult = { passed: false, checks: [{ gate: 'verify-evidence', passed: false, issues: ['No evidence'] }] };
    const result = evaluateAndAdvise(task, gateResult, { retryCount: 0 });
    assert.equal(result.action, 'retry');
    assert.equal(result.retryCount, 1);
    assert.ok(result.retryPrompt.includes('verify-evidence'));
    assert.ok(result.strategy.length > 0);
  });

  it('evaluateAndAdvise returns blocked after max retries', () => {
    const task = { id: 'T01' };
    const gateResult = { passed: false, checks: [{ gate: 'scope-guard', passed: false, violations: ['x.mjs'] }] };
    const result = evaluateAndAdvise(task, gateResult, { retryCount: 3 });
    assert.equal(result.action, 'blocked');
  });

  it('evaluateAndAdvise escalates model on retry', () => {
    const task = { id: 'T01' };
    const gateResult = { passed: false, checks: [{ gate: 'verify-evidence', passed: false, issues: ['Speculative'] }] };
    const result = evaluateAndAdvise(task, gateResult, { retryCount: 1, currentModel: 'fast' });
    assert.equal(result.newModel, 'standard');
  });

  it('evaluateWave categorizes tasks correctly', () => {
    const tasks = [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }];
    const gateResults = [
      { taskId: 'T01', result: { passed: true, checks: [] }, retryCount: 0 },
      { taskId: 'T02', result: { passed: false, checks: [] }, retryCount: 1 },
      { taskId: 'T03', result: { passed: false, checks: [] }, retryCount: 3 },
    ];
    const result = evaluateWave(tasks, gateResults);
    assert.deepEqual(result.completed, ['T01']);
    assert.deepEqual(result.retry, ['T02']);
    assert.deepEqual(result.blocked, ['T03']);
    assert.equal(result.allDone, false);
  });

  it('checkSafetyValve triggers at limit', () => {
    const { shouldStop } = checkSafetyValve(20);
    assert.equal(shouldStop, true);
  });

  it('checkSafetyValve does not trigger below limit', () => {
    const { shouldStop } = checkSafetyValve(5);
    assert.equal(shouldStop, false);
  });

  it('progressReport formats correctly', () => {
    const report = progressReport({ totalIterations: 5, tasksCompleted: 3, tasksTotal: 7, blocked: ['T04'], currentWave: 2 });
    assert.ok(report.includes('5'));
    assert.ok(report.includes('3/7'));
    assert.ok(report.includes('T04'));
  });
});
