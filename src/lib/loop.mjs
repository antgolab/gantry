/**
 * loop.mjs — 无人值守收敛引擎的下游决策器(纯函数)
 *
 * 零 IO:所有输入通过参数传入,所有输出通过返回值。
 * CLI 层(cli.mjs loopNext)负责读 STATE.md/fence/SPEC/test-commands.yml,
 * 本模块只做映射与判定。
 *
 * pdlc 骨架(状态机真源 / 客观 check / 只前进)在此落地为 gantry 语义:
 *   - 三种 pipeline(full/light/micro)各自的收敛条件(C4)
 *   - AC 编号锚定的 check 覆盖校验(C2)
 *   - 白名单单 token 输出契约(pdlc S4)
 *
 * 依赖单向:loop.mjs → phases.mjs(读 STAGES),phases 不反向依赖 loop。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAGES, PIPELINES } from './phases.mjs';

/**
 * loop-next 白名单:driver 只信这 10 个 token,其他一律 blocked。
 * 顺序与 STAGES 一致 + 结束态 done + 阻塞态 blocked。
 */
export const WHITELIST = Object.freeze([
  'gantry-change',
  'gantry-requirement',
  'gantry-design',
  'gantry-task',
  'gantry-dev',
  'gantry-test',
  'gantry-review',
  'gantry-integration',
  'done',
  'blocked',
]);

/**
 * 每种 pipeline 的收敛条件——达到此条件时 computeNextStep 返回 'done'。
 *
 * 与 DESIGN ADR-002 一致:纯函数,只看 state 快照,不做 IO。
 */
export const CONVERGE_CONDITIONS = Object.freeze({
  full:  (s) => s.currentStage === 'integration' && s.lastStageResult?.ok === true,
  light: (s) => s.currentStage === 'integration' && s.lastStageResult?.ok === true,
  micro: (s) => s.currentStage === 'done' || (s.currentStage === 'dev' && s.lastStageResult?.ok === true),
});

/**
 * 计算下一步 loop token。
 *
 * 判定序:
 *   1. lastStageResult.blockedReason 非空  → 'blocked'
 *   2. CONVERGE_CONDITIONS[pipeline] 命中  → 'done'
 *   3. state.nextStep 在白名单           → 直接返回
 *   4. 兜底:currentStage 的 pipeline 后继阶段
 *   5. 上述都失败                        → 'blocked'
 *
 * @param {object} state - 合并了散文区与 fence 的 state 快照
 * @returns {string} 白名单 token(WHITELIST 之一)
 */
export function computeNextStep(state) {
  if (!state || typeof state !== 'object') return 'blocked';

  // 1. blocked 优先(pdlc AC-4 语义)
  if (state.lastStageResult?.blockedReason != null) return 'blocked';

  // 2. 收敛条件
  const pipelineKey = state.pipeline in CONVERGE_CONDITIONS ? state.pipeline : 'full';
  if (CONVERGE_CONDITIONS[pipelineKey](state)) return 'done';

  // 3. state.nextStep 显式写死
  if (WHITELIST.includes(state.nextStep)) return state.nextStep;

  // 4. 兜底:根据 pipeline + currentStage 查后继
  const derived = deriveNextFromStage(state.currentStage, pipelineKey);
  if (derived && WHITELIST.includes(derived)) return derived;

  // 5. 兜底失败
  return 'blocked';
}

/**
 * 根据 pipeline 顺序 + 当前 stage,推导下一个白名单 token。
 * pipeline 未涵盖当前 stage 时,回退到 STAGES 默认有向图第一后继。
 */
// ui-design 是条件阶段(仅 uiImpact=true 时执行),loop 自动派发时跳过——
// 由 gantry-next / advance 层根据 config._uiImpact 决定是否进入。
const CONDITIONAL_STAGES = new Set(['ui-design']);

function deriveNextFromStage(currentStage, pipelineKey) {
  if (!currentStage) return null;
  if (currentStage === 'idle') return 'gantry-change';
  if (currentStage === 'done') return 'done';

  const pipelineStages = PIPELINES[pipelineKey];
  if (pipelineStages) {
    const idx = pipelineStages.indexOf(currentStage);
    if (idx >= 0) {
      // 从 idx+1 起,跳过所有条件阶段,取第一个白名单可映射的后继
      for (let i = idx + 1; i < pipelineStages.length; i++) {
        const next = pipelineStages[i];
        if (CONDITIONAL_STAGES.has(next)) continue;
        if (next === 'done') return 'done';
        return `gantry-${next}`;
      }
      // pipeline 走到末位:视为已收敛
      return 'done';
    }
  }

  const candidates = STAGES[currentStage]?.next || [];
  for (const c of candidates) {
    if (CONDITIONAL_STAGES.has(c)) continue;
    return `gantry-${c}`;
  }
  return null;
}

// --- AC 覆盖校验(C2)---

/**
 * 检查 SPEC.md 里所有 AC 编号是否都被 test-commands.yml 里某个命令的 covers 覆盖。
 *
 * @param {string} specsDir - .gantry/specs/<change-id>/
 * @param {object|null} testCommands - 解析后的 test-commands.yml,null 表示无该文件
 * @returns {{ covered: string[], missing: string[], skipped?: boolean }}
 */
export function checkAcCoverage(specsDir, testCommands) {
  if (testCommands == null) {
    return { covered: [], missing: [], skipped: true };
  }

  const specPath = join(specsDir, 'SPEC.md');
  if (!existsSync(specPath)) {
    return { covered: [], missing: [], skipped: true };
  }

  const acIds = extractAcIds(readFileSync(specPath, 'utf-8'));
  if (acIds.length === 0) {
    return { covered: [], missing: [], skipped: true };
  }

  // 收集所有 covers 项(合并所有命令)
  const allCovers = new Set();
  for (const cmdKey of Object.keys(testCommands)) {
    const covers = testCommands[cmdKey]?.covers;
    if (Array.isArray(covers)) {
      for (const c of covers) allCovers.add(c);
    }
  }

  const wildcard = allCovers.has('*');
  const covered = [];
  const missing = [];
  for (const ac of acIds) {
    if (wildcard || allCovers.has(ac)) covered.push(ac);
    else missing.push(ac);
  }
  // 保留通配符信息(方便 driver 上报)
  if (wildcard) covered.push('*');
  return { covered, missing, skipped: false };
}

/**
 * 抠出 SPEC.md 里的 AC 编号(AC-1, AC-2, ...)。
 * 语法:行首 `###` 或 `####` 后紧跟 `AC-<数字>` 单词边界。
 */
export function extractAcIds(content) {
  const ids = new Set();
  const regex = /^#{2,4}\s+(AC-\d+)\b/gm;
  let m;
  while ((m = regex.exec(content)) != null) {
    ids.add(m[1]);
  }
  return Array.from(ids).sort((a, b) => {
    const na = parseInt(a.slice(3), 10);
    const nb = parseInt(b.slice(3), 10);
    return na - nb;
  });
}
