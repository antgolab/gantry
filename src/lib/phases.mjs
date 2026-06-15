/**
 * phases.mjs — 阶段注册 + 状态转换图 + 门禁验证
 * 零依赖，纯 Node.js
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTasks, allTasksDone } from './tasks.mjs';

// 固定管线阶段定义
export const STAGES = {
  idle:         { label: '空闲',     next: ['change'],                    checkpoint: null },
  change:       { label: '变更提案', next: ['requirement'],               checkpoint: 'human-verify' },
  requirement:  { label: '需求定义', next: ['design'],                    checkpoint: 'human-verify' },
  design:       { label: '技术设计', next: ['ui-design', 'task'],         checkpoint: 'human-verify' },
  'ui-design':  { label: 'UI 设计',  next: ['task'],                      checkpoint: 'human-verify' },
  task:         { label: '任务分解', next: ['dev'],                       checkpoint: 'auto' },
  dev:          { label: '开发执行', next: ['test'],                      checkpoint: 'per-wave' },
  test:         { label: '测试验证', next: ['review'],                    checkpoint: 'auto' },
  review:       { label: '代码审查', next: ['integration', 'dev'],        checkpoint: 'human-verify' },
  integration:  { label: '集成交付', next: ['idle'],                      checkpoint: 'human-verify' },
};

// 横向命令（任何阶段可触发）
export const LATERAL = ['scan', 'health', 'knowledge', 'architect', 'evolve', 'restyle', 'fast'];

// 快捷管线
export const PIPELINES = {
  full:    ['change', 'requirement', 'design', 'ui-design', 'task', 'dev', 'test', 'review', 'integration'],
  minimal: ['change', 'task', 'dev', 'review', 'integration'],
  fast:    ['change', 'dev', 'review'],
};

// 阶段 → 核心 phase prompt 文件映射
export const PHASE_FILES = {
  change:       '0-change.md',
  requirement:  '1-requirement.md',
  design:       '2-design.md',
  'ui-design':  '2a-ui-design.md',
  task:         '3-task.md',
  dev:          '4-dev.md',
  test:         '5-test.md',
  review:       '6-review.md',
  integration:  '7-integration.md',
  scan:         'I-intel-scan.md',
  health:       'M-health.md',
  knowledge:    'K-knowledge.md',
  architect:    'A-architect.md',
  evolve:       'A-evolve.md',
  restyle:      'L-restyle.md',
  fast:         'F-fast.md',
};

// 阶段 → 产出工件映射
export const STAGE_ARTIFACTS = {
  change:       'CHANGE.md',
  requirement:  'REQUIREMENT.md',
  design:       'DESIGN.md',
  'ui-design':  'UI-DESIGN.md',
  task:         'TASK.md',
  dev:          'SUMMARY.md',
  test:         'TEST.md',
  review:       'REVIEW.md',
  integration:  'UAT.md',
};

/**
 * 检查阶段门禁是否满足
 * @param {string} targetStage - 目标阶段
 * @param {string} specsDir - .gantry/specs/<change-id>/ 目录
 * @param {object} config - 项目配置
 * @param {object} [state] - 当前状态
 * @returns {{ passed: boolean, reason?: string, skipReason?: string }}
 */
export function checkGate(targetStage, specsDir, config, state) {
  const gates = {
    requirement: () => checkArtifact(specsDir, 'CHANGE.md'),
    design:      () => checkArtifact(specsDir, 'REQUIREMENT.md'),
    'ui-design': () => checkArtifact(specsDir, 'DESIGN.md'),
    task:        () => checkArtifact(specsDir, 'DESIGN.md'),
    dev:         () => checkArtifact(specsDir, 'TASK.md'),
    test:        () => checkAllTasksDone(specsDir),
    review:      () => checkArtifact(specsDir, 'TEST.md'),
    integration: () => checkReviewPassed(specsDir),
  };

  // 跳过已禁用的阶段
  if (config?.stages?.[targetStage]?.enabled === false) {
    return { passed: true, reason: 'stage disabled, skipping' };
  }

  const gate = gates[targetStage];
  if (!gate) return { passed: true };
  return gate();
}

/**
 * 获取下一个有效阶段（跳过禁用的）
 */
export function getNextStage(currentStage, config) {
  const candidates = STAGES[currentStage]?.next || [];
  for (const candidate of candidates) {
    if (config?.stages?.[candidate]?.enabled !== false) {
      return candidate;
    }
  }
  return null;
}

/**
 * 验证转换是否合法
 */
export function isValidTransition(from, to) {
  if (LATERAL.includes(to)) return true;
  return STAGES[from]?.next?.includes(to) ?? false;
}

// --- 内部辅助 ---

function checkArtifact(specsDir, filename) {
  const path = join(specsDir, filename);
  if (existsSync(path)) {
    return { passed: true };
  }
  return { passed: false, reason: `缺少前置工件: ${filename}` };
}

function checkAllTasksDone(specsDir) {
  const taskFile = join(specsDir, 'TASK.md');
  if (!existsSync(taskFile)) {
    return { passed: false, reason: '缺少 TASK.md' };
  }
  const tasks = parseTasks(taskFile);
  if (tasks.length === 0) {
    return { passed: false, reason: 'TASK.md 中没有解析到任务' };
  }
  if (allTasksDone(tasks)) {
    return { passed: true };
  }
  const pending = tasks.filter(t => t.status !== 'done').map(t => t.id);
  return { passed: false, reason: `任务未全部完成: ${pending.join(', ')}` };
}

function checkReviewPassed(specsDir) {
  const reviewFile = join(specsDir, 'REVIEW.md');
  if (!existsSync(reviewFile)) {
    return { passed: false, reason: '缺少 REVIEW.md' };
  }
  const content = readFileSync(reviewFile, 'utf-8');
  if (/\b(BLOCKED|REJECTED|阻塞|驳回)\b/i.test(content)) {
    return { passed: false, reason: 'REVIEW.md 存在阻塞标记，需修复后推进' };
  }
  if (/\b(APPROVED|PASSED|通过)\b/i.test(content)) {
    return { passed: true };
  }
  return { passed: true, skipReason: 'REVIEW.md 未见明确通过标记，请确认审查已完成' };
}
