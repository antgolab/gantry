/**
 * state.mjs — STATE.md 读写 + 状态转换
 * 零依赖，纯 Node.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { PLANNING_DIR } from './paths.mjs';
import { getAgentForStage } from './agents.mjs';
import { normalizePipeline } from './pipeline-policy.mjs';

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
  const statePath = join(planningDir, STATE_FILE);
  const tempPath = `${statePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, content, 'utf-8');
  renameSync(tempPath, statePath);
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
  return updateState(projectRoot, {
    currentStage: toStage,
    activeAgent: getAgentForStage(toStage),
    currentWave: null,
    currentTask: null,
    retries: 0,
    pauseReason: null,
  });
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

  state.pipeline = normalizePipeline(state.pipeline);
  if (state.pipeline === 'light' && !['change', 'fast', 'integration', 'idle'].includes(state.currentStage)) {
    state.pipeline = 'full';
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
