/**
 * review-lane-isolation.test.mjs — REVIEW lane 上下文隔离 gate (T14)
 *
 * 锁定 checkPack 纯判定 + context-pack.mjs 的 review 阶段接线:
 *   - 污染 pack(kind=dev-log / path 命中 dev/ / execution.log / task-*.log)→ violations 非空
 *   - 干净 pack → ok=true
 *   - strict=false → 污染也 ok=true(仍收集 violations 供审计)
 *   - 非 review 阶段 → guard 不介入
 *   - config.reviewLaneStrict=false → review 阶段跳过 guard
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPack } from '../src/lib/review-lane-guard.mjs';
import { buildPack } from '../src/lib/context-pack.mjs';

function createFixture(name) {
  const root = join(tmpdir(), `gantry-rlg-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, '.gantry/planning'), { recursive: true });
  mkdirSync(join(root, '.gantry/specs'), { recursive: true });
  return root;
}

function cleanup(root) {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

function writeState(root, state) {
  const content = `# STATE — 项目协作状态

## Pipeline

- **模式**: \`${state.pipeline || 'full'}\`
- **活跃 Change**: \`${state.activeChange || '无'}\`
- **当前阶段**: \`${state.currentStage || 'idle'}\`
- **当前 Wave**: \`${state.currentWave ?? '—'}\`
- **当前 Task**: \`${state.currentTask ?? '—'}\`
- **活跃 Agent**: \`${state.activeAgent ?? '—'}\`

## 自动模式状态

- **autonomous**: \`false\`
- **已执行阶段数**: \`0 / 3\`
- **重试计数**: \`${state.retries ?? 0} / 3\`
- **暂停原因**: \`${state.pauseReason ?? '—'}\`
- **上下文 token**: \`—\`
- **窗口使用率**: \`—\`
`;
  writeFileSync(join(root, '.gantry/planning/STATE.md'), content, 'utf-8');
}

function writeConfig(root, config) {
  writeFileSync(join(root, '.gantry/planning/config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

// === checkPack 纯函数 ===

test('污染 pack(含 kind:dev-log 条目)→ violations 非空, ok=false', () => {
  const pack = {
    loadOrder: [
      { path: '.gantry/specs/c/SPEC.md', kind: 'artifact', required: true },
      { path: '.gantry/specs/c/EXECUTION.md', kind: 'dev-log', required: false },
    ],
  };
  const res = checkPack(pack, { strict: true });
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 1);
  assert.equal(res.violations[0].kind, 'dev-log');
  assert.equal(res.violations[0].path, '.gantry/specs/c/EXECUTION.md');
  assert.ok(typeof res.violations[0].reason === 'string' && res.violations[0].reason.length > 0);
});

test('污染 pack(path 命中 dev/ / execution.log / task-*.log)→ violations 非空', () => {
  const paths = [
    '.gantry/dev/scratch.log',
    '.gantry/planning/execution.log',
    '.gantry/planning/task-T01.log',
  ];
  const pack = {
    loadOrder: paths.map((p, i) => ({ path: p, kind: i === 0 ? 'context-doc' : 'artifact', required: false })),
  };
  const res = checkPack(pack, { strict: true });
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 3);
  for (const v of res.violations) {
    assert.ok(paths.includes(v.path));
    assert.ok(typeof v.kind === 'string');
    assert.ok(typeof v.reason === 'string' && v.reason.length > 0);
  }
});

test('干净 pack → ok=true, violations 空', () => {
  const pack = {
    loadOrder: [
      { path: '.gantry/specs/c/SPEC.md', kind: 'artifact', required: true },
      { path: '.gantry/core/phases/6-review.md', kind: 'phase-prompt', required: true },
    ],
  };
  const res = checkPack(pack, { strict: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.violations, []);
});

test('strict=false → 即使污染也 ok=true(仍收集 violations 供审计)', () => {
  const pack = {
    loadOrder: [
      { path: '.gantry/dev/scratch.log', kind: 'dev-log', required: false },
    ],
  };
  const res = checkPack(pack, { strict: false });
  assert.equal(res.ok, true);
  assert.equal(res.violations.length, 1);
});

test('checkPack 对无 loadOrder 的 pack 返回 ok=true, violations 空', () => {
  const res = checkPack({}, { strict: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.violations, []);
});

// === context-pack.mjs 接线 ===

test('非 review 阶段 → guard 不介入 (dev 阶段无 warnings 字段)', () => {
  const root = createFixture('dev');
  try {
    writeState(root, { currentStage: 'dev' });
    const pack = buildPack(root, { stage: 'dev' });
    assert.equal('warnings' in pack, false);
  } finally {
    cleanup(root);
  }
});

test('review 阶段 clean pack → 无 warnings 字段', () => {
  const root = createFixture('review-clean');
  try {
    writeState(root, { currentStage: 'review' });
    const pack = buildPack(root, { stage: 'review' });
    assert.equal('warnings' in pack, false);
  } finally {
    cleanup(root);
  }
});

test('review 阶段 config.reviewLaneStrict=false → 跳过 guard(无 warnings 字段)', () => {
  const root = createFixture('review-strict-off');
  try {
    writeState(root, { currentStage: 'review' });
    writeConfig(root, { reviewLaneStrict: false });
    const pack = buildPack(root, { stage: 'review' });
    assert.equal('warnings' in pack, false);
  } finally {
    cleanup(root);
  }
});
