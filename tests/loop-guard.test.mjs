/**
 * loop-guard.test.mjs — checkLoopGuard 纯函数契约
 *
 * 对齐 SPEC AC-2 / AC-3。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { checkLoopGuard, resolveThresholds, DEFAULT_THRESHOLDS } from '../src/lib/loop-guard.mjs';

function makeState(overrides = {}) {
  return {
    pipeline: 'full',
    currentStage: 'dev',
    stagesRun: 0,
    maxStages: 10,
    contextUsage: null,
    ...overrides,
  };
}

test('AC-2 · windowPercent >= 85 → context-window-exceeded', () => {
  const state = makeState({ contextUsage: { windowPercent: 85, tokens: 1 } });
  const r = checkLoopGuard(state);
  assert.equal(r.tripped, true);
  assert.equal(r.reason, 'context-window-exceeded');
  assert.equal(r.field, 'contextUsage.windowPercent');
});

test('AC-2 · windowPercent 略低于阈值 → 不熔断', () => {
  const state = makeState({ contextUsage: { windowPercent: 84, tokens: 1 } });
  const r = checkLoopGuard(state);
  assert.equal(r.tripped, false);
});

test('AC-2 · tokens > 200000 → context-tokens-exceeded', () => {
  const state = makeState({ contextUsage: { windowPercent: 10, tokens: 200001 } });
  const r = checkLoopGuard(state);
  assert.equal(r.tripped, true);
  assert.equal(r.reason, 'context-tokens-exceeded');
});

test('AC-3 · stagesRun >= maxStages → max-stages-exceeded', () => {
  const state = makeState({ stagesRun: 10, maxStages: 10, contextUsage: { windowPercent: 0, tokens: 0 } });
  const r = checkLoopGuard(state);
  assert.equal(r.tripped, true);
  assert.equal(r.reason, 'max-stages-exceeded');
});

test('AC-2 · contextUsage 缺失 → skipped:true 不熔断', () => {
  const state = makeState({ contextUsage: null });
  const r = checkLoopGuard(state);
  assert.equal(r.tripped, false);
  assert.equal(r.skipped, true);
});

test('AC-2 · context 优先于 stagesRun', () => {
  const state = makeState({
    stagesRun: 999,
    maxStages: 10,
    contextUsage: { windowPercent: 99, tokens: 999999 },
  });
  const r = checkLoopGuard(state);
  assert.equal(r.reason, 'context-window-exceeded');
});

test('AC-2 · config 覆写缺省阈值', () => {
  const state = makeState({ contextUsage: { windowPercent: 50, tokens: 1 } });
  const config = { loopGuard: { contextPercent: 40 } };
  const r = checkLoopGuard(state, config);
  assert.equal(r.tripped, true);
  assert.equal(r.reason, 'context-window-exceeded');
});

test('AC-3 · maxStages=0 时该项跳过', () => {
  const state = makeState({ stagesRun: 100, maxStages: 0, contextUsage: { windowPercent: 0, tokens: 0 } });
  const r = checkLoopGuard(state);
  assert.equal(r.tripped, false);
});

test('resolveThresholds · 返回冻结缺省值', () => {
  const t = resolveThresholds();
  assert.equal(t.contextPercent, DEFAULT_THRESHOLDS.contextPercent);
  assert.equal(t.contextTokens, DEFAULT_THRESHOLDS.contextTokens);
  assert.equal(t.stuckTolerance, DEFAULT_THRESHOLDS.stuckTolerance);
});

test('checkLoopGuard · 空/非法 state 兜底 skipped', () => {
  assert.deepEqual(checkLoopGuard(null), { tripped: false, skipped: true });
  assert.deepEqual(checkLoopGuard(undefined), { tripped: false, skipped: true });
  assert.deepEqual(checkLoopGuard('not-object'), { tripped: false, skipped: true });
});
