/**
 * self-heal.test.mjs — 纯函数契约(SPEC AC-1/AC-2/AC-3/AC-8)
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendHealAttempt,
  readHealLog,
  countRecentFailures,
  shouldStopHealing,
  HEAL_SECTION_TITLE,
} from '../src/lib/self-heal.mjs';

function fixture(initial = '# EXECUTION: demo\n\n## Entries\n\n### T01\n\n- status: done\n') {
  const dir = mkdtempSync(join(tmpdir(), 'self-heal-'));
  const execPath = join(dir, 'EXECUTION.md');
  writeFileSync(execPath, initial, 'utf-8');
  return { dir, execPath };
}

test('AC-1 · 首次追加,段标题 + 子记录格式匹配', () => {
  const { dir, execPath } = fixture();
  try {
    const n = appendHealAttempt(execPath, {
      taskId: 'T02',
      reason: 'verify failed',
      command: 'node --test tests/foo.test.mjs',
      stderr: 'AssertionError: expected 1 got 2',
      at: '2026-09-16T14:30:12.000Z',
    });
    assert.equal(n, 1);
    const raw = readFileSync(execPath, 'utf-8');
    assert.match(raw, /## Self-Heal Log/);
    assert.match(raw, /### T02 · attempt #1/);
    assert.match(raw, /- at: 2026-09-16T14:30:12\.000Z/);
    assert.match(raw, /- reason: verify failed/);
    assert.match(raw, /- command: `node --test tests\/foo\.test\.mjs`/);
    assert.match(raw, /- stderr:\n\s+```/);
    assert.match(raw, /AssertionError: expected 1 got 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-1 · 同 taskId 第二次 attempt #2', () => {
  const { dir, execPath } = fixture();
  try {
    appendHealAttempt(execPath, { taskId: 'T02', reason: 'r1', at: '2026-01-01T00:00:00.000Z' });
    const n2 = appendHealAttempt(execPath, { taskId: 'T02', reason: 'r2', at: '2026-01-01T00:01:00.000Z' });
    assert.equal(n2, 2);
    const raw = readFileSync(execPath, 'utf-8');
    assert.match(raw, /### T02 · attempt #1/);
    assert.match(raw, /### T02 · attempt #2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-2 · readHealLog 分组正确,跨 taskId 交错', () => {
  const { dir, execPath } = fixture();
  try {
    appendHealAttempt(execPath, { taskId: 'T02', reason: 'a', at: '2026-01-01T00:00:00.000Z' });
    appendHealAttempt(execPath, { taskId: 'T03', reason: 'b', at: '2026-01-01T00:01:00.000Z' });
    appendHealAttempt(execPath, { taskId: 'T02', reason: 'c', at: '2026-01-01T00:02:00.000Z' });
    const log = readHealLog(execPath);
    assert.equal(Object.keys(log).sort().join(','), 'T02,T03');
    assert.equal(log.T02.length, 2);
    assert.equal(log.T03.length, 1);
    assert.equal(log.T02[0].reason, 'a');
    assert.equal(log.T02[1].reason, 'c');
    assert.equal(log.T02[1].attempt, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-1 · 缺 stderr 时不产出 stderr 段', () => {
  const { dir, execPath } = fixture();
  try {
    appendHealAttempt(execPath, { taskId: 'T02', reason: 'r', at: '2026-01-01T00:00:00.000Z' });
    const raw = readFileSync(execPath, 'utf-8');
    assert.doesNotMatch(raw, /- stderr:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-1 · stderr 8KB 截断,保留头尾 + truncated 标记', () => {
  const { dir, execPath } = fixture();
  try {
    const bigStderr = 'A'.repeat(4096) + 'B'.repeat(4096) + 'C'.repeat(4096); // 12KB
    appendHealAttempt(execPath, {
      taskId: 'T02', reason: 'r', stderr: bigStderr, at: '2026-01-01T00:00:00.000Z',
    });
    const raw = readFileSync(execPath, 'utf-8');
    assert.match(raw, /\[\.\.\.truncated \d+ bytes\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-1 · reason 超长截 200 + …', () => {
  const { dir, execPath } = fixture();
  try {
    const longReason = 'x'.repeat(300);
    appendHealAttempt(execPath, { taskId: 'T02', reason: longReason, at: '2026-01-01T00:00:00.000Z' });
    const raw = readFileSync(execPath, 'utf-8');
    assert.match(raw, /- reason: x{200}…/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-1 · taskId 非法(空/含空白/含 #)→ throw', () => {
  const { dir, execPath } = fixture();
  try {
    assert.throws(() => appendHealAttempt(execPath, { taskId: '', reason: 'r' }), /invalid taskId/);
    assert.throws(() => appendHealAttempt(execPath, { taskId: 'T 02', reason: 'r' }), /invalid taskId/);
    assert.throws(() => appendHealAttempt(execPath, { taskId: 'T#02', reason: 'r' }), /invalid taskId/);
    assert.throws(() => appendHealAttempt(execPath, { taskId: 'T\n02', reason: 'r' }), /invalid taskId/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-1 · execPath 不存在 → throw', () => {
  const { dir } = fixture();
  try {
    assert.throws(
      () => appendHealAttempt(join(dir, 'nope.md'), { taskId: 'T', reason: 'r' }),
      /execution file missing/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-2 · readHealLog 段不存在 → {}', () => {
  const { dir, execPath } = fixture();
  try {
    assert.deepEqual(readHealLog(execPath), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-2 · countRecentFailures 未记录 → 0', () => {
  const { dir, execPath } = fixture();
  try {
    appendHealAttempt(execPath, { taskId: 'T02', reason: 'r', at: '2026-01-01T00:00:00.000Z' });
    const log = readHealLog(execPath);
    assert.equal(countRecentFailures(log, 'T99'), 0);
    assert.equal(countRecentFailures(log, 'T02'), 1);
    assert.equal(countRecentFailures(null, 'T02'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-3 · shouldStopHealing count<limit → stop=false', () => {
  const log = { T02: [{ attempt: 1 }, { attempt: 2 }] };
  assert.deepEqual(shouldStopHealing(log, 'T02'), { stop: false, count: 2, limit: 3 });
  assert.deepEqual(shouldStopHealing(log, 'T99'), { stop: false, count: 0, limit: 3 });
});

test('AC-3 · shouldStopHealing count>=limit → stop=true', () => {
  const log = { T02: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }] };
  assert.deepEqual(shouldStopHealing(log, 'T02'), { stop: true, count: 3, limit: 3 });
  assert.deepEqual(shouldStopHealing(log, 'T02', 2), { stop: true, count: 3, limit: 2 });
});

test('AC-3 · shouldStopHealing limit=0 或非整数 → throw', () => {
  assert.throws(() => shouldStopHealing({}, 'T', 0), /invalid limit/);
  assert.throws(() => shouldStopHealing({}, 'T', -1), /invalid limit/);
  assert.throws(() => shouldStopHealing({}, 'T', 1.5), /invalid limit/);
  assert.throws(() => shouldStopHealing({}, 'T', NaN), /invalid limit/);
});

test('AC-8 · self-heal 不 import PATCH.md,PATCH 前后字节相等', () => {
  const { dir, execPath } = fixture();
  const patchPath = join(dir, 'PATCH.md');
  const patchContent = '# PATCH\n\nstatus: open\n\n## 变更记录\n- 初始 patch\n';
  writeFileSync(patchPath, patchContent, 'utf-8');
  try {
    appendHealAttempt(execPath, { taskId: 'T02', reason: 'r', at: '2026-01-01T00:00:00.000Z' });
    const patchAfter = readFileSync(patchPath, 'utf-8');
    assert.equal(patchAfter, patchContent);
    // 段标题实际写入
    const raw = readFileSync(execPath, 'utf-8');
    assert.ok(raw.includes(HEAL_SECTION_TITLE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
