/**
 * context-pack.test.mjs — 锁定 v1 schema 不漂移 + 各阶段 pack 行为
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildPack,
  writeContextPack,
  readContextPack,
  PACK_PATH,
} from '../src/lib/context-pack.mjs';

function createFixture(name) {
  const root = join(tmpdir(), `gantry-pack-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

- **模式**: \`${state.pipeline || 'standard'}\`
- **活跃 Change**: \`${state.activeChange || '无'}\`
- **当前阶段**: \`${state.currentStage || 'idle'}\`
- **当前 Wave**: \`${state.currentWave ?? '—'}\`
- **当前 Task**: \`${state.currentTask ?? '—'}\`
- **活跃 Agent**: \`${state.activeAgent ?? '—'}\`

## Checkpoints

| ID | Stage | Type | Status | Created |
|----|-------|------|--------|---------|

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
  writeFileSync(join(root, '.gantry/planning/config.json'), JSON.stringify(config), 'utf-8');
}

// === Schema 不变性 ===

test('schema: pack 顶层有全部 v2 字段', () => {
  const root = createFixture('schema');
  try {
    writeState(root, { currentStage: 'idle' });
    const pack = buildPack(root);
    const required = ['schemaVersion', 'generatedAt', 'stage', 'changeId', 'pipeline', 'taskId', 'loadOrder', 'checklists', 'lessons', 'retryHistory', 'next'];
    for (const f of required) {
      assert.ok(f in pack, `缺字段 ${f}`);
    }
    assert.equal(pack.schemaVersion, 2);
  } finally { cleanup(root); }
});

test('schema: idle 阶段 changeId/taskId 为 null', () => {
  const root = createFixture('idle');
  try {
    writeState(root, { currentStage: 'idle' });
    const pack = buildPack(root);
    assert.equal(pack.changeId, null);
    assert.equal(pack.taskId, null);
    assert.deepEqual(pack.lessons, []);
  } finally { cleanup(root); }
});

test('schema: 不含禁止字段 (suggestedModel/agent/complexity/promptText)', () => {
  const root = createFixture('forbidden');
  try {
    writeState(root, { currentStage: 'idle' });
    const pack = buildPack(root);
    const forbidden = ['suggestedModel', 'suggestedAgent', 'complexity', 'riskLevel', 'retryStrategy', 'promptText', 'systemPrompt', 'userPrompt'];
    for (const f of forbidden) {
      assert.ok(!(f in pack), `pack 不应有 ${f}`);
    }
  } finally { cleanup(root); }
});

// === loadOrder ===

test('loadOrder: dev 阶段含 phase + 上游工件 + LESSONS,不默认加载核心长文档', () => {
  const root = createFixture('load-dev');
  try {
    const changeId = 'feat-x';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'METHODOLOGY.md'), '# methodology', 'utf-8');
    writeFileSync(join(root, 'docs', 'RULES.md'), '# rules', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'CHANGE.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'REQUIREMENT.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'DESIGN.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASK.md'), '<task id="T01"></task>', 'utf-8');
    writeFileSync(join(root, '.gantry/specs/LESSONS.md'), '#', 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'standard' });

    const pack = buildPack(root);
    const paths = pack.loadOrder.map(i => i.path);

    assert.ok(!paths.includes('docs/METHODOLOGY.md'), 'METHODOLOGY.md 不应默认进入运行时 loadOrder');
    assert.ok(!paths.includes('docs/RULES.md'), 'RULES.md 不应默认进入运行时 loadOrder');
    assert.ok(paths.includes('.gantry/core/phases/4-dev.md'), 'phase prompt 缺失');
    assert.ok(paths.some(p => p.endsWith('TASK.md')), 'TASK.md 缺失');
    assert.ok(paths.some(p => p.endsWith('DESIGN.md')), 'DESIGN.md 缺失');
    assert.ok(paths.some(p => p.endsWith('LESSONS.md')), 'LESSONS.md 缺失');

    const designItem = pack.loadOrder.find(i => i.path.endsWith('DESIGN.md'));
    assert.ok(designItem.focus, 'DESIGN.md 应有 focus 段');
  } finally { cleanup(root); }
});

test('loadOrder: light pipeline 跳过 requirement/design 工件', () => {
  const root = createFixture('load-light');
  try {
    const changeId = 'fix-y';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'METHODOLOGY.md'), '# methodology', 'utf-8');
    writeFileSync(join(root, 'docs', 'RULES.md'), '# rules', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'CHANGE.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASK.md'), '<task id="T01"></task>', 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'light' });

    const pack = buildPack(root);
    const paths = pack.loadOrder.map(i => i.path);
    assert.ok(paths.some(p => p.endsWith('CHANGE.md')), 'CHANGE.md 应在 light 中');
    assert.ok(!paths.some(p => p.endsWith('REQUIREMENT.md')), 'REQUIREMENT.md 不应在 light 中');
    assert.ok(!paths.some(p => p.endsWith('DESIGN.md')), 'DESIGN.md 不应在 light 中');
  } finally { cleanup(root); }
});

test('loadOrder: dev 恢复时强制带入 PROGRESS.md 反重复上下文', () => {
  const root = createFixture('load-progress');
  try {
    const changeId = 'resume-z';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'METHODOLOGY.md'), '# methodology', 'utf-8');
    writeFileSync(join(root, 'docs', 'RULES.md'), '# rules', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'CHANGE.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'REQUIREMENT.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'DESIGN.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASK.md'), '<task id="T07"></task>', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'T07-PROGRESS.md'),
      '# PROGRESS\n\n## 已排除的方案（反重复关键）\n\n- X-1\n\n## 当前正在做（清窗那一刻的状态）\n\n继续修复\n', 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T07', pipeline: 'standard' });

    const pack = buildPack(root);
    const progress = pack.loadOrder.find(i => i.path.endsWith('T07-PROGRESS.md'));

    assert.ok(progress, '恢复场景应加载 PROGRESS.md');
    assert.equal(progress.kind, 'progress');
    assert.equal(progress.required, true);
    assert.deepEqual(progress.focus, [
      '## 已排除的方案（反重复关键）',
      '## 当前正在做（清窗那一刻的状态）',
    ]);
  } finally { cleanup(root); }
});

// === checklists ===

test('checklists: dev/UI 任务触发 1.6,非 UI 不触发', () => {
  const root = createFixture('cl-ui');
  try {
    const changeId = 'add-modal';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASK.md'),
      `<task id="T01">
<title>Add modal component</title>
<write_files>
- src/components/Modal.tsx
</write_files>
</task>`, 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'standard' });

    const pack = buildPack(root);
    const ui = pack.checklists.find(c => c.id === '1.6-ui-task');
    assert.ok(ui, '应有 1.6-ui-task');
    assert.equal(ui.trigger, true, 'UI 任务应触发 1.6');

    const schema = pack.checklists.find(c => c.id === '1.7-schema');
    assert.equal(schema.trigger, false, '非 schema 任务不触发 1.7');

    const breaking = pack.checklists.find(c => c.id === '1.8-breaking-change');
    assert.equal(breaking.trigger, false, '新建任务不触发 1.8');

    // v2 非对称信任:每条都有 confidence；命中=high，关键词未命中=low
    for (const c of pack.checklists) {
      assert.ok(c.confidence === 'high' || c.confidence === 'low', `${c.id} 缺 confidence`);
    }
    assert.equal(ui.confidence, 'high', 'UI 命中应 high');
    assert.equal(schema.confidence, 'low', 'schema 关键词未命中应 low(可能漏,AI 复核)');
    assert.equal(breaking.confidence, 'low', 'breaking 关键词未命中应 low');
  } finally { cleanup(root); }
});

test('checklists: v2 确定性类 false 为 high、关键词类 false 为 low', () => {
  const root = createFixture('cl-confidence');
  try {
    const changeId = 'plain-task';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    // 非 UI/schema/breaking 的纯后端任务:1.6/1.7/1.8 全 false
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASK.md'),
      `<task id="T01"><title>实现分页逻辑</title><write_files>
- src/service/pager.ts
</write_files></task>`, 'utf-8');
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'standard' });

    const pack = buildPack(root);
    const byId = Object.fromEntries(pack.checklists.map(c => [c.id, c]));

    // 1.5 LESSONS 不存在 → false 但确定性 → high(确定不用跑)
    assert.equal(byId['1.5-lessons-grep'].trigger, false);
    assert.equal(byId['1.5-lessons-grep'].confidence, 'high', 'LESSONS 存在性是事实,false 应 high');

    // 1.7/1.8 关键词未命中 → false + low(可能漏)
    assert.equal(byId['1.7-schema'].confidence, 'low');
    assert.equal(byId['1.8-breaking-change'].confidence, 'low');
  } finally { cleanup(root); }
});

test('checklists: dev 缺少 taskId 时返回显式 fresh-context 阻断信号', () => {
  const root = createFixture('cl-no-task');
  try {
    const changeId = 'missing-task';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: null, pipeline: 'standard' });

    const pack = buildPack(root);
    assert.equal(pack.taskId, null);
    assert.equal(pack.checklists[0].id, 'task-not-selected');
    assert.equal(pack.checklists[0].trigger, false);
    assert.match(pack.checklists[0].reason, /taskId 未设置/);
  } finally { cleanup(root); }
});

test('checklists: schema 任务命中 1.7', () => {
  const root = createFixture('cl-schema');
  try {
    const changeId = 'add-table';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASK.md'),
      `<task id="T01">
<title>新增表 notifications</title>
<write_files>
- prisma/schema.prisma
- prisma/migrations/init/migration.sql
</write_files>
</task>`, 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'standard' });

    const pack = buildPack(root);
    const schema = pack.checklists.find(c => c.id === '1.7-schema');
    assert.equal(schema.trigger, true);
  } finally { cleanup(root); }
});

test('checklists: 破坏性变更 action 命中 1.8', () => {
  const root = createFixture('cl-breaking');
  try {
    const changeId = 'remove-old';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASK.md'),
      `<task id="T01">
<title>删除 formatLegacyDate 函数</title>
<write_files>
- src/utils/legacy-date.ts
</write_files>
</task>`, 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'standard' });

    const pack = buildPack(root);
    const breaking = pack.checklists.find(c => c.id === '1.8-breaking-change');
    assert.equal(breaking.trigger, true);
  } finally { cleanup(root); }
});

test('checklists: 英文关键词词边界匹配,不因子串误报(止血缺陷一)', () => {
  const root = createFixture('cl-wordbound');
  try {
    const changeId = 'confront-issue';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    // "confront" 含子串 font，"iconic" 含 icon，"delegate" 含子串但非 delete；
    // 词边界匹配下都不应触发 UI(1.6) 或 breaking(1.8)
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASK.md'),
      `<task id="T01"><title>confront the iconic delegate flow</title><write_files>
- src/service/flow.ts
</write_files></task>`, 'utf-8');
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'standard' });

    const pack = buildPack(root);
    const byId = Object.fromEntries(pack.checklists.map(c => [c.id, c]));
    assert.equal(byId['1.6-ui-task'].trigger, false, '"confront/iconic" 不应误触发 UI');
    assert.equal(byId['1.8-breaking-change'].trigger, false, '"delegate" 不应误触发 breaking');
  } finally { cleanup(root); }
});

test('checklists: 独立英文关键词仍正常命中', () => {
  const root = createFixture('cl-wordbound-hit');
  try {
    const changeId = 'add-icon';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASK.md'),
      `<task id="T01"><title>add an icon to the header</title><write_files>
- src/service/x.ts
</write_files></task>`, 'utf-8');
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'standard' });

    const pack = buildPack(root);
    const ui = pack.checklists.find(c => c.id === '1.6-ui-task');
    assert.equal(ui.trigger, true, '独立词 "icon" 应正常命中 UI');
  } finally { cleanup(root); }
});

test('checklists: change 阶段含 0.4 架构检测', () => {
  const root = createFixture('cl-change');
  try {
    writeState(root, { currentStage: 'change', activeChange: 'foo' });
    const pack = buildPack(root);
    const arch = pack.checklists.find(c => c.id === '0.4-architecture-detection');
    assert.ok(arch);
    assert.equal(arch.trigger, true);
  } finally { cleanup(root); }
});

test('checklists: change 阶段 PROPOSAL 有未决问题时含继续澄清触发器', () => {
  const root = createFixture('cl-change-open-q');
  try {
    const changeId = 'foo';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeFileSync(join(root, '.gantry/specs', changeId, 'PROPOSAL.md'),
      '# PROPOSAL\n\n## 待澄清问题\n\n- [] 跟随系统还是手动？\n\n---\n', 'utf-8');
    writeState(root, { currentStage: 'change', activeChange: changeId });
    const pack = buildPack(root);
    const q = pack.checklists.find(c => c.id === '1-resolve-open-questions');
    assert.ok(q, '应含继续澄清触发器');
    assert.equal(q.trigger, true);
    assert.match(q.reason, /未决问题/);
  } finally { cleanup(root); }
});

test('checklists: change 阶段 PROPOSAL 待澄清清空后不含触发器', () => {
  const root = createFixture('cl-change-no-q');
  try {
    const changeId = 'foo';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeFileSync(join(root, '.gantry/specs', changeId, 'PROPOSAL.md'),
      '# PROPOSAL\n\n## 待澄清问题\n\n无\n\n---\n', 'utf-8');
    writeState(root, { currentStage: 'change', activeChange: changeId });
    const pack = buildPack(root);
    const q = pack.checklists.find(c => c.id === '1-resolve-open-questions');
    assert.equal(q, undefined, '清空后不应有继续澄清触发器');
  } finally { cleanup(root); }
});

// === next 命令 ===

test('next: dev 含 done + next 链', () => {
  const root = createFixture('next-dev');
  try {
    const changeId = 'foo';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASK.md'),
      '<task id="T05"></task>', 'utf-8');
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T05' });
    const pack = buildPack(root);
    assert.ok(pack.next.onSuccess.includes('done T05'));
    assert.ok(pack.next.onSuccess.includes('next'));
  } finally { cleanup(root); }
});

// === 写盘 / 读盘 ===

test('write/read: pack 落地到 .gantry/planning/context-pack.json', () => {
  const root = createFixture('write');
  try {
    writeState(root, { currentStage: 'idle' });
    const written = writeContextPack(root);
    const read = readContextPack(root);
    assert.equal(read.schemaVersion, written.schemaVersion);
    assert.equal(read.stage, written.stage);
    assert.ok(existsSync(join(root, PACK_PATH)));
  } finally { cleanup(root); }
});

test('确定性: 同输入两次 build 结果一致 (除 generatedAt)', () => {
  const root = createFixture('det');
  try {
    writeState(root, { currentStage: 'idle' });
    const a = buildPack(root);
    const b = buildPack(root);
    delete a.generatedAt;
    delete b.generatedAt;
    assert.deepEqual(a, b);
  } finally { cleanup(root); }
});
