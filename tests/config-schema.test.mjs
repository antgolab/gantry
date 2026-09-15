/**
 * config-schema.test.mjs — validateLearningsConfig 校验行为
 * 覆盖 3 类 case:合法完整 / 非法 / 缺省,并逐条覆盖校验规则。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLearningsConfig,
  DEFAULT_LEARNINGS_CONFIG,
} from '../src/lib/config-schema.mjs';

test('合法完整 config → ok=true, errors=[]', () => {
  const full = {
    enabled: true,
    friction: {
      threshold: 5,
      weights: {
        verifyFail: 2,
        'sameFileEdit3+': 2,
        userManualOverride: 3,
        userInterrupt: 2,
        rollback: 3,
        aiSelfCorrect: 1,
      },
    },
    recall: {
      enabled: true,
      relevancePreCheck: 0.3,
    },
  };
  const r = validateLearningsConfig(full);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('非法 threshold=-1 → ok=false, errors 非空', () => {
  const r = validateLearningsConfig({ friction: { threshold: -1 } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  assert.ok(r.errors.some((e) => e.includes('threshold')));
});

test('非法 relevancePreCheck=1.5 → ok=false, errors 非空', () => {
  const r = validateLearningsConfig({ recall: { relevancePreCheck: 1.5 } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  assert.ok(r.errors.some((e) => e.includes('relevancePreCheck')));
});

test('非法 weight 为负 → ok=false, errors 非空', () => {
  const r = validateLearningsConfig({ friction: { weights: { rollback: -3 } } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('rollback')));
});

test('缺省空对象 {} → ok=true, merged 补齐所有默认值', () => {
  const r = validateLearningsConfig({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.merged, DEFAULT_LEARNINGS_CONFIG);
});

test('部分覆盖仍补齐默认并保留用户值', () => {
  const r = validateLearningsConfig({ enabled: false, friction: { threshold: 9 } });
  assert.equal(r.ok, true);
  assert.equal(r.merged.enabled, false);
  assert.equal(r.merged.friction.threshold, 9);
  assert.deepEqual(r.merged.friction.weights, DEFAULT_LEARNINGS_CONFIG.friction.weights);
  assert.deepEqual(r.merged.recall, DEFAULT_LEARNINGS_CONFIG.recall);
});
