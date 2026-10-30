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

test('loadOrder: 各阶段包含对应 agent prompt', () => {
  const cases = [
    ['change', 'planner.md'],
    ['requirement', 'planner.md'],
    ['task', 'planner.md'],
    ['design', 'architect.md'],
    ['dev', 'executor.md'],
    ['fast', 'executor.md'],
    ['test', 'reviewer.md'],
    ['review', 'reviewer.md'],
    ['integration', 'integrator.md'],
  ];

  for (const [stage, agentFile] of cases) {
    const root = createFixture(`agent-${stage}`);
    try {
      writeState(root, { currentStage: stage, activeChange: 'feat-x' });
      const pack = buildPack(root);
      assert.equal(pack.loadOrder[0].kind, 'agent-prompt', `${stage} 应先加载 agent prompt`);
      assert.equal(pack.loadOrder[0].path, `.gantry/core/agents/${agentFile}`);
      assert.equal(pack.loadOrder[0].required, true);
    } finally { cleanup(root); }
  }
});

test('loadOrder: idle 阶段不加载 agent prompt', () => {
  const root = createFixture('agent-idle');
  try {
    writeState(root, { currentStage: 'idle' });
    const pack = buildPack(root);
    assert.equal(pack.loadOrder.some(i => i.kind === 'agent-prompt'), false);
  } finally { cleanup(root); }
});

test('loadOrder: 各阶段仅消费职责所需工件，integration 包含审查结果', () => {
  const root = createFixture('stage-inputs');
  try {
    const changeId = 'feat-x';
    const dir = join(root, '.gantry/specs', changeId);
    mkdirSync(dir, { recursive: true });
    for (const name of ['PROPOSAL', 'SPEC', 'DESIGN', 'TASKS', 'TEST', 'REVIEW', 'EXECUTION']) {
      writeFileSync(join(dir, `${name}.md`), `# ${name}\n`);
    }
    const cases = {
      requirement: ['PROPOSAL'],
      design: ['SPEC'],
      task: ['SPEC', 'DESIGN'],
      test: ['SPEC', 'TASKS'],
      review: ['SPEC', 'DESIGN', 'TASKS', 'TEST'],
      integration: ['SPEC', 'DESIGN', 'TEST', 'REVIEW'],
    };
    for (const [stage, names] of Object.entries(cases)) {
      writeState(root, { currentStage: stage, activeChange: changeId });
      const pack = buildPack(root);
      assert.deepEqual(pack.loadOrder.filter(item => item.kind === 'artifact').map(item => item.path),
        names.map(name => `.gantry/specs/${changeId}/${name}.md`), stage);
      assert.equal(pack.warnings?.length ?? 0, 0, `${stage} 不应泄漏 DEV 上下文`);
    }
  } finally { cleanup(root); }
});

test('loadOrder: dev 自足任务只加载当前 TASK、聚焦 DESIGN 和 LESSONS', () => {
  const root = createFixture('load-dev');
  try {
    const changeId = 'feat-x';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'METHODOLOGY.md'), '# methodology', 'utf-8');
    writeFileSync(join(root, 'docs', 'RULES.md'), '# rules', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'PROPOSAL.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'SPEC.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'DESIGN.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'), `<task id="T01">
<verify>node --test tests/unit.test.mjs</verify>
<done>目标行为通过测试，且现有行为无回归</done>
</task>`, 'utf-8');
    writeFileSync(join(root, '.gantry/specs/LESSONS.md'), '#', 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'full' });

    const pack = buildPack(root);
    const paths = pack.loadOrder.map(i => i.path);

    assert.equal(pack.loadOrder[0].kind, 'agent-prompt');
    assert.equal(pack.loadOrder[0].path, '.gantry/core/agents/executor.md');
    assert.equal(pack.loadOrder[1].kind, 'phase-prompt');
    assert.ok(!paths.includes('docs/METHODOLOGY.md'), 'METHODOLOGY.md 不应默认进入运行时 loadOrder');
    assert.ok(!paths.includes('docs/RULES.md'), 'RULES.md 不应默认进入运行时 loadOrder');
    assert.ok(paths.includes('.gantry/core/phases/4-dev.md'), 'phase prompt 缺失');
    assert.ok(!paths.some(p => p.endsWith('PROPOSAL.md')), 'DEV 不应加载 PROPOSAL.md');
    assert.ok(!paths.some(p => p.endsWith('SPEC.md')), '自足任务不应加载 SPEC.md');
    assert.ok(paths.some(p => p.endsWith('TASKS.md')), 'TASKS.md 缺失');
    assert.ok(paths.some(p => p.endsWith('DESIGN.md')), 'DESIGN.md 缺失');
    assert.ok(paths.some(p => p.endsWith('LESSONS.md')), 'LESSONS.md 缺失');

    const tasksItem = pack.loadOrder.find(i => i.path.endsWith('TASKS.md'));
    assert.deepEqual(tasksItem.focus, ['<task id="T01"']);
    const designItem = pack.loadOrder.find(i => i.path.endsWith('DESIGN.md'));
    assert.deepEqual(designItem.focus, ['## 0. 技术栈选定', '## 0.5 既有架构对齐']);
  } finally { cleanup(root); }
});

test('loadOrder: dev 任务缺少 verify 或 done 时回退加载 SPEC，但仍不加载 PROPOSAL', () => {
  const root = createFixture('load-dev-spec-fallback');
  try {
    const changeId = 'feat-x';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeFileSync(join(root, '.gantry/specs', changeId, 'PROPOSAL.md'), '# proposal', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'SPEC.md'), '# spec', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'DESIGN.md'), '# design', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'), `<task id="T01">
<verify>node --test tests/unit.test.mjs</verify>
</task>`, 'utf-8');
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'full' });

    const pack = buildPack(root);
    const paths = pack.loadOrder.map(i => i.path);

    assert.ok(paths.some(p => p.endsWith('SPEC.md')), '非自足任务应回退加载 SPEC.md');
    assert.ok(!paths.some(p => p.endsWith('PROPOSAL.md')), 'DEV 即使回退也不应加载 PROPOSAL.md');
  } finally { cleanup(root); }
});

function writeLightJson(root, changeId, scope) {
  mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
  writeFileSync(join(root, '.gantry/specs', changeId, 'light.json'), JSON.stringify({
    intent: { goal: '修复 README 拼写', accept: [], scope },
    baseline: {},
    createdAt: new Date().toISOString(),
  }));
}

test('loadOrder: fast 阶段加载 executor、F-fast 和 light.json 意图', () => {
  const root = createFixture('fast-stage');
  try {
    const changeId = 'tiny-fix';
    writeLightJson(root, changeId, ['README.md']);
    writeState(root, { currentStage: 'fast', activeChange: changeId, pipeline: 'light' });
    const pack = buildPack(root);
    assert.equal(pack.pipeline, 'light', 'light.json 存在时保持 light@fast');
    assert.equal(pack.loadOrder[0].path, '.gantry/core/agents/executor.md');
    assert.ok(pack.loadOrder.some(item => item.path.endsWith('/F-fast.md')));
    assert.ok(pack.loadOrder.some(item => item.path.endsWith('/light.json')), 'light 意图应进 loadOrder');
    assert.ok(!pack.loadOrder.some(item => item.path.endsWith('/PROPOSAL.md')), 'light 不生成也不加载 PROPOSAL');
    const intent = pack.checklists.find(item => item.id === 'fast-light-intent');
    assert.ok(intent, '缺 fast-light-intent 清单');
    assert.equal(intent.trigger, false, `合法范围不应触发: ${intent.reason}`);
    assert.ok(pack.checklists.some(item => item.id === 'fast-verify-evidence' && item.trigger));
  } finally { cleanup(root); }
});

test('checklists: fast 缺 light.json 或范围非法时 light 意图清单触发', () => {
  const missing = createFixture('fast-missing-intent');
  try {
    const changeId = 'tiny-fix';
    mkdirSync(join(missing, '.gantry/specs', changeId), { recursive: true });
    writeState(missing, { currentStage: 'fast', activeChange: changeId, pipeline: 'light' });
    const intent = buildPack(missing).checklists.find(item => item.id === 'fast-light-intent');
    assert.equal(intent.trigger, true);
    assert.match(intent.reason, /light\.json/);
  } finally { cleanup(missing); }

  const invalid = createFixture('fast-invalid-scope');
  try {
    const changeId = 'tiny-fix';
    writeLightJson(invalid, changeId, ['src/**']);
    writeState(invalid, { currentStage: 'fast', activeChange: changeId, pipeline: 'light' });
    const intent = buildPack(invalid).checklists.find(item => item.id === 'fast-light-intent');
    assert.equal(intent.trigger, true);
    assert.match(intent.reason, /intent-scope-invalid/);
  } finally { cleanup(invalid); }
});

test('loadOrder: 存量 light@integration 归一化为 full 并按 full 加载(AC-14)', () => {
  const root = createFixture('light-integration');
  try {
    const changeId = 'tiny-fix';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeFileSync(join(root, '.gantry/specs', changeId, 'PROPOSAL.md'), '# PROPOSAL\n');
    writeFileSync(join(root, '.gantry/specs', changeId, 'SPEC.md'), '# SPEC\n');
    writeFileSync(join(root, '.gantry/specs', changeId, 'EXECUTION.md'), '# EXECUTION\nverify: PASS\n');
    writeState(root, { currentStage: 'integration', activeChange: changeId, pipeline: 'light' });
    const pack = buildPack(root);
    assert.equal(pack.pipeline, 'full', '旧 light@integration 应归一化为 full');
    assert.equal(pack.stage, 'integration');
    const paths = pack.loadOrder.map(item => item.path);
    assert.ok(!paths.some(path => path.endsWith('/PROPOSAL.md')), '归一化后也不累积无关历史');
    assert.ok(paths.some(path => path.endsWith('/SPEC.md')));
    assert.ok(!paths.some(path => path.endsWith('/EXECUTION.md')), 'full@integration 上游不含 EXECUTION');
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
    writeFileSync(join(root, '.gantry/specs', changeId, 'PROPOSAL.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'SPEC.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'DESIGN.md'), '#', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'), '<task id="T07"></task>', 'utf-8');
    writeFileSync(join(root, '.gantry/specs', changeId, 'T07-PROGRESS.md'),
      '# PROGRESS\n\n## 已排除的方案（反重复关键）\n\n- X-1\n\n## 当前正在做（清窗那一刻的状态）\n\n继续修复\n', 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T07', pipeline: 'full' });

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
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'),
      `<task id="T01">
<title>Add modal component</title>
<write_files>
- src/components/Modal.tsx
</write_files>
</task>`, 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'full' });

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

test('checklists: 1.5 在只有 .context/MANIFEST.md(无 LESSONS)时仍触发', () => {
  const root = createFixture('cl-context-only');
  try {
    const changeId = 'add-cache';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'),
      `<task id="T01">
<title>查用户信息加缓存</title>
<write_files>
- internal/dao/dao.go
</write_files>
</task>`, 'utf-8');
    // 只有 .context/MANIFEST.md,不建 LESSONS.md(vas 的真实形态)
    mkdirSync(join(root, '.context'), { recursive: true });
    writeFileSync(join(root, '.context/MANIFEST.md'), '# 团队知识索引\n', 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'full' });

    const pack = buildPack(root);
    const c15 = pack.checklists.find(c => c.id === '1.5-lessons-grep');
    assert.ok(c15, '应有 1.5-lessons-grep');
    assert.equal(c15.trigger, true, '有 .context/MANIFEST.md 时 1.5 必须触发(团队约定)');
    assert.match(c15.reason, /MANIFEST/, 'reason 应指明命中来源是 MANIFEST');
  } finally { cleanup(root); }
});

test('checklists: 1.5 在既无 .context 也无 LESSONS 时不触发', () => {
  const root = createFixture('cl-neither');
  try {
    const changeId = 'plain';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'),
      `<task id="T01">
<title>纯后端任务</title>
<write_files>
- internal/svc/foo.go
</write_files>
</task>`, 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'full' });

    const pack = buildPack(root);
    const c15 = pack.checklists.find(c => c.id === '1.5-lessons-grep');
    assert.equal(c15.trigger, false, '两者都无时 1.5 不触发');
  } finally { cleanup(root); }
});

test('checklists: v2 确定性类 false 为 high、关键词类 false 为 low', () => {
  const root = createFixture('cl-confidence');
  try {
    const changeId = 'plain-task';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    // 非 UI/schema/breaking 的纯后端任务:1.6/1.7/1.8 全 false
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'),
      `<task id="T01"><title>实现分页逻辑</title><write_files>
- src/service/pager.ts
</write_files></task>`, 'utf-8');
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'full' });

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
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: null, pipeline: 'full' });

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
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'),
      `<task id="T01">
<title>新增表 notifications</title>
<write_files>
- prisma/schema.prisma
- prisma/migrations/init/migration.sql
</write_files>
</task>`, 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'full' });

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
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'),
      `<task id="T01">
<title>删除 formatLegacyDate 函数</title>
<write_files>
- src/utils/legacy-date.ts
</write_files>
</task>`, 'utf-8');

    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'full' });

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
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'),
      `<task id="T01"><title>confront the iconic delegate flow</title><write_files>
- src/service/flow.ts
</write_files></task>`, 'utf-8');
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'full' });

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
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'),
      `<task id="T01"><title>add an icon to the header</title><write_files>
- src/service/x.ts
</write_files></task>`, 'utf-8');
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'full' });

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

// === 阶段完成后的机械推进命令 ===

test('next commands: dev worker 只标记 done，不推进阶段', () => {
  const root = createFixture('advance-dev');
  try {
    const changeId = 'foo';
    mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
    writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'),
      '<task id="T05"></task>', 'utf-8');
    writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T05' });
    const pack = buildPack(root);
    assert.equal(pack.next.onSuccess, 'gantry done T05');
    assert.equal(pack.next.onFailure, null);
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

// === lessons 检索(锁死三个曾令检索失效的坏点)===

// 构造一个 dev 阶段 + LESSONS + 单任务的 fixture,任务文本可控。
function makeLessonsFixture(name, { lessons, taskBody, writeFiles = [] }) {
  const root = createFixture(name);
  const changeId = 'feat-x';
  mkdirSync(join(root, '.gantry/specs', changeId), { recursive: true });
  writeFileSync(join(root, '.gantry/specs/LESSONS.md'), lessons, 'utf-8');
  const wf = writeFiles.length ? `\n<write_files>${writeFiles.join(',')}</write_files>` : '';
  writeFileSync(join(root, '.gantry/specs', changeId, 'TASKS.md'),
    `<task id="T01">\n${taskBody}${wf}\n<verify>node --test</verify>\n<done>ok</done>\n</task>`, 'utf-8');
  writeState(root, { currentStage: 'dev', activeChange: changeId, currentTask: 'T01', pipeline: 'full' });
  return root;
}

// 坏点 A:模板条目用 ### 三级标题,旧 split 只认 ## 二级 → blocks=0 恒空。
test('lessons: 三级标题 ### L-NNN 能被检索(修复检索恒空)', () => {
  const root = makeLessonsFixture('lesson-h3', {
    lessons: `### L-001 · [arch] 主题切换 FOUC
- **状态**: active
- **关键词**: theme dark-mode localstorage
`,
    taskBody: '实现 dark-mode 主题切换持久化',
  });
  try {
    const pack = buildPack(root);
    assert.ok(pack.lessons.some(l => l.id === 'L-001'), '三级标题条目应被命中');
  } finally { cleanup(root); }
});

// 坏点 B:关键词字段 × 任务文本子串求交——相关命中、无关降噪。
test('lessons: 按「关键词」字段与任务文本求交,无关条目不命中', () => {
  const root = makeLessonsFixture('lesson-kw', {
    lessons: `### L-001 · [ux] 主题 FOUC
- **状态**: active
- **关键词**: theme dark-mode localstorage

### L-002 · [lib] axios 重试
- **状态**: active
- **关键词**: axios interceptor retry
`,
    taskBody: '实现 dark-mode 主题切换',
    writeFiles: ['src/theme/localstorage.ts'],
  });
  try {
    const pack = buildPack(root);
    const ids = pack.lessons.map(l => l.id);
    assert.ok(ids.includes('L-001'), '主题相关条目应命中');
    assert.ok(!ids.includes('L-002'), 'axios 无关条目应被降噪');
    const l1 = pack.lessons.find(l => l.id === 'L-001');
    assert.ok(l1.matchedKeywords.includes('theme'), 'matchedKeywords 应含交集词');
  } finally { cleanup(root); }
});

// 坏点 C:粗体状态字段 `- **状态**: deprecated` 曾因正则错配恒被当 active。
test('lessons: deprecated/superseded 条目被过滤(粗体状态字段)', () => {
  const root = makeLessonsFixture('lesson-status', {
    lessons: `### L-001 · [arch] 仍生效
- **状态**: active
- **关键词**: theme migration

### L-002 · [data] 已废弃
- **状态**: deprecated:old-stack
- **关键词**: theme migration

### L-003 · [arch] 被取代
- **状态**: superseded-by:L-001
- **关键词**: theme migration
`,
    taskBody: 'theme migration 相关任务',
  });
  try {
    const pack = buildPack(root);
    const ids = pack.lessons.map(l => l.id);
    assert.deepEqual(ids, ['L-001'], '仅 active 条目应返回,deprecated/superseded 过滤');
  } finally { cleanup(root); }
});

function taskRecordFixture(root, taskId, { repairsUsed = 2, reason = 'focused assertion failed' } = {}) {
  const path = join(root, '.gantry/specs/demo/execution');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, `${taskId}.json`), JSON.stringify({
    schemaVersion: 1, revision: 1, changeId: 'demo', taskId, contract: {}, baseline: {}, repairsUsed,
    attempt: { id: 'attempt', repairOrdinal: repairsUsed, lifecycle: 'returned', externalRetriesUsed: 0, reservedAt: '2026-10-29T00:00:00Z' },
    failure: { kind: 'verify-failed', reason, at: '2026-10-29T00:01:00Z' }, receipt: null,
  }));
}

test('dev retry history is task record truth, never unrelated STATE retries', () => {
  const root = createFixture('task-retry-history');
  try {
    writeState(root, { currentStage: 'dev', activeChange: 'demo', currentTask: 'T01', retries: 99, pauseReason: 'unrelated stage failure' });
    taskRecordFixture(root, 'T01'); taskRecordFixture(root, 'T02', { repairsUsed: 3, reason: 'other task failure' });
    const pack = buildPack(root);
    assert.deepEqual(pack.retryHistory, { count: 2, lastFailure: { at: '2026-10-29T00:01:00Z', reason: 'focused assertion failed' } });
  } finally { cleanup(root); }
});

test('dev corrupt task record blocks pack generation instead of resetting history', () => {
  const root = createFixture('task-retry-corrupt');
  try {
    writeState(root, { currentStage: 'dev', activeChange: 'demo', currentTask: 'T01' });
    taskRecordFixture(root, 'T01');
    writeFileSync(join(root, '.gantry/specs/demo/execution/T01.json'), '{bad');
    assert.throws(() => buildPack(root), /record corrupt/);
  } finally { cleanup(root); }
});

test('legacy dev retry history only reads matching task diagnostics', () => {
  const root = createFixture('task-retry-legacy');
  try {
    writeState(root, { currentStage: 'dev', activeChange: 'demo', currentTask: 'T01', retries: 88 });
    mkdirSync(join(root, '.gantry/specs/demo'), { recursive: true });
    writeFileSync(join(root, '.gantry/specs/demo/EXECUTION.md'), '# Execution\n\n## Self-Heal Log\n\n### T01 · attempt #1\n\n- at: legacy-at\n- reason: legacy-reason\n\n### T02 · attempt #1\n\n- at: other\n- reason: other-reason\n');
    const pack = buildPack(root);
    assert.deepEqual(pack.retryHistory, { count: 1, lastFailure: { at: 'legacy-at', reason: 'legacy-reason' } });
    assert(pack.loadOrder.some(e => e.path.endsWith('EXECUTION.md') && e.focus.some(f => f.includes('T01'))));
  } finally { cleanup(root); }
});

test('hook checklists suppress empty CLI calls and refresh when config changes',()=>{
 const root=createFixture('empty-hooks');try{
  writeState(root,{currentStage:'test'});
  writeFileSync(join(root,'.gantry/planning/config.json'),JSON.stringify({hooks:{'before:test':'  ','after:test':{}}}));
  const hooks=buildPack(root).checklists.filter(item=>item.id.startsWith('hook-'));
  assert.equal(hooks.length,2);assert.ok(hooks.every(item=>item.trigger===false&&item.confidence==='high'));
  writeFileSync(join(root,'.gantry/planning/config.json'),JSON.stringify({hooks:{'after:test':'npm test'}}));
  assert.equal(buildPack(root).checklists.find(item=>item.id==='hook-after').trigger,true);
 }finally{cleanup(root);}
});
