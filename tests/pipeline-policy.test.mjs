import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessLightEligibility,
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

  it('light 接受局部低风险修复', () => {
    const result = assessLightEligibility('修复 README 中的拼写错误');
    assert.equal(result.eligible, true);
    assert.deepEqual(result.risks, []);
  });

  it('light 拒绝高风险变更并返回具体类别', () => {
    const result = assessLightEligibility(
      '跨模块修改 public API，并新增数据库 migration、鉴权逻辑和第三方依赖',
    );
    assert.equal(result.eligible, false);
    assert.ok(result.risks.includes('public-contract'));
    assert.ok(result.risks.includes('schema-or-migration'));
    assert.ok(result.risks.includes('cross-module'));
    assert.ok(result.risks.includes('dependency'));
    assert.ok(result.risks.includes('security'));
  });

  it('UI Design 只由 PROPOSAL 的结构化 uiImpact 决定', () => {
    assert.equal(proposalHasUiImpact('uiImpact: true\n'), true);
    assert.equal(proposalHasUiImpact('- **UI 影响**: `是`\n'), true);
    assert.equal(proposalHasUiImpact('使用 React 修复后端缓存'), false);
    assert.equal(proposalHasUiImpact('uiImpact: false\n'), false);
  });
});
