/**
 * review-lane-guard.test.mjs — REVIEW lane 上下文隔离 gate (按 kind 白名单)
 *
 * 锁定 checkPack 纯判定 (ADR-REVBL-004):
 *   - AC-9  白名单 kind 通过 (lane='review')
 *   - AC-10 未知 kind 拦截 + reason 格式
 *   - AC-11 execution-log / execution-doc 自动被挡
 *   - AC-12 --allow-kind escape hatch (通过 opts.allowKind 传入)
 *   - 非 review lane → allowed = pack.loadOrder, blocked 空 (其他 lane 不受影响)
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { checkPack, ALLOWED_REVIEW_KINDS } from '../src/lib/review-lane-guard.mjs';

// AC-9 · 白名单 kind 通过
test('AC-9: ALLOWED_REVIEW_KINDS 中每个 kind 在 lane=review 时均被放行', () => {
  const pack = {
    loadOrder: ALLOWED_REVIEW_KINDS.map((kind, i) => ({
      path: `.gantry/specs/c/item-${i}.md`,
      kind,
      required: true,
    })),
  };
  const res = checkPack(pack, { lane: 'review' });
  assert.equal(res.blocked.length, 0);
  assert.equal(res.allowed.length, pack.loadOrder.length);
  assert.deepEqual(
    res.allowed.map(e => e.kind).sort(),
    [...ALLOWED_REVIEW_KINDS].sort(),
  );
});

test('AC-9: 白名单覆盖现仓真实 kind (artifact / lessons / learning)', () => {
  const pack = {
    loadOrder: [
      { path: '.gantry/specs/c/TASKS.md', kind: 'artifact', required: true },
      { path: '.gantry/specs/LESSONS.md', kind: 'lessons', required: false },
      { path: '.gantry/learnings/team/L-1.md', kind: 'learning', required: false },
    ],
  };
  const res = checkPack(pack, { lane: 'review' });
  assert.equal(res.blocked.length, 0);
  assert.equal(res.allowed.length, 3);
});

// AC-10 · 未知 kind 拦截 + reason 格式
test('AC-10: 未知 kind 被拦截, blocked 含 path/kind/reason 且 reason 格式正确', () => {
  const pack = {
    loadOrder: [
      { path: '.gantry/specs/c/SPEC.md', kind: 'spec-doc', required: true },
      { path: '.gantry/dev/execution.log', kind: 'execution-log', required: false },
    ],
  };
  const res = checkPack(pack, { lane: 'review' });
  assert.equal(res.allowed.length, 1);
  assert.equal(res.blocked.length, 1);
  assert.equal(res.blocked[0].path, '.gantry/dev/execution.log');
  assert.equal(res.blocked[0].kind, 'execution-log');
  assert.equal(
    res.blocked[0].reason,
    'kind "execution-log" 不在 ALLOWED_REVIEW_KINDS 白名单',
  );
});

// AC-11 · execution-log / execution-doc 自动被挡
test('AC-11: EXECUTION.md 的 execution-doc / execution-log kind 自动被挡', () => {
  const pack = {
    loadOrder: [
      { path: '.gantry/specs/c/EXECUTION.md', kind: 'execution-doc', required: false },
      { path: '.gantry/specs/c/EXECUTION.md', kind: 'execution-log', required: false },
    ],
  };
  const res = checkPack(pack, { lane: 'review' });
  assert.equal(res.allowed.length, 0);
  assert.equal(res.blocked.length, 2);
  assert.deepEqual(res.blocked.map(b => b.kind), ['execution-doc', 'execution-log']);
});

// AC-12 · --allow-kind escape hatch
test('AC-12: opts.allowKind 额外放行对应 kind, 且不改白名单常量', () => {
  const pack = {
    loadOrder: [
      { path: '.gantry/dev/execution.log', kind: 'execution-log', required: false },
    ],
  };
  const res = checkPack(pack, { lane: 'review', allowKind: ['execution-log'] });
  assert.equal(res.blocked.length, 0);
  assert.equal(res.allowed.length, 1);
  assert.equal(res.allowed[0].kind, 'execution-log');
  // 白名单常量未被 escape hatch 污染
  assert.equal(ALLOWED_REVIEW_KINDS.includes('execution-log'), false);
});

// 非 review lane 不受影响
test('lane 非 review 时 allowed = pack.loadOrder, blocked 空', () => {
  const pack = {
    loadOrder: [
      { path: '.gantry/dev/execution.log', kind: 'execution-log', required: false },
      { path: '.gantry/specs/c/SPEC.md', kind: 'spec-doc', required: true },
    ],
  };
  for (const lane of [undefined, 'dev', 'test']) {
    const res = checkPack(pack, { lane });
    assert.equal(res.blocked.length, 0, `lane=${lane} 不应拦截`);
    assert.equal(res.allowed.length, 2, `lane=${lane} 应保留全部 loadOrder`);
  }
});

test('无 loadOrder 的 pack 返回 allowed=[], blocked=[]', () => {
  const res = checkPack({}, { lane: 'review' });
  assert.deepEqual(res.allowed, []);
  assert.deepEqual(res.blocked, []);
});
