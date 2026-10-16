/**
 * config-schema.test.mjs — validateLearningsConfig 校验行为
 * 覆盖 3 类 case:合法完整 / 非法 / 缺省,并逐条覆盖校验规则。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLearningsConfig,
  validateJevConfig,
  DEFAULT_LEARNINGS_CONFIG,
  ConfigError,
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

// === T-FIX-13 config 未知 key fail-closed (AC-1 / AC-2) ===

test('AC-1 错拼 newFile 为 newfile 被检出', () => {
  const r = validateLearningsConfig({
    friction: { weights: { newfile: 10 } },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('learnings.friction.weights.newfile 不是已知配置项'));
});

test('顶层 unknownTop 被检出', () => {
  const r = validateLearningsConfig({ unknownTop: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('learnings.unknownTop 不是已知配置项'));
});

test('AC-2 多层嵌套 unknown key 均被检出', () => {
  const r = validateLearningsConfig({
    unknownTop: 'x',
    friction: { weights: { wrongKey: 1 } },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('learnings.unknownTop 不是已知配置项'));
  assert.ok(r.errors.includes('learnings.friction.weights.wrongKey 不是已知配置项'));
});

test('已知合法 key (newFile / refactor) 仍通过', () => {
  const r = validateLearningsConfig({
    friction: { weights: { newFile: 1, refactor: 2 } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('多个错拼 key 同时被累加到 errors', () => {
  const r = validateLearningsConfig({
    friction: { weights: { newfile: 1, wrongKey: 2, verifyfail: 3 } },
    unknonTop: 'x',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('learnings.friction.weights.newfile 不是已知配置项'));
  assert.ok(r.errors.includes('learnings.friction.weights.wrongKey 不是已知配置项'));
  assert.ok(r.errors.includes('learnings.friction.weights.verifyfail 不是已知配置项'));
  assert.ok(r.errors.includes('learnings.unknonTop 不是已知配置项'));
});

test('ConfigError 携带具体 key 路径 errors', () => {
  const err = new ConfigError(['learnings.unknownTop 不是已知配置项']);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ConfigError');
  assert.deepEqual(err.errors, ['learnings.unknownTop 不是已知配置项']);
});

// === jev-redline-precheck AC-8 · jev 配置 fail-closed ===

test('AC-8 jev 缺省 → ok=true', () => {
  assert.deepEqual(validateJevConfig(undefined), { ok: true, errors: [] });
});

test('AC-8 jev.enabled 为 boolean → ok=true', () => {
  assert.deepEqual(validateJevConfig({ enabled: true }), { ok: true, errors: [] });
  assert.deepEqual(validateJevConfig({ enabled: false }), { ok: true, errors: [] });
  assert.deepEqual(validateJevConfig({}), { ok: true, errors: [] });
});

test('AC-8 jev 不是普通对象 → 「jev 必须为对象」', () => {
  for (const bad of [null, true, 'on', 1, ['enabled']]) {
    const r = validateJevConfig(bad);
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
    assert.deepEqual(r.errors, ['jev 必须为对象']);
  }
});

test('AC-8 jev 下的 apiKey / key 按未知键拒绝(key 不进配置)', () => {
  const r = validateJevConfig({ enabled: true, apiKey: 'sk-x', key: 'sk-y' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('jev.apiKey 不是已知配置项'));
  assert.ok(r.errors.includes('jev.key 不是已知配置项'));
});

test('AC-8 jev.enabled 非 boolean → 「jev.enabled 必须为 boolean」', () => {
  for (const bad of ['true', 1, null]) {
    const r = validateJevConfig({ enabled: bad });
    assert.equal(r.ok, false, `应拒绝 enabled=${JSON.stringify(bad)}`);
    assert.deepEqual(r.errors, ['jev.enabled 必须为 boolean']);
  }
});
