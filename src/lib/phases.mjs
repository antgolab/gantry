/**
 * phases.mjs — 阶段注册 + 状态转换图 + 门禁验证
 * 零依赖，纯 Node.js
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTasks, allTasksDone } from './tasks.mjs';
import { artifactExists, getPreferredArtifactName, resolveArtifactPath } from './artifacts.mjs';

// 固定管线阶段定义
export const STAGES = {
  idle:         { label: '空闲',     next: ['change'],                    checkpoint: null },
  change:       { label: '变更提案', next: ['requirement'],               checkpoint: 'approval' },
  requirement:  { label: '需求定义', next: ['design'],                    checkpoint: 'approval' },
  design:       { label: '技术设计', next: ['ui-design', 'task'],         checkpoint: 'approval' },
  'ui-design':  { label: 'UI 设计',  next: ['task'],                      checkpoint: 'approval' },
  task:         { label: '任务分解', next: ['dev'],                       checkpoint: 'auto' },
  dev:          { label: '开发执行', next: ['test'],                      checkpoint: null },
  test:         { label: '测试验证', next: ['review'],                    checkpoint: 'auto' },
  review:       { label: '代码审查', next: ['integration', 'dev'],        checkpoint: 'approval' },
  integration:  { label: '集成交付', next: ['idle'],                      checkpoint: 'approval' },
};

// 横向命令（任何阶段可触发）

// 快捷管线：定义 pipeline 实际包含哪些阶段
//   light    — 极简模式，CHANGE → DEV → REVIEW → INTEGRATION（README 称 MVP）
//   standard — 标准模式，含 task / test / review，但跳过 ui-design
//   full     — 完整模式，全部阶段
export const PIPELINES = {
  full:     ['change', 'requirement', 'design', 'ui-design', 'task', 'dev', 'test', 'review', 'integration'],
  standard: ['change', 'requirement', 'design', 'task', 'dev', 'test', 'review', 'integration'],
  light:    ['change', 'task', 'dev', 'review', 'integration'],
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

/**
 * 检查阶段门禁是否满足
 *
 * Gate 依赖：
 *   - 默认每个阶段依赖前一个阶段的工件（如 task 依赖 DESIGN.md）
 *   - 若当前 pipeline 跳过了某依赖阶段（light 跳过 requirement/design），
 *     gate 应改为检查 pipeline 中该阶段的实际前驱工件
 *
 * @param {string} targetStage - 目标阶段
 * @param {string} specsDir - .gantry/specs/<change-id>/ 目录
 * @param {object} config - 项目配置（含 pipeline）
 * @param {object} [state] - 当前状态
 * @returns {{ passed: boolean, reason?: string, skipReason?: string }}
 */
export function checkGate(targetStage, specsDir, config, state) {
  // 跳过已禁用的阶段
  if (config?.stages?.[targetStage]?.enabled === false) {
    return { passed: true, reason: 'stage disabled, skipping' };
  }

  // pipeline-aware gate：dev/test/review/integration 这种"动态依赖"的阶段
  // 由调用 pipeline 决定前驱
  const pipeline = config?.pipeline;
  const pipelineStages = pipeline && PIPELINES[pipeline];

  // 静态门禁（不受 pipeline 影响的）
  const staticGates = {
    requirement: () => checkProposalReady(specsDir),
    design:      () => checkArtifact(specsDir, 'spec'),
    'ui-design': () => checkArtifact(specsDir, 'design'),
    test:        () => checkAllTasksDone(specsDir),
    integration: () => checkReviewPassed(specsDir),
  };

  if (staticGates[targetStage]) {
    return staticGates[targetStage]();
  }

  // 动态门禁：根据 pipeline 决定前驱
  //   task 默认要 DESIGN.md，light 模式（跳过 design）改为 PROPOSAL.md/CHANGE.md
  //   dev 默认要 TASKS.md/TASK.md
  //   review 默认要 TEST.md，light 模式（跳过 test）改为任意 EXECUTION/SUMMARY 证据
  if (targetStage === 'task') {
    if (pipelineStages && !pipelineStages.includes('design')) {
      return checkProposalReady(specsDir);
    }
    return checkArtifact(specsDir, 'design');
  }
  if (targetStage === 'dev') {
    return checkArtifact(specsDir, 'tasks');
  }
  if (targetStage === 'review') {
    if (pipelineStages && !pipelineStages.includes('test')) {
      return checkAllTasksDone(specsDir);
    }
    return checkArtifact(specsDir, 'test');
  }

  return { passed: true };
}

/**
 * 获取下一个有效阶段
 *
 * 优先级：
 *   1. 如果 state.pipeline 指定了 light/standard/full，按 PIPELINES[pipeline] 顺序跳过未列入的阶段
 *   2. 否则按 STAGES.next 默认有向图
 *   3. 任意阶段如在 config.stages 里 enabled=false，跳过
 *
 * @param {string} currentStage
 * @param {object} config - 项目配置（含 pipeline / stages）
 */
export function getNextStage(currentStage, config) {
  const pipeline = config?.pipeline;
  const pipelineStages = pipeline && PIPELINES[pipeline];

  // 路径 A：受 PIPELINES 约束（light/standard/full）
  if (pipelineStages) {
    const idx = pipelineStages.indexOf(currentStage);
    if (idx >= 0) {
      for (let i = idx + 1; i < pipelineStages.length; i++) {
        const candidate = pipelineStages[i];
        if (config?.stages?.[candidate]?.enabled === false) continue;
        return candidate;
      }
      return null;
    }
    // currentStage 不在 pipeline 列表里，退回默认图
  }

  // 路径 B：默认有向图
  const candidates = STAGES[currentStage]?.next || [];
  for (const candidate of candidates) {
    if (config?.stages?.[candidate]?.enabled !== false) {
      return candidate;
    }
  }
  return null;
}

// --- 内部辅助 ---

function checkArtifact(specsDir, artifactKey) {
  if (artifactExists(specsDir, artifactKey)) {
    return { passed: true };
  }
  return { passed: false, reason: `缺少前置工件: ${getPreferredArtifactName(artifactKey)}` };
}

/**
 * requirement / light-task 门禁：PROPOSAL 必须存在，且「待澄清问题」段已清空。
 *
 * change 阶段的反问约束是软指令（prose），AI 可能跳过反问、把未决问题倾倒进
 * PROPOSAL 就推进。这里做机械兜底：只要「## 待澄清问题」段里还有未勾选项
 * （`- [ ]`），就阻断——未决问题应当问人，不是带进下一阶段。
 */
function checkProposalReady(specsDir) {
  const base = checkArtifact(specsDir, 'proposal');
  if (!base.passed) return base;

  const resolved = resolveArtifactPath(specsDir, 'proposal');
  if (!resolved || !existsSync(resolved.path)) return base;

  const open = countOpenQuestions(readFileSync(resolved.path, 'utf-8'));
  if (open > 0) {
    return {
      passed: false,
      reason: `${resolved.name} still has ${open} unresolved question(s)，请先回到 change 阶段反问用户澄清，再划掉「待澄清问题」段`,
    };
  }
  return { passed: true };
}

/**
 * 统计 PROPOSAL「待澄清问题」段内未勾选的 checkbox 数量。
 * 只扫该段标题到下一个 `## ` 或 `---` 之间，避免误伤「影响面」等其他 checkbox 段。
 * 单一事实源：门禁(checkGate)与 context-pack checklist 共用，避免判定标准分叉。
 */
export function countOpenQuestions(content) {
  const lines = content.split('\n');
  let inSection = false;
  let open = 0;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inSection = /^##\s+待澄清问题/.test(line);
      continue;
    }
    if (!inSection) continue;
    if (/^---\s*$/.test(line)) break; // 段落结束
    if (/^\s*-\s*\[\s*\]/.test(line)) open++;
  }
  return open;
}

function checkAllTasksDone(specsDir) {
  const resolved = resolveArtifactPath(specsDir, 'tasks');
  if (!resolved || !existsSync(resolved.path)) {
    return { passed: false, reason: `缺少 ${getPreferredArtifactName('tasks')}` };
  }
  const tasks = parseTasks(resolved.path);
  if (tasks.length === 0) {
    return { passed: false, reason: `${resolved.name} 中没有解析到任务` };
  }
  if (allTasksDone(tasks)) {
    return { passed: true };
  }
  const pending = tasks.filter(t => t.status !== 'done').map(t => t.id);
  return { passed: false, reason: `任务未全部完成: ${pending.join(', ')}` };
}

function checkReviewPassed(specsDir) {
  const reviewFile = resolveArtifactPath(specsDir, 'review')?.path;
  if (!reviewFile || !existsSync(reviewFile)) {
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
