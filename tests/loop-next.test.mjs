import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextStep, WHITELIST, CONVERGE_CONDITIONS } from '../src/lib/loop.mjs';

for (const stage of ['change','requirement','design','task','dev','test','review','integration']) {
  test(`full executes current ${stage}, even stale success cannot skip it`, () => {
    assert.equal(computeNextStep({ pipeline:'full', currentStage:stage }), `gantry-${stage}`);
    assert.equal(computeNextStep({ pipeline:'full', currentStage:stage, lastStageResult:{ok:true} }), `gantry-${stage}`);
    assert.equal(computeNextStep({ pipeline:'full', currentStage:stage, nextStep:`gantry-${stage}` }), `gantry-${stage}`);
  });
}
test('full explicit nextStep cannot bypass position, including invalid token', () => {
  for (const nextStep of ['gantry-test','done','invalid-token']) assert.equal(computeNextStep({pipeline:'full',currentStage:'dev',nextStep}), 'blocked');
});
test('blockedReason wins over success', () => {
  assert.equal(computeNextStep({pipeline:'light',currentStage:'fast',lastStageResult:{ok:true,blockedReason:'human'}}),'blocked');
});
test('light fast preserves in-progress and convergence behavior', () => {
  assert.equal(computeNextStep({pipeline:'light',currentStage:'fast'}),'gantry-fast');
  assert.equal(computeNextStep({pipeline:'light',currentStage:'fast',lastStageResult:{ok:true}}),'done');
  assert.equal(computeNextStep({pipeline:'light',currentStage:'integration',lastStageResult:{ok:true}}),'blocked');
});
test('idle token remains change; controller decides whether change exists', () => {
  assert.equal(computeNextStep({pipeline:'full',currentStage:'idle'}),'gantry-change');
});
test('unknown pipeline uses full current-stage behavior', () => {
  assert.equal(computeNextStep({pipeline:'unknown',currentStage:'design'}),'gantry-design');
});
test('unknown/missing stage fails closed and all outputs are whitelisted', () => {
  for(const state of [null,undefined,{}, {currentStage:'bogus'}, {currentStage:'done'}]) assert.ok(WHITELIST.includes(computeNextStep(state)));
  assert.equal(computeNextStep({currentStage:'bogus'}),'blocked');
});
test('exported contracts remain immutable', () => {
  assert.throws(() => WHITELIST.push('bypass'));
  assert.throws(() => { CONVERGE_CONDITIONS.full = () => true; });
});
