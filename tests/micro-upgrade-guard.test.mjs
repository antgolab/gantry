/**
 * micro-upgrade-guard.test.mjs — T08 micro 档升档保护
 *
 * 覆盖：
 *   - normalizePipeline 三值枚举 (micro/light/full 原样返回, unknown/undefined → full)
 *   - micro 不被回退成 full (ADR-001)
 *   - recordVerifyResult：micro 档 FAIL x2 触发 pauseReason + exitCode
 *   - recordVerifyResult：light/full 档 FAIL 不递增 verifyFailCount
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePipeline, recordVerifyResult } from '../src/lib/state.mjs';

describe('normalizePipeline · 三值枚举', () => {
  it('micro/light/full 原样返回', () => {
    assert.equal(normalizePipeline('micro'), 'micro');
    assert.equal(normalizePipeline('light'), 'light');
    assert.equal(normalizePipeline('full'), 'full');
  });

  it('unknown → full 默认', () => {
    assert.equal(normalizePipeline('unknown'), 'full');
  });

  it('undefined → full 默认', () => {
    assert.equal(normalizePipeline(undefined), 'full');
  });

  it('micro 不被回退成 full (ADR-001)', () => {
    assert.equal(normalizePipeline('micro'), 'micro');
    assert.notEqual(normalizePipeline('micro'), 'full');
  });
});

describe('recordVerifyResult · micro 升档保护', () => {
  it('micro 档 FAIL x2 触发 pauseReason 与 exitCode', () => {
    const state = { pipeline: 'micro', verifyFailCount: 0, pauseReason: null };
    const r1 = recordVerifyResult(state, false);
    assert.equal(state.verifyFailCount, 1);
    assert.equal(state.pauseReason, null);
    assert.equal(r1.exitCode, null);

    const r2 = recordVerifyResult(state, false);
    assert.equal(state.verifyFailCount, 2);
    assert.equal(state.pauseReason, 'micro-verify-failed-2x');
    assert.equal(r2.exitCode, 'micro_verify_failed');
  });

  it('micro 档 PASS 不递增 verifyFailCount', () => {
    const state = { pipeline: 'micro', verifyFailCount: 1, pauseReason: null };
    const r = recordVerifyResult(state, true);
    assert.equal(state.verifyFailCount, 1);
    assert.equal(state.pauseReason, null);
    assert.equal(r.exitCode, null);
  });

  it('light 档 FAIL 不递增 verifyFailCount', () => {
    const state = { pipeline: 'light', verifyFailCount: 0, pauseReason: null };
    const r = recordVerifyResult(state, false);
    assert.equal(state.verifyFailCount, 0);
    assert.equal(r.exitCode, null);
  });

  it('full 档 FAIL 不递增 verifyFailCount', () => {
    const state = { pipeline: 'full', verifyFailCount: 0, pauseReason: null };
    const r = recordVerifyResult(state, false);
    assert.equal(state.verifyFailCount, 0);
    assert.equal(r.exitCode, null);
  });
});
