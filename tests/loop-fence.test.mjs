/**
 * loop-fence.test.mjs — STATE.md JSON fence 读写幂等 + 降级读
 *
 * 对齐 gantry-loop-pdlc-gantry-patch AC-1 / AC-2。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFence, writeFence, defaultFence } from '../src/lib/state.mjs';

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'gantry-fence-'));
  mkdirSync(join(root, '.gantry', 'planning'), { recursive: true });
  return root;
}

function writeProseOnly(root) {
  const prose = `# STATE — 项目协作状态

## Pipeline

- **模式**: \`full\`
- **活跃 Change**: \`test-change\`
- **当前阶段**: \`dev\`
- **当前 Wave**: \`2\`
- **当前 Task**: \`—\`
- **活跃 Agent**: \`executor\`

## 自动模式状态

- **autonomous**: \`true\`
- **已执行阶段数**: \`4 / 10\`
- **重试计数**: \`0 / 3\`
- **验证失败计数**: \`0\`
- **暂停原因**: \`—\`
- **上下文 token**: \`—\`
- **窗口使用率**: \`—\`

---
_最后更新: 2026-09-15_
`;
  writeFileSync(join(root, '.gantry', 'planning', 'STATE.md'), prose, 'utf-8');
  return prose;
}

test('AC-1 · writeFence 后 readFence 幂等', () => {
  const root = makeTempRoot();
  writeProseOnly(root);

  const fence = {
    nextStep: 'gantry-test',
    lastStageResult: {
      stage: 'dev',
      wave: 2,
      ok: true,
      checks: { unit: { pass: true } },
      acCoverage: { covered: ['AC-1'], missing: [], skipped: false },
      blockedReason: null,
      at: '2026-09-15T20:15:00+08:00',
    },
    currentWave: 2,
    previousWave: 1,
  };

  writeFence(root, fence);
  const readBack = readFence(root);

  assert.deepEqual(readBack, fence, 'fence roundtrip 必须 deep-equal');
});

test('AC-1 · writeFence 保留散文区 renderStateMd 内容', () => {
  const root = makeTempRoot();
  const originalProse = writeProseOnly(root);

  writeFence(root, { nextStep: 'gantry-review', lastStageResult: null, currentWave: null, previousWave: null });

  const after = readFileSync(join(root, '.gantry', 'planning', 'STATE.md'), 'utf-8');
  // 散文区关键字段必须保留
  assert.ok(after.includes('**活跃 Change**: `test-change`'), '活跃 Change 字段丢失');
  assert.ok(after.includes('**当前阶段**: `dev`'), '当前阶段字段丢失');
  assert.ok(after.includes('**当前 Wave**: `2`'), '当前 Wave 字段丢失');
  assert.ok(after.includes('<!-- BEGIN gantry:state -->'), 'fence BEGIN 缺失');
  assert.ok(after.includes('<!-- END gantry:state -->'), 'fence END 缺失');
});

test('AC-2 · fence 缺失时 readFence 降级返回默认对象', () => {
  const root = makeTempRoot();
  writeProseOnly(root); // 只有散文,无 fence

  const fence = readFence(root);
  assert.deepEqual(fence, defaultFence(), '无 fence 时应返回 defaultFence()');
});

test('AC-2 · STATE.md 完全不存在时 readFence 降级', () => {
  const root = makeTempRoot();
  // 目录存在但 STATE.md 未写

  const fence = readFence(root);
  assert.deepEqual(fence, defaultFence(), '无文件时应返回 defaultFence()');
});

test('AC-1 · writeFence 幂等替换(第二次写覆盖第一次)', () => {
  const root = makeTempRoot();
  writeProseOnly(root);

  writeFence(root, { nextStep: 'gantry-test', lastStageResult: null, currentWave: null, previousWave: null });
  writeFence(root, { nextStep: 'gantry-review', lastStageResult: null, currentWave: 3, previousWave: 2 });

  const readBack = readFence(root);
  assert.equal(readBack.nextStep, 'gantry-review');
  assert.equal(readBack.currentWave, 3);
  assert.equal(readBack.previousWave, 2);

  // 且 STATE.md 不能出现两份 fence
  const content = readFileSync(join(root, '.gantry', 'planning', 'STATE.md'), 'utf-8');
  const beginCount = (content.match(/BEGIN gantry:state/g) || []).length;
  assert.equal(beginCount, 1, '幂等写不应出现重复 fence');
});

test('AC-2 · fence 内 JSON 解析失败时降级', () => {
  const root = makeTempRoot();
  const broken = `# STATE

<!-- BEGIN gantry:state -->
\`\`\`json
{ this is not valid json,,,, }
\`\`\`
<!-- END gantry:state -->
`;
  writeFileSync(join(root, '.gantry', 'planning', 'STATE.md'), broken, 'utf-8');

  const fence = readFence(root);
  assert.deepEqual(fence, defaultFence(), '解析失败应降级为 defaultFence()');
});
