/**
 * loop.mjs — 持久循环：任务未完成时自动重试 + 策略切换 + 安全阀
 *
 * Prompt assembler 模式：生成"下一步指令"供 IDE 消费，不直接执行 AI 调用。
 */

import { runGate } from './gate.mjs';
import { escalateModel } from './model-router.mjs';
import { recordFailure } from './failure-memory.mjs';

/**
 * @typedef {Object} LoopConfig
 * @property {number} maxRetries - 单任务最大重试次数（默认 3）
 * @property {number} maxWaveRetries - 单 wave 最大重试次数（默认 2）
 * @property {'pause'|'skip'|'escalate'} onBlock - 阻塞时行为
 * @property {boolean} humanCheckpoints - 是否在关键节点暂停
 * @property {number} maxTotalIterations - 总迭代上限（安全阀，默认 20）
 */

const DEFAULT_CONFIG = {
  maxRetries: 3,
  maxWaveRetries: 2,
  onBlock: 'pause',
  humanCheckpoints: true,
  maxTotalIterations: 20,
};

/**
 * 评估单个任务的门禁结果，生成下一步指令
 * @param {object} task - 任务对象
 * @param {object} gateResult - runGate() 返回值
 * @param {object} history - { retryCount, failedApproaches, currentModel }
 * @returns {object} { action, retryPrompt?, newModel?, strategy?, reason }
 */
export function evaluateAndAdvise(task, gateResult, history = {}) {
  const { retryCount = 0, failedApproaches = [], currentModel = 'standard' } = history;

  if (gateResult.passed) {
    return { action: 'done', reason: 'All gates passed' };
  }

  if (retryCount >= DEFAULT_CONFIG.maxRetries) {
    return {
      action: 'blocked',
      reason: `Max retries (${DEFAULT_CONFIG.maxRetries}) exceeded for ${task.id}`,
      failedApproaches,
    };
  }

  // Strategy switching logic
  const failedGates = gateResult.checks.filter(c => !c.passed);
  const newModel = escalateModel(currentModel, retryCount);
  const strategy = switchStrategy(task, failedApproaches, failedGates, retryCount);

  return {
    action: 'retry',
    retryCount: retryCount + 1,
    newModel,
    strategy,
    retryPrompt: buildRetryPrompt(task, gateResult, strategy, failedApproaches),
    reason: `Gate failed: ${failedGates.map(g => g.gate).join(', ')}`,
  };
}

/**
 * 评估整个 wave 的执行状态
 * @param {object[]} tasks - wave 中的任务
 * @param {object[]} gateResults - 每个任务的门禁结果 [{ taskId, result }]
 * @param {LoopConfig} config
 * @returns {{ completed: string[], retry: string[], blocked: string[], allDone: boolean }}
 */
export function evaluateWave(tasks, gateResults, config = DEFAULT_CONFIG) {
  const completed = [];
  const retry = [];
  const blocked = [];

  for (const { taskId, result, retryCount } of gateResults) {
    if (result.passed) {
      completed.push(taskId);
    } else if (retryCount >= config.maxRetries) {
      blocked.push(taskId);
    } else {
      retry.push(taskId);
    }
  }

  return {
    completed,
    retry,
    blocked,
    allDone: completed.length === tasks.length,
  };
}

/**
 * 检查是否达到安全阀
 * @param {number} totalIterations - 已执行的总迭代数
 * @param {LoopConfig} config
 * @returns {{ shouldStop: boolean, reason: string }}
 */
export function checkSafetyValve(totalIterations, config = DEFAULT_CONFIG) {
  if (totalIterations >= config.maxTotalIterations) {
    return {
      shouldStop: true,
      reason: `Safety valve: reached ${config.maxTotalIterations} total iterations`,
    };
  }
  return { shouldStop: false, reason: '' };
}

/**
 * 生成持久循环的进度报告
 * @param {object} state - { totalIterations, tasksCompleted, tasksTotal, blocked, currentWave }
 * @returns {string} 格式化的进度报告
 */
export function progressReport(state) {
  const { totalIterations = 0, tasksCompleted = 0, tasksTotal = 0, blocked = [], currentWave = 0 } = state;
  const percent = tasksTotal > 0 ? Math.round((tasksCompleted / tasksTotal) * 100) : 0;

  let report = `\n┌─ Persistence Loop Progress ─────────────\n`;
  report += `│ Iterations: ${totalIterations}\n`;
  report += `│ Progress:   ${tasksCompleted}/${tasksTotal} (${percent}%)\n`;
  report += `│ Wave:       ${currentWave}\n`;
  if (blocked.length > 0) {
    report += `│ Blocked:    ${blocked.join(', ')}\n`;
  }
  report += `└──────────────────────────────────────────\n`;
  return report;
}

// --- 内部辅助 ---

function switchStrategy(task, failedApproaches, failedGates, retryCount) {
  if (retryCount === 0) {
    return 'Fix the specific issues identified by the gate';
  }
  if (retryCount === 1) {
    return 'Try a different approach. Previous approaches failed: ' + failedApproaches.join('; ');
  }
  return 'Escalate to deeper analysis. Consider fundamentally different architecture.';
}

function buildRetryPrompt(task, gateResult, strategy, failedApproaches) {
  const failedGates = gateResult.checks.filter(c => !c.passed);
  const issues = failedGates.flatMap(g => g.issues || g.violations || []);

  let prompt = `## Retry: ${task.id}\n\n`;
  prompt += `### Failed Gates\n`;
  for (const g of failedGates) {
    prompt += `- **${g.gate}**`;
    if (g.issues) prompt += `: ${g.issues.join('; ')}`;
    if (g.violations) prompt += `: out of scope — ${g.violations.join(', ')}`;
    prompt += '\n';
  }

  if (failedApproaches.length > 0) {
    prompt += `\n### Excluded Approaches\n`;
    for (const a of failedApproaches) {
      prompt += `- ❌ ${a}\n`;
    }
  }

  prompt += `\n### Strategy\n${strategy}\n`;
  return prompt;
}
