import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGate, getNextStage, shouldSkipConditional } from '../src/lib/phases.mjs';

const TMP = join(import.meta.dirname, '.tmp-ui-impact');
const UI_AUTO_CFG = {
  pipeline: 'full',
  stages: { 'ui-design': { enabled: 'auto', condition: 'ui-impact' } },
};

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

describe('ui-design · change impact condition', () => {
  it('uiImpact=true 时保留 ui-design', () => {
    assert.equal(shouldSkipConditional('ui-design', { ...UI_AUTO_CFG, _uiImpact: true }), false);
    assert.equal(getNextStage('design', { ...UI_AUTO_CFG, _uiImpact: true }), 'ui-design');
  });

  it('uiImpact=false 或缺失时跳过 ui-design', () => {
    assert.equal(shouldSkipConditional('ui-design', { ...UI_AUTO_CFG, _uiImpact: false }), true);
    assert.equal(shouldSkipConditional('ui-design', UI_AUTO_CFG), true);
    assert.equal(getNextStage('design', { ...UI_AUTO_CFG, _uiImpact: false }), 'task');
  });

  it('非自动配置不受 uiImpact 条件影响', () => {
    assert.equal(shouldSkipConditional('ui-design', {
      stages: { 'ui-design': { enabled: true } },
      _uiImpact: false,
    }), false);
  });

  it('uiImpact=true 时仍要求 DESIGN 工件', () => {
    setup();
    const missing = checkGate('ui-design', TMP, { ...UI_AUTO_CFG, _uiImpact: true });
    assert.equal(missing.passed, false);
    writeFileSync(join(TMP, 'DESIGN.md'), '# DESIGN\n');
    const present = checkGate('ui-design', TMP, { ...UI_AUTO_CFG, _uiImpact: true });
    assert.equal(present.passed, true);
    rmSync(TMP, { recursive: true, force: true });
  });

  it('uiImpact=false 时条件跳过直接放行', () => {
    setup();
    const result = checkGate('ui-design', TMP, { ...UI_AUTO_CFG, _uiImpact: false });
    assert.equal(result.passed, true);
    rmSync(TMP, { recursive: true, force: true });
  });
});
