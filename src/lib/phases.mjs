/**
 * phases.mjs — 阶段注册 + 状态转换图 + 门禁验证
 * 零依赖，纯 Node.js
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, sep, relative } from 'node:path';
import { parseTasks, allTasksDone } from './tasks.mjs';
import { artifactExists, getPreferredArtifactName, resolveArtifactPath } from './artifacts.mjs';
import { validateIntentScope } from './light-guard.mjs';
// T-FIX-01(REVIEW Round 2 · R5):直接 import 叶子模块,不再走 loop.mjs 的
// re-export,避免 phases → loop → phases 的循环 import。
import { checkAcCoverage } from './ac-coverage.mjs';
import { checkAcEvidence } from './ac-evidence.mjs';
import { checkResearchLedger } from './research-ledger.mjs';
import { checkPrototypeGate } from './prototype.mjs';
import { parseTestCommands } from './test-commands.mjs';
import { SPECS_DIR } from './paths.mjs';
import { readTaskRecord } from './task-record.mjs';
import { createContract, contractsMatch, captureManifest, receiptIsValid, DEFAULT_RALPH_DEADLINES } from './task-evidence.mjs';
import { readConfig } from './config.mjs';

// 固定管线阶段定义
export const STAGES = {
  idle:         { label: '空闲',     next: ['change'] },
  change:       { label: '变更提案', next: ['requirement'] },
  requirement:  { label: '需求定义', next: ['design'] },
  design:       { label: '技术设计', next: ['task'] },
  task:         { label: '任务分解', next: ['dev'] },
  dev:          { label: '开发执行', next: ['test'] },
  test:         { label: '测试验证', next: ['review'] },
  review:       { label: '代码审查', next: ['integration', 'dev'] },
  fast:         { label: '快速闭环', next: ['integration'] },
  integration:  { label: '集成交付', next: ['idle'] },
};

// 横向命令（任何阶段可触发）

// 快捷管线：定义 pipeline 实际包含哪些阶段（ADR-006 · 二分）
//   light — 无人工关卡的最小循环，只有 FAST 一个阶段；由 CLI 固化的
//           light.json 意图 + 执行期 diff 守卫兜底，无 change/PROPOSAL
//   full  — 默认完整路径（8 阶段不变）
export const PIPELINES = {
  full:     ['change', 'requirement', 'design', 'task', 'dev', 'test', 'review', 'integration'],
  light:    ['fast'],
};

// 阶段 → 核心 phase prompt 文件映射
export const PHASE_FILES = {
  change:       '0-change.md',
  requirement:  '1-requirement.md',
  design:       '2-design.md',
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
  fast:         'F-fast.md',
};

/**
 * 检查阶段门禁是否满足
 *
 * Gate 依赖（ADR-006 起只有 full / light 两档）：
 *   - full 的 8 阶段：每阶段依赖前一个阶段的工件（如 task 依赖 DESIGN.md）
 *   - light 只有 fast 一个阶段，其门禁不读 PROPOSAL，改为校验 CLI 固化的
 *     light.json 意图（存在 + 可解析 + 范围合法），见 checkLightIntent
 *
 * @param {string} targetStage - 目标阶段
 * @param {string} specsDir - .gantry/specs/<change-id>/ 目录
 * @param {object} config - 项目配置（含 pipeline）
 * @param {object} [state] - 当前状态
 * @param {string} [projectRoot] - 项目根目录（T-FIX-02:integration ac-gate 用它读
 *   `.gantry/loop/test-commands.yml`。缺省沿 SPECS_DIR 常量语义反推,不再用
 *   `../../..` 计数魔法。测试 / cli 传入显式 root 更稳）。
 * @returns {{ passed: boolean, reason?: string, skipReason?: string }}
 */
export function checkGate(targetStage, specsDir, config, state, projectRoot) {
  if (['requirement', 'design', 'task', 'dev'].includes(targetStage)) {
    const ledger = checkResearchLedger(specsDir);
    if (!ledger.passed) return { passed: false, hard: true, reason: ledger.reason };
  }
  if (['review', 'integration'].includes(targetStage)) {
    const root = projectRoot ?? deriveProjectRootFromSpecsDir(specsDir);
    const prototype = checkPrototypeGate(specsDir, root, { validateTask: () => checkAllTasksDone(specsDir, root).passed });
    if (!prototype.passed) return { ...prototype, hard: true };
  }
  // 跳过已禁用的阶段
  if (config?.stages?.[targetStage]?.enabled === false) {
    return { passed: true, reason: 'stage disabled, skipping' };
  }

  // 静态门禁（只在 full 的 8 阶段图上有意义的固定依赖）
  const staticGates = {
    requirement: () => checkProposalReady(specsDir),
    design:      () => checkArtifact(specsDir, 'spec'),
    test:        () => checkAllTasksDone(specsDir, projectRoot),
    integration: () => {
      const base = checkReviewPassed(specsDir);
      if (!base.passed) return base;
      const evidence = checkAcGate(specsDir, projectRoot);
      return evidence.passed ? evidence : { ...evidence, hard: true };
    },
  };

  if (staticGates[targetStage]) {
    return staticGates[targetStage]();
  }

  // 动态门禁：full 的 task / dev / review 各自的前驱工件
  if (targetStage === 'task') {
    return checkArtifact(specsDir, 'design');
  }
  // light 的唯一阶段：意图由 CLI 固化在 light.json（ADR-006 / D4）。
  // 不再读 PROPOSAL、不再做创建期软判档——守卫在执行期用真实 diff 判定。
  if (targetStage === 'fast') {
    return checkLightIntent(specsDir);
  }
  if (targetStage === 'dev') {
    return checkArtifact(specsDir, 'tasks');
  }
  if (targetStage === 'review') {
    return checkArtifact(specsDir, 'test');
  }

  return { passed: true };
}

/**
 * light 进入 fast 的门禁：`<specsDir>/light.json` 必须存在、可解析，
 * 且 `intent.scope` 合法（light-guard#validateIntentScope）。
 *
 * 任一不满足即 hard block：light 没有人工关卡，意图缺失或范围非法时
 * 没有可信的执行边界，只能升档走 full（AC-5）。
 */
function checkLightIntent(specsDir) {
  const lightJsonPath = join(specsDir, 'light.json');
  if (!existsSync(lightJsonPath)) {
    return {
      passed: false,
      hard: true,
      reason: '缺少 light.json：light 意图未固化，请运行 gantry pipeline full 升档',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(lightJsonPath, 'utf-8'));
  } catch {
    return {
      passed: false,
      hard: true,
      reason: 'light.json 解析失败：意图不可信，请运行 gantry pipeline full 升档',
    };
  }

  const scope = validateIntentScope(parsed?.intent?.scope);
  if (!scope.ok) {
    return {
      passed: false,
      hard: true,
      reason: `light 意图范围非法 (${scope.reason})：请运行 gantry pipeline full 升档`,
    };
  }

  return { passed: true };
}

/**
 * 获取下一个有效阶段
 *
 * 优先级：
 *   1. 如果 state.pipeline 指定了 light/full，按 PIPELINES[pipeline] 顺序跳过未列入的阶段
 *   2. 否则按 STAGES.next 默认有向图
 *   3. 任意阶段如在 config.stages 里 enabled=false，跳过
 *
 * @param {string} currentStage
 * @param {object} config - 项目配置（含 pipeline / stages）
 */
export function getNextStage(currentStage, config) {
  const pipeline = config?.pipeline;
  const pipelineStages = pipeline && PIPELINES[pipeline];

  // 路径 A：受 PIPELINES 约束（light/full）
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
    // currentStage 不在 pipeline 列表里，退回默认图（仅兼容迁移中的旧状态）
  }

  // 路径 B：默认有向图
  const candidates = STAGES[currentStage]?.next || [];
  for (const candidate of candidates) {
    if (config?.stages?.[candidate]?.enabled === false) continue;
    return candidate;
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
 * requirement / fast 门禁：PROPOSAL 必须存在，且「待澄清问题」段已清空。
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

/**
 * hard-lock 判定(纯函数,便于单测)。
 *
 * design / integration:无条件锁 —— 这两个关卡的价值在人工判断决策方向,
 * 内容无法自证。
 *
 * change:**内容驱动** —— PROPOSAL.md「## 待澄清问题」段清空时(0 个未勾选
 * `- [ ]`) 视为边界已澄清,自动放行;段落缺失或还有未勾选项,保持锁。
 * 段落判定单一事实源 = `countOpenQuestions`,与 checkGate 共用。
 *
 * @param {string} stage
 * @param {string} [specsDir]  —— change 关卡读 PROPOSAL 需要;缺省保守锁
 * @returns {boolean}
 */
export function requiresApproval(stage, specsDir) {
  if (stage === 'design' || stage === 'integration') return true;
  if (stage !== 'change') return false;
  if (!specsDir) return true;
  const proposal = resolveArtifactPath(specsDir, 'proposal');
  if (!proposal || !existsSync(proposal.path)) return true;
  const content = readFileSync(proposal.path, 'utf-8');
  return countOpenQuestions(content) > 0;
}

function checkAllTasksDone(specsDir, projectRoot) {
  const resolved = resolveArtifactPath(specsDir, 'tasks');
  if (!resolved || !existsSync(resolved.path)) {
    return { passed: false, reason: `缺少 ${getPreferredArtifactName('tasks')}` };
  }
  const tasks = parseTasks(resolved.path);
  if (tasks.length === 0) {
    return { passed: false, reason: `${resolved.name} 中没有解析到任务` };
  }
  if (allTasksDone(tasks)) {
    const executionFile = resolveArtifactPath(specsDir, 'execution')?.path;
    if (!executionFile || !existsSync(executionFile)) {
      return { passed: false, reason: `缺少 ${getPreferredArtifactName('execution')}` };
    }
    // A checkbox and prose are insufficient. Queries only inspect durable
    // receipts; actual revalidation belongs to the async checkpoint controller.
    try {
      const root = projectRoot ?? deriveProjectRootFromSpecsDir(specsDir);
      if (!root) return { passed: false, hard: true, reason: '无法定位任务凭据的项目根目录' };
      const configPath = join(root, '.gantry/planning/config.json');
      if (existsSync(configPath)) {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid project config');
      }
      const configured = readConfig(root).ralph;
      const config = configured === undefined ? {} : configured;
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid ralph config');
      const deadlines = Object.fromEntries(Object.entries(DEFAULT_RALPH_DEADLINES).map(([key, value]) => [key, config[key] ?? value]));
      if (Object.values(deadlines).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('invalid ralph deadlines');
      const manifest = captureManifest(root, { includePaths: [relative(root, resolved.path), '.gantry/planning/config.json', '.gantry/loop/test-commands.yml'] });
      const changeId = specsDir.split(sep).at(-1);
      for (const task of tasks) {
        const record = readTaskRecord(root, changeId, task.id);
        const contract = createContract(task, { ...config, deadlineSnapshot: deadlines });
        if (!record?.attempt || !contractsMatch(record.contract, contract) || record.receipt?.attemptId !== record.attempt.id || !receiptIsValid(record.receipt, contract, manifest)) {
          return { passed: false, hard: true, reason: `任务 ${task.id} 的验证凭据缺失或过期，请执行 done/DEV checkpoint；旧任务需明确审阅迁移` };
        }
      }
    } catch (error) {
      return { passed: false, hard: true, reason: `任务验证凭据不可确认: ${error.message}` };
    }
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

/**
 * integration 门禁末端 · SPEC AC 覆盖强校验(P3 ADR-003)。
 *
 * 与 P1 `checkAcCoverage` + P2 `parseTestCommands` 直接对接。
 * 缺失 → hard block;SPEC 无 AC 或 test-commands.yml 缺失 → skip 降级。
 * 门禁 fail 时,由上层 advance 已有失败路径写 fence.blockedReason(非覆盖)。
 *
 * T-FIX-02(REVIEW Round 2 · R2):projectRoot 由调用者(cli advance / 测试)显式
 * 传入;缺省用 SPECS_DIR 常量做语义反推(strip 尾部 `.gantry/specs/<id>`),取代
 * 原来的 `../../..` 层数硬编码。SPECS_DIR 布局若改,fallback 自动跟随;调用者
 * 传 root 则完全解耦。
 */
function checkAcGate(specsDir, projectRoot) {
  const root = projectRoot ?? deriveProjectRootFromSpecsDir(specsDir);
  if (root == null) {
    return { passed: true, skipReason: 'ac-gate: 无法定位项目根,跳过 AC 覆盖检查' };
  }
  const evidence = checkAcEvidence(root, specsDir);
  if (evidence.passed && !evidence.skipped) return evidence;
  const tcPath = join(root, '.gantry/loop/test-commands.yml');

  // fail-closed(2026-10-12):此前 test-commands.yml 缺失即放行,而 install 从不
  // 生成它 —— 于是这道「AC 强校验闸」在真实用户项目里永远等于不存在。现在改为:
  // SPEC 有 AC 编号就必须有覆盖映射,缺失 / 空 / 漏覆盖一律阻塞进入 integration。
  // 唯一放行的是 SPEC 本身没有可校验的 AC(见下方 cov.skipped 分支)。
  let testCommands = null;
  if (existsSync(tcPath)) {
    try {
      testCommands = parseTestCommands(tcPath);
    } catch (err) {
      // 解析失败以前会直接抛穿 advance;门禁应给可执行的诊断,而不是崩栈。
      return { passed: false, reason: `ac-gate: test-commands.yml 解析失败(${err.message})` };
    }
  }

  const cov = checkAcCoverage(specsDir, testCommands);
  if (cov.skipped) {
    return { passed: true, skipReason: 'ac-gate: SPEC 无 AC 或 SPEC.md 缺失,跳过 AC 覆盖检查' };
  }
  if (cov.missing && cov.missing.length > 0) {
    // 缺文件 / 文件空这两种「没有映射」的情况,理由要能直接指路。
    let hint = '';
    if (!existsSync(tcPath)) {
      hint = ` · test-commands.yml 缺失(${tcPath}),运行 gantry install 生成模板`;
    } else if (!testCommands || Object.keys(testCommands).length === 0) {
      hint = ' · test-commands.yml 无有效命令条目(每条需 cmd + covers)';
    }
    return {
      passed: false,
      reason: `ac-gate: missing ${cov.missing.join(', ')}${hint}`,
    };
  }
  return checkAcEvidence(root, specsDir);
}

/**
 * 从 specsDir 反推项目根:strip 尾部 `${SPECS_DIR}/<change-id>` 片段。
 *
 * T-FIX-02(REVIEW Round 2 · R2):替代原来的 `resolve(specsDir, '..', '..', '..')`
 * 层数计数魔法。语义与 SPECS_DIR 常量单一绑定——若 SPECS_DIR 布局改变,反推自动
 * 跟随;若 specsDir 不含 SPECS_DIR 片段(异常输入 / 测试污染),返回 null,由
 * checkAcGate 降级 skip 而非 crash。
 *
 * 调用者显式传 projectRoot 时,本函数不会被调到——首选契约仍是"从上层拿"。
 */
function deriveProjectRootFromSpecsDir(specsDir) {
  if (typeof specsDir !== 'string' || specsDir.length === 0) return null;
  const marker = sep + SPECS_DIR.replaceAll('/', sep) + sep;
  const idx = specsDir.lastIndexOf(marker);
  if (idx < 0) return null;
  return specsDir.slice(0, idx);
}
