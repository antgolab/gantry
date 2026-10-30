/**
 * loop.mjs — 无人值守收敛引擎的下游决策器(纯函数)
 *
 * 零 IO:所有输入通过参数传入,所有输出通过返回值。
 * CLI 层(cli.mjs loopNext)负责读 STATE.md/fence/SPEC/test-commands.yml,
 * 本模块只做映射与判定。
 *
 * pdlc 骨架(状态机真源 / 客观 check / 只前进)在此落地为 gantry 语义:
 *   - 两档 pipeline(full/light)各自的收敛条件(C4)
 *   - AC 编号锚定的 check 覆盖校验(C2)
 *   - 白名单单 token 输出契约(pdlc S4)
 *
 * 依赖单向:loop.mjs → phases.mjs(读 STAGES),phases 不反向依赖 loop。
 * AC 覆盖判定已下沉到叶子模块 ac-coverage.mjs(T-FIX-01,断开循环),此处 re-export。
 */

import { STAGES, PIPELINES } from './phases.mjs';
// T-FIX-01 · REVIEW Round 2 · R5:AC 覆盖判定已抽到叶子模块 ac-coverage.mjs,
// phases.mjs 现在直接 import 那个模块,不再反向依赖 loop.mjs。此处保留 re-export
// 以维持既有 test / cli 的 `from './loop.mjs'` 路径不动。
export { checkAcCoverage, extractAcIds } from './ac-coverage.mjs';
// 注:extractAcIds 供 loop 自身兜底逻辑潜在使用亦通过 re-export 暴露。
// 若未来 loop.mjs 内部需要直接调用,统一 import from './ac-coverage.mjs'。

/**
 * loop-next 白名单:driver 只信这 11 个 token,其他一律 blocked。
 * 顺序与 STAGES 一致 + light 的内部 token(gantry-fast) + 结束态 done + 阻塞态 blocked。
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
  'gantry-fast',
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
  // light 只有 fast 一个阶段(DESIGN D16):fast 轮次 ok 即收敛,由 driver 收尾。
  // light 不经过 integration,也没有独立的结束阶段。
  light: (s) => s.currentStage === 'fast' && s.lastStageResult?.ok === true,
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

  // full 执行当前阶段；显式旁路不得跳过实际位置。
  if (state.pipeline !== 'light') {
    const stage = state.currentStage;
    if (stage === 'done') return 'done';
    if (stage === 'idle') {
      // light auto-archive deliberately resets position to full@idle and leaves
      // an explicit convergence receipt. Preserve that compatibility signal.
      return !state.activeChange && state.nextStep === 'done' && state.lastStageResult?.ok === true
        ? 'done' : 'gantry-change';
    }
    const token = `gantry-${stage}`;
    if (!PIPELINES.full.includes(stage) || !WHITELIST.includes(token)) return 'blocked';
    if (state.nextStep != null && state.nextStep !== token) return 'blocked';
    return token;
  }

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
function deriveNextFromStage(currentStage, pipelineKey) {
  if (!currentStage) return null;
  if (currentStage === 'idle') return 'gantry-change';
  if (currentStage === 'done') return 'done';

  const pipelineStages = PIPELINES[pipelineKey];
  if (pipelineStages) {
    const idx = pipelineStages.indexOf(currentStage);
    if (idx >= 0) {
      // 从 idx+1 起,取第一个白名单可映射的后继
      for (let i = idx + 1; i < pipelineStages.length; i++) {
        const next = pipelineStages[i];
        if (next === 'done') return 'done';
        return `gantry-${next}`;
      }
      // D23 / REVIEW F-04(选项 a):light 只有 fast 一个阶段(见上 CONVERGE_CONDITIONS),
      // 走到末位且未收敛时必须给出可达的内部 token gantry-fast,否则 light 进行中
      // driver 只会拿到 blocked + exit 2。收敛(→ done)与 blockedReason(→ blocked)
      // 已在 computeNextStep 前置判定,此处不再重复。full 行为不变。
      if (pipelineKey === 'light' && currentStage === 'fast') return 'gantry-fast';
      // pipeline 走到末位:交回上层判定。真正的 'done' 只能由 CONVERGE_CONDITIONS 出——
      // lastStageResult.ok !== true 时会 fall through 到 'blocked',阻止 driver
      // 在未验证 / fence 缺失场景绕过 integration AC 覆盖硬闸。
      return null;
    }
  }

  const candidates = STAGES[currentStage]?.next || [];
  for (const c of candidates) {
    return `gantry-${c}`;
  }
  return null;
}

// --- AC 覆盖校验(C2)---
// T-FIX-01(REVIEW Round 2 · R5):checkAcCoverage / extractAcIds 迁移到
// src/lib/ac-coverage.mjs。本模块顶部的 re-export 保留既有 import 路径。
