import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePipeline,
  proposalHasUiImpact,
} from '../src/lib/pipeline-policy.mjs';

describe('pipeline policy', () => {
  it('只保留 full/light，旧 standard 迁移为 full', () => {
    assert.equal(normalizePipeline(undefined), 'full');
    assert.equal(normalizePipeline('full'), 'full');
    assert.equal(normalizePipeline('light'), 'light');
    assert.equal(normalizePipeline('standard'), 'full');
    assert.throws(() => normalizePipeline('unknown'), /未知 pipeline/);
  });

  // assessLightEligibility 的 2 个用例已删除：该函数连同 LIGHT_RISK_RULES 一起
  // 被移除（AC-12 红线定义唯一）：红线判定唯一源 = hard-rules.mjs，
  // replacement 覆盖在 tests/red-lines.test.mjs（同一个描述 → 同一 rule id 集合）。

  it('UI Design 只由 PROPOSAL 的结构化 uiImpact 决定', () => {
    assert.equal(proposalHasUiImpact('uiImpact: true\n'), true);
    assert.equal(proposalHasUiImpact('- **UI 影响**: `是`\n'), true);
    assert.equal(proposalHasUiImpact('使用 React 修复后端缓存'), false);
    assert.equal(proposalHasUiImpact('uiImpact: false\n'), false);
  });
});
