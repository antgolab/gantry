/**
 * pack-learning-injection.test.mjs — context-pack.mjs 的 BM25 recall 前置注入(T09)
 *
 * 锁定 kind: 'learning' 条目在 loadOrder 中的注入行为:
 *   - recall.enabled=true + 索引有匹配 → 注入 kind=learning 条目(附 matched/score, required=false)
 *   - recall.enabled=false / learnings.enabled=false → 不注入
 *   - 索引不存在 → 静默跳过,pack 其余部分正常
 *   - 命中条目按 score 降序排列
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPack } from '../src/lib/context-pack.mjs';
import { buildIndex, saveIndex } from '../src/lib/learnings/bm25.mjs';

const LEARNINGS_INDEX_REL = '.gantry/learnings/team/.index/bm25.json';

function createFixture(name) {
  const root = join(tmpdir(), `gantry-learn-inject-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

function writeConfig(root, learnings) {
  const config = { pipeline: 'full', learnings };
  writeFileSync(join(root, '.gantry/planning/config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

function writeProposal(root, changeId, description) {
  mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
  writeFileSync(join(root, '.gantry/specs', changeId, 'PROPOSAL.md'), description, 'utf-8');
}

function seedIndex(root, docs) {
  const index = buildIndex(docs);
  saveIndex(index, join(root, LEARNINGS_INDEX_REL));
}

function learningItems(pack) {
  return pack.loadOrder.filter((i) => i.kind === 'learning');
}

const DESCRIPTION = 'migrate auth service to token signing and add rate limiting';

test('recall.enabled=true 且索引有匹配 → 注入 kind=learning 条目(附 matched/score, required=false)', () => {
  const root = createFixture('hit');
  try {
    const changeId = 'feat-auth';
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01' });
    writeConfig(root, { enabled: true, recall: { enabled: true, relevancePreCheck: 0.3 } });
    writeProposal(root, changeId, `# PROPOSAL\n\n${DESCRIPTION}\n`);
    seedIndex(root, [
      { id: 'L-001', text: 'token signing for auth service migration', tags: ['lesson'] },
      { id: 'L-002', text: 'rate limiting for api endpoints and service', tags: ['lesson'] },
      { id: 'L-003', text: 'react component styling patterns', tags: ['knowledge'] },
    ]);

    const pack = buildPack(root);
    const items = learningItems(pack);

    assert.ok(items.length >= 1, '应至少注入一条 learning');
    const ids = items.map((i) => i.path.replace(/^.*\/([^/]+)\.md$/, '$1'));

    assert.ok(ids.includes('L-001'), '最相关条目 L-001 应注入');
    assert.ok(!ids.includes('L-003'), '无词元重叠的 L-003 不应注入');

    for (const item of items) {
      assert.equal(item.kind, 'learning');
      assert.equal(item.required, false, 'recall 结果是建议,required 必须为 false');
      assert.ok(Array.isArray(item.matched), 'matched 应为数组');
      assert.ok(item.matched.every((w) => typeof w === 'string'), 'matched 元素应为 string');
      assert.equal(typeof item.score, 'number', 'score 应为 number');
      assert.ok(item.score >= 0 && item.score <= 1, `score 应在 [0,1],实际 ${item.score}`);
    }

    // 首条为最相关条目,且 score 归一化到 1.0(top-1)
    assert.equal(items[0].path.endsWith('L-001.md'), true, '首条应为 L-001');
    assert.equal(items[0].score, 1, 'top-1 score 归一化为 1.0');
  } finally { cleanup(root); }
});

test('recall.enabled=false → 不注入', () => {
  const root = createFixture('recall-off');
  try {
    const changeId = 'feat-auth';
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01' });
    writeConfig(root, { enabled: true, recall: { enabled: false, relevancePreCheck: 0.3 } });
    writeProposal(root, changeId, `# PROPOSAL\n\n${DESCRIPTION}\n`);
    seedIndex(root, [
      { id: 'L-001', text: 'token signing for auth service migration', tags: ['lesson'] },
      { id: 'L-002', text: 'rate limiting for api endpoints and service', tags: ['lesson'] },
      { id: 'L-003', text: 'react component styling patterns', tags: ['knowledge'] },
    ]);

    const pack = buildPack(root);
    assert.equal(learningItems(pack).length, 0, 'recall.enabled=false 时不注入 learning');
  } finally { cleanup(root); }
});

test('learnings.enabled=false → 不注入', () => {
  const root = createFixture('learnings-off');
  try {
    const changeId = 'feat-auth';
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01' });
    writeConfig(root, { enabled: false, recall: { enabled: true, relevancePreCheck: 0.3 } });
    writeProposal(root, changeId, `# PROPOSAL\n\n${DESCRIPTION}\n`);
    seedIndex(root, [
      { id: 'L-001', text: 'token signing for auth service migration', tags: ['lesson'] },
      { id: 'L-002', text: 'rate limiting for api endpoints and service', tags: ['lesson'] },
      { id: 'L-003', text: 'react component styling patterns', tags: ['knowledge'] },
    ]);

    const pack = buildPack(root);
    assert.equal(learningItems(pack).length, 0, 'learnings.enabled=false 时不注入 learning');
  } finally { cleanup(root); }
});

test('索引不存在 → 静默跳过,pack 其余部分正常', () => {
  const root = createFixture('no-index');
  try {
    const changeId = 'feat-auth';
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01' });
    writeConfig(root, { enabled: true, recall: { enabled: true, relevancePreCheck: 0.3 } });
    writeProposal(root, changeId, `# PROPOSAL\n\n${DESCRIPTION}\n`);
    // 不 seedIndex —— 索引文件不存在

    const pack = buildPack(root);

    assert.equal(learningItems(pack).length, 0, '索引不存在时不注入 learning');
    // 其余 loadOrder 仍正常:agent-prompt 与 phase-prompt 都在
    assert.ok(pack.loadOrder.some((i) => i.kind === 'agent-prompt'), 'agent-prompt 仍在');
    assert.ok(pack.loadOrder.some((i) => i.kind === 'phase-prompt'), 'phase-prompt 仍在');
  } finally { cleanup(root); }
});

test('命中条目按 score 降序排列(且注入位置在 artifacts 之后)', () => {
  const root = createFixture('order');
  try {
    const changeId = 'feat-auth';
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01' });
    // relevancePreCheck=0 让两个匹配条目都保留,便于断言排序
    writeConfig(root, { enabled: true, recall: { enabled: true, relevancePreCheck: 0 } });
    writeProposal(root, changeId, `# PROPOSAL\n\ntoken signing auth service migration\n`);
    // 2 条文档 → bm25 退化走词元重叠计数路径,排序确定性(重叠数降序)
    seedIndex(root, [
      { id: 'L-001', text: 'token signing auth service migration', tags: ['lesson'] },
      { id: 'L-002', text: 'token signing', tags: ['lesson'] },
    ]);

    const pack = buildPack(root);
    const items = learningItems(pack);

    assert.equal(items.length, 2, '两个匹配条目都应注入');
    assert.equal(items[0].path.endsWith('L-001.md'), true, '重叠词更多的 L-001 应在前');
    assert.equal(items[1].path.endsWith('L-002.md'), true, 'L-002 应在后');

    for (let i = 1; i < items.length; i++) {
      assert.ok(items[i - 1].score >= items[i].score, `score 应降序: ${items[i - 1].score} >= ${items[i].score}`);
    }

    // 顺序锚定:learning 条目应在 artifacts(TASKS/DESIGN)之后出现
    const loadOrderKinds = pack.loadOrder.map((i) => i.kind);
    const firstLearningIdx = loadOrderKinds.indexOf('learning');
    const lastArtifactIdx = loadOrderKinds.lastIndexOf('artifact');
    if (firstLearningIdx !== -1 && lastArtifactIdx !== -1) {
      assert.ok(firstLearningIdx > lastArtifactIdx, 'learning 应在 artifacts 之后注入');
    }
  } finally { cleanup(root); }
});
