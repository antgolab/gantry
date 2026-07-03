/**
 * state.mjs — STATE.md 读写 + 状态转换
 * 零依赖，纯 Node.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLANNING_DIR } from './paths.mjs';

const STATE_FILE = 'STATE.md';

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
    contextUsage: {
      tokens: null,
      windowPercent: null,
    },
  };
}

/**
 * 读取项目状态
 * @param {string} projectRoot - 项目根目录
 * @returns {object} 解析后的状态对象
 */
export function readState(projectRoot) {
  const statePath = join(projectRoot, PLANNING_DIR, STATE_FILE);
  const state = existsSync(statePath)
    ? parseStateMd(readFileSync(statePath, 'utf-8'))
    : defaultState();
  return state;
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
    pauseReason: null,
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
 * 读取 timeline 中的门禁绕过记录（gate-bypass）。
 *
 * timeline 的消费者是「事后排查的开发者」：`gantry next --skip` 会显式绕过门禁并留痕，
 * 这个函数让那条留痕承诺可被兑现——status 据此提示"本 change 有 N 次绕过"。
 * 纯读、确定性；文件不存在返回 []。
 *
 * @param {string} projectRoot
 * @param {string} [changeId] - 只统计该 change 的绕过（省略则全部）
 * @returns {Array<{stage:string, reason:string, ts:string}>}
 */
export function readGateBypasses(projectRoot, changeId) {
  const timelinePath = join(projectRoot, PLANNING_DIR, 'timeline.jsonl');
  if (!existsSync(timelinePath)) return [];
  const bypasses = [];
  for (const line of readFileSync(timelinePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'gate-bypass') continue;
    if (changeId && ev.changeId && ev.changeId !== changeId) continue;
    bypasses.push({ stage: ev.stage, reason: ev.reason, ts: ev.ts });
  }
  return bypasses;
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
      case '已执行阶段数': {
        // 支持 "3 / 5" 或 "3" 两种格式
        const m = String(kv.value).match(/^(\d+)\s*(?:\/\s*(\d+))?/);
        if (m) {
          state.stagesRun = parseInt(m[1], 10) || 0;
          if (m[2]) state.maxStages = parseInt(m[2], 10) || state.maxStages;
        }
        break;
      }
      case '重试计数': {
        const m = String(kv.value).match(/^(\d+)\s*(?:\/\s*(\d+))?/);
        if (m) {
          state.retries = parseInt(m[1], 10) || 0;
          if (m[2]) state.maxRetries = parseInt(m[2], 10) || state.maxRetries;
        }
        break;
      }
      case '暂停原因': state.pauseReason = kv.value === '—' ? null : kv.value; break;
      case '上下文 token': state.contextUsage.tokens = kv.value === '—' ? null : parseInt(kv.value) || null; break;
      case '窗口使用率': state.contextUsage.windowPercent = kv.value === '—' ? null : parseFloat(kv.value) || null; break;
    }
  }

  return state;
}

function parseKvLine(line) {
  const match = line.match(/^-\s*\*\*(.+?)\*\*:\s*`?(.+?)`?\s*$/);
  if (match) return { key: match[1], value: match[2] };
  return null;
}

function renderStateMd(state) {
  const now = new Date().toISOString().slice(0, 10);

  return `# STATE — 项目协作状态

## Pipeline

- **模式**: \`${state.pipeline}\`
- **活跃 Change**: \`${state.activeChange || '无'}\`
- **当前阶段**: \`${state.currentStage}\`
- **当前 Wave**: \`${state.currentWave ?? '—'}\`
- **当前 Task**: \`${state.currentTask ?? '—'}\`
- **活跃 Agent**: \`${state.activeAgent ?? '—'}\`

## 自动模式状态

- **autonomous**: \`${state.autonomous}\`
- **已执行阶段数**: \`${state.stagesRun} / ${state.maxStages}\`
- **重试计数**: \`${state.retries} / ${state.maxRetries}\`
- **暂停原因**: \`${state.pauseReason ?? '—'}\`
- **上下文 token**: \`${state.contextUsage?.tokens ?? '—'}\`
- **窗口使用率**: \`${state.contextUsage?.windowPercent ?? '—'}\`

---
_最后更新: ${now}_
`;
}
