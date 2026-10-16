/**
 * friction.test.mjs — friction.mjs 事件流采集 + 打分行为
 *
 * 测试独立性: 全部用 os.tmpdir() 下的临时 baseDir 覆盖默认 `.gantry/specs/` 前缀,
 * 不污染真实 .gantry/specs/。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordEvent, getEvents, getScore, FRICTION_KINDS } from '../src/lib/friction.mjs';
import { DEFAULT_LEARNINGS_CONFIG } from '../src/lib/config-schema.mjs';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'friction-test-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('recordEvent → getEvents 往返 3 条事件全数据一致', () => {
  const dir = makeDir();
  try {
    const baseDir = join(dir, 'specs');
    const events = [
      { kind: 'verifyFail', ts: '2026-09-14T12:00:00.000Z', meta: { taskId: 'T04' } },
      { kind: 'userInterrupt', ts: '2026-09-14T12:05:00.000Z', meta: {} },
      { kind: 'aiSelfCorrect', ts: '2026-09-14T12:06:00.000Z', meta: { taskId: 'T05', note: 'x' } },
    ];
    for (const e of events) recordEvent('small-team-mode', e, { baseDir });
    assert.deepEqual(getEvents('small-team-mode', { baseDir }), events);
  } finally {
    cleanup(dir);
  }
});

test('getScore 6 类事件按默认 weights 累加正确 (2+2+3+2+3+1=13)', () => {
  const dir = makeDir();
  try {
    const baseDir = join(dir, 'specs');
    const weights = DEFAULT_LEARNINGS_CONFIG.friction.weights;
    for (const kind of Object.keys(weights)) {
      recordEvent('c', { kind, ts: '2026-09-14T12:00:00.000Z', meta: {} }, { baseDir });
    }
    assert.equal(getScore('c', weights, { baseDir }), 13);
  } finally {
    cleanup(dir);
  }
});

test('EXECUTION.md 不存在时首次 recordEvent 自动创建文件 + 段头', () => {
  const dir = makeDir();
  try {
    const baseDir = join(dir, 'specs');
    recordEvent('c', { kind: 'verifyFail', ts: '2026-09-14T12:00:00.000Z', meta: {} }, { baseDir });
    const filePath = join(baseDir, 'c', 'EXECUTION.md');
    assert.ok(existsSync(filePath));
    const content = readFileSync(filePath, 'utf-8');
    assert.ok(content.startsWith('# EXECUTION\n'));
    assert.ok(content.includes('## friction-events\n'));
    assert.equal(getEvents('c', { baseDir }).length, 1);
  } finally {
    cleanup(dir);
  }
});

test('EXECUTION.md 存在但无段头时追加段头,不破坏既有段', () => {
  const dir = makeDir();
  try {
    const baseDir = join(dir, 'specs');
    const changeDir = join(baseDir, 'c');
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(join(changeDir, 'EXECUTION.md'), '# EXECUTION\n\n## other\nsome content\n', 'utf-8');

    recordEvent('c', { kind: 'rollback', ts: '2026-09-14T12:00:00.000Z', meta: {} }, { baseDir });

    const content = readFileSync(join(changeDir, 'EXECUTION.md'), 'utf-8');
    assert.ok(content.includes('## other\nsome content'));
    assert.ok(content.includes('## friction-events'));
    assert.ok(content.indexOf('## friction-events') > content.indexOf('## other'));
    assert.deepEqual(getEvents('c', { baseDir }), [
      { kind: 'rollback', ts: '2026-09-14T12:00:00.000Z', meta: {} },
    ]);
  } finally {
    cleanup(dir);
  }
});

test('EXECUTION.md 已有段头 + 后续段时,追加到段末不破坏其他段', () => {
  const dir = makeDir();
  try {
    const baseDir = join(dir, 'specs');
    const changeDir = join(baseDir, 'c');
    mkdirSync(changeDir, { recursive: true });
    const initial =
      '# EXECUTION\n\n' +
      '## friction-events\n' +
      '{"kind":"verifyFail","ts":"2026-09-14T12:00:00.000Z","meta":{}}\n' +
      '## other\n' +
      'keep me\n';
    writeFileSync(join(changeDir, 'EXECUTION.md'), initial, 'utf-8');

    recordEvent('c', { kind: 'aiSelfCorrect', ts: '2026-09-14T12:01:00.000Z', meta: {} }, { baseDir });

    const content = readFileSync(join(changeDir, 'EXECUTION.md'), 'utf-8');
    const frictionIdx = content.indexOf('## friction-events');
    const otherIdx = content.indexOf('## other');
    const newEventIdx = content.indexOf('"kind":"aiSelfCorrect"');
    assert.ok(frictionIdx < newEventIdx && newEventIdx < otherIdx);
    assert.ok(content.includes('## other\nkeep me'));

    const events = getEvents('c', { baseDir });
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'verifyFail');
    assert.equal(events[1].kind, 'aiSelfCorrect');
  } finally {
    cleanup(dir);
  }
});

test('未知 kind 抛异常,且不落盘', () => {
  const dir = makeDir();
  try {
    const baseDir = join(dir, 'specs');
    assert.throws(
      () => recordEvent('c', { kind: 'bogus', ts: '2026-09-14T12:00:00.000Z', meta: {} }, { baseDir }),
      /未知 friction 事件 kind/,
    );
    assert.equal(existsSync(join(baseDir, 'c', 'EXECUTION.md')), false);
  } finally {
    cleanup(dir);
  }
});

test('getScore 对未知 kind 权重视为 0', () => {
  const dir = makeDir();
  try {
    const baseDir = join(dir, 'specs');
    const changeDir = join(baseDir, 'c');
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(
      join(changeDir, 'EXECUTION.md'),
      '# EXECUTION\n\n## friction-events\n' +
        '{"kind":"unknownKind","ts":"2026-09-14T12:00:00.000Z","meta":{}}\n',
      'utf-8',
    );
    const weights = DEFAULT_LEARNINGS_CONFIG.friction.weights;
    assert.equal(getScore('c', weights, { baseDir }), 0);
  } finally {
    cleanup(dir);
  }
});

test('FRICTION_KINDS 与 config-schema 默认 weights 键严格对齐 (6 键)', () => {
  assert.deepEqual(
    FRICTION_KINDS,
    Object.keys(DEFAULT_LEARNINGS_CONFIG.friction.weights),
  );
  assert.equal(FRICTION_KINDS.length, 6);
});
