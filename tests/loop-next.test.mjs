/**
 * loop-next.test.mjs — computeNextStep 判定序 + 白名单契约
 *
 * 对齐 AC-3 / AC-4。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeNextStep, WHITELIST, CONVERGE_CONDITIONS } from '../src/lib/loop.mjs';

function makeState(overrides = {}) {
  return {
    pipeline: 'full',
    currentStage: 'design',
    currentWave: null,
    previousWave: null,
    nextStep: null,
    lastStageResult: null,
    ...overrides,
  };
}

test('AC-4 · blockedReason 优先于任何其他判定', () => {
  const state = makeState({
    currentStage: 'integration',
    lastStageResult: { ok: true, blockedReason: 'needs human decision' },
    nextStep: 'done',
  });
  assert.equal(computeNextStep(state), 'blocked');
});

test('AC-3 · full pipeline 在 integration + ok 时 done', () => {
  const state = makeState({
    pipeline: 'full',
    currentStage: 'integration',
    lastStageResult: { ok: true, blockedReason: null },
  });
  assert.equal(computeNextStep(state), 'done');
});

test('AC-1/AC-3 · light pipeline 在 fast + ok 时 done', () => {
  const state = makeState({
    pipeline: 'light',
    currentStage: 'fast',
    lastStageResult: { ok: true, blockedReason: null },
  });
  assert.equal(computeNextStep(state), 'done');
});

test('AC-1/AC-3 · light pipeline 在 fast 但 ok 非 true 时不 done', () => {
  for (const lastStageResult of [null, { ok: false, blockedReason: null }]) {
    const state = makeState({
      pipeline: 'light',
      currentStage: 'fast',
      lastStageResult,
    });
    assert.notEqual(computeNextStep(state), 'done', `lastStageResult=${JSON.stringify(lastStageResult)} 不应收敛`);
    assert.equal(computeNextStep(state), 'blocked');
  }
});

test('AC-3 · full 未到 integration 时按 pipeline 顺序推进(design → task)', () => {
  const state = makeState({
    pipeline: 'full',
    currentStage: 'design',
    lastStageResult: null,
  });
  // ui-design 已合入 design,design 直接接 task
  const next = computeNextStep(state);
  assert.equal(next, 'gantry-task', `期望 gantry-task, got ${next}`);
});

test('AC-3 · state.nextStep 命中白名单时直接返回', () => {
  const state = makeState({
    pipeline: 'full',
    currentStage: 'dev',
    nextStep: 'gantry-test',
  });
  assert.equal(computeNextStep(state), 'gantry-test');
});

test('AC-3 · state.nextStep 不在白名单时走兜底', () => {
  const state = makeState({
    pipeline: 'full',
    currentStage: 'dev',
    nextStep: 'invalid-token',
  });
  const next = computeNextStep(state);
  assert.equal(next, 'gantry-test'); // pipeline 下 dev 后继
});

test('AC-3 · idle → gantry-change', () => {
  const state = makeState({ currentStage: 'idle' });
  assert.equal(computeNextStep(state), 'gantry-change');
});

test('AC-3 · 输出严格在白名单', () => {
  const states = [
    makeState({ currentStage: 'idle' }),
    makeState({ currentStage: 'change' }),
    makeState({ currentStage: 'requirement' }),
    makeState({ currentStage: 'design' }),
    makeState({ currentStage: 'task' }),
    makeState({ currentStage: 'dev' }),
    makeState({ currentStage: 'test' }),
    makeState({ currentStage: 'review' }),
    makeState({ currentStage: 'integration', lastStageResult: { ok: true } }),
    makeState({ currentStage: null }),
    { pipeline: 'unknown-pipeline' },
    null,
    undefined,
    { pipeline: 'full', currentStage: 'nonexistent' },
  ];
  for (const s of states) {
    const token = computeNextStep(s);
    assert.ok(
      WHITELIST.includes(token),
      `state ${JSON.stringify(s)} → ${token} 不在白名单`,
    );
  }
});

test('AC-3 · 未知 pipeline 回退到 full 语义', () => {
  const state = makeState({
    pipeline: 'unknown',
    currentStage: 'integration',
    lastStageResult: { ok: true, blockedReason: null },
  });
  assert.equal(computeNextStep(state), 'done');
});

test('回归 · full integration 但 lastStageResult 缺失时返回 blocked(不能误判为 done)', () => {
  // 场景:STATE.md 已推到 integration 但 fence 缺失 / verify 未跑。
  // 早期实现 deriveNextFromStage 在 pipeline 末位无脑返回 'done',
  // 绕过 CONVERGE_CONDITIONS 要求的 ok===true → driver 会跳过 AC 覆盖硬闸。
  const state = makeState({
    pipeline: 'full',
    currentStage: 'integration',
    lastStageResult: null,
  });
  assert.equal(computeNextStep(state), 'blocked');
});

test('回归 · 旧 light@integration(存量形态)不得被判为 done', () => {
  // light 收敛点已从 integration 移到 fast（AC-1）。存量的 light@integration
  // 即使 ok=true 也不能收敛，否则 driver 会跳过 light 出口门直接收尾。
  for (const lastStageResult of [null, { ok: true, blockedReason: null }]) {
    const state = makeState({
      pipeline: 'light',
      currentStage: 'integration',
      lastStageResult,
    });
    assert.equal(computeNextStep(state), 'blocked');
  }
});

test('回归 · integration 且 lastStageResult.ok=false 时返回 blocked', () => {
  const state = makeState({
    pipeline: 'full',
    currentStage: 'integration',
    lastStageResult: { ok: false, blockedReason: null },
  });
  assert.equal(computeNextStep(state), 'blocked');
});

test('AC-3 · CONVERGE_CONDITIONS 冻结不可变', () => {
  assert.throws(() => { CONVERGE_CONDITIONS.full = () => true; });
});

test('AC-3 · WHITELIST 冻结不可变', () => {
  assert.throws(() => { WHITELIST.push('gantry-hack'); });
});
