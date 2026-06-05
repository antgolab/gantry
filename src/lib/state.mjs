/**
 * state.mjs — STATE.md 读写 + 状态转换
 * 零依赖，纯 Node.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_FILE = 'STATE.md';
const PLANNING_DIR = '.planning';

/**
 * 默认状态结构
 */
function defaultState() {
  return {
    pipeline: 'full',
    activeChange: null,
    currentStage: 'idle',
    currentWave: null,
    currentTask: null,
    activeAgent: null,
    autonomous: false,
    stagesRun: 0,
    maxStages: 3,
    retries: 0,
    maxRetries: 3,
    pauseReason: null,
    checkpoints: [],
    decisions: [],
  };
}

/**
 * 读取项目状态
 * @param {string} projectRoot - 项目根目录
 * @returns {object} 解析后的状态对象
 */
export function readState(projectRoot) {
  const statePath = join(projectRoot, PLANNING_DIR, STATE_FILE);
  if (!existsSync(statePath)) {
    return defaultState();
  }

  const content = readFileSync(statePath, 'utf-8');
  return parseStateMd(content);
}

/**
 * 写入项目状态
 * @param {string} projectRoot - 项目根目录
 * @param {object} state - 状态对象
 */
export function writeState(projectRoot, state) {
  const planningDir = join(projectRoot, PLANNING_DIR);
  if (!existsSync(planningDir)) {
    mkdirSync(planningDir, { recursive: true });
  }

  const content = renderStateMd(state);
  writeFileSync(join(planningDir, STATE_FILE), content, 'utf-8');
}

/**
 * 原子更新状态字段
 */
export function updateState(projectRoot, updates) {
  const state = readState(projectRoot);
  Object.assign(state, updates);
  writeState(projectRoot, state);
  return state;
}

/**
 * 记录阶段转换
 */
export function transitionStage(projectRoot, fromStage, toStage) {
  logPhaseEvent(projectRoot, { type: 'transition', from: fromStage, to: toStage });
  return updateState(projectRoot, {
    currentStage: toStage,
    currentWave: null,
    currentTask: null,
    retries: 0,
  });
}

/**
 * 记录阶段事件到 timeline
 */
export function logPhaseEvent(projectRoot, event) {
  const timelinePath = join(projectRoot, PLANNING_DIR, 'timeline.jsonl');
  const entry = JSON.stringify({ ...event, ts: new Date().toISOString() });
  appendFileSync(timelinePath, entry + '\n');
}

/**
 * 读取 timeline
 */
export function readTimeline(projectRoot) {
  const timelinePath = join(projectRoot, PLANNING_DIR, 'timeline.jsonl');
  if (!existsSync(timelinePath)) return [];
  return readFileSync(timelinePath, 'utf-8')
    .trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
}

/**
 * 添加 checkpoint 记录
 */
export function addCheckpoint(projectRoot, checkpoint) {
  const state = readState(projectRoot);
  state.checkpoints.push(checkpoint);
  writeState(projectRoot, state);
  return checkpoint;
}

/**
 * 添加决策记录
 */
export function addDecision(projectRoot, decision) {
  const state = readState(projectRoot);
  state.decisions.unshift(decision);
  if (state.decisions.length > 10) state.decisions = state.decisions.slice(0, 10);
  writeState(projectRoot, state);
}

// --- 解析 / 渲染 ---

function parseStateMd(content) {
  const state = defaultState();
  const lines = content.split('\n');

  for (const line of lines) {
    const kv = parseKvLine(line);
    if (!kv) continue;

    switch (kv.key) {
      case '模式': state.pipeline = kv.value; break;
      case '活跃 Change': state.activeChange = kv.value === '无' ? null : kv.value; break;
      case '当前阶段': state.currentStage = kv.value === 'idle' ? 'idle' : kv.value; break;
      case '当前 Wave': state.currentWave = kv.value === '—' ? null : parseInt(kv.value) || null; break;
      case '当前 Task': state.currentTask = kv.value === '—' ? null : kv.value; break;
      case '活跃 Agent': state.activeAgent = kv.value === '—' ? null : kv.value; break;
      case 'autonomous': state.autonomous = kv.value === 'true'; break;
      case '已执行阶段数': state.stagesRun = parseInt(kv.value) || 0; break;
      case '重试计数': state.retries = parseInt(kv.value) || 0; break;
      case '暂停原因': state.pauseReason = kv.value === '—' ? null : kv.value; break;
    }
  }

  // 解析 checkpoint 表格
  state.checkpoints = parseCheckpointTable(content);
  // 解析决策日志
  state.decisions = parseDecisionLog(content);

  return state;
}

function parseKvLine(line) {
  const match = line.match(/^-\s*\*\*(.+?)\*\*:\s*`?(.+?)`?\s*$/);
  if (match) return { key: match[1], value: match[2] };
  return null;
}

function parseCheckpointTable(content) {
  const checkpoints = [];
  const tableMatch = content.match(/## Checkpoints\n\n\|[^\n]+\n\|[^\n]+\n([\s\S]*?)(?=\n##|\n$)/);
  if (!tableMatch) return checkpoints;

  const rows = tableMatch[1].trim().split('\n');
  for (const row of rows) {
    const cells = row.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length >= 5) {
      checkpoints.push({
        id: cells[0], stage: cells[1], type: cells[2],
        status: cells[3], created: cells[4],
      });
    }
  }
  return checkpoints;
}

function parseDecisionLog(content) {
  const decisions = [];
  const section = content.match(/## 决策日志[\s\S]*?\n([\s\S]*?)(?=\n##|\n$)/);
  if (!section) return decisions;

  const lines = section[1].trim().split('\n');
  for (const line of lines) {
    const match = line.match(/^-\s*`\[(.+?)\]`\s*(.+)/);
    if (match) {
      decisions.push({ date: match[1], content: match[2] });
    }
  }
  return decisions;
}

function renderStateMd(state) {
  const now = new Date().toISOString().slice(0, 10);
  const checkpointRows = state.checkpoints.map(cp =>
    `| ${cp.id} | ${cp.stage} | ${cp.type} | ${cp.status} | ${cp.created} |`
  ).join('\n');

  const decisionRows = state.decisions.map(d =>
    `- \`[${d.date}]\` ${d.content}`
  ).join('\n');

  return `# STATE — 项目协作状态

## Pipeline

- **模式**: \`${state.pipeline}\`
- **活跃 Change**: \`${state.activeChange || '无'}\`
- **当前阶段**: \`${state.currentStage}\`
- **当前 Wave**: \`${state.currentWave ?? '—'}\`
- **当前 Task**: \`${state.currentTask ?? '—'}\`
- **活跃 Agent**: \`${state.activeAgent ?? '—'}\`

## Checkpoints

| ID | Stage | Type | Status | Created |
|----|-------|------|--------|---------|
${checkpointRows}

## 自动模式状态

- **autonomous**: \`${state.autonomous}\`
- **已执行阶段数**: \`${state.stagesRun} / ${state.maxStages}\`
- **重试计数**: \`${state.retries} / ${state.maxRetries}\`
- **暂停原因**: \`${state.pauseReason ?? '—'}\`

## 决策日志（最近 10 条）

${decisionRows || '（暂无）'}

---
_最后更新: ${now}_
`;
}
