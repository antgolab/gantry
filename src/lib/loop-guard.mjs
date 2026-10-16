/**
 * loop-guard.mjs — loop driver 的上下文 / 步数熔断纯函数
 *
 * 零 IO:输入通过参数,输出通过返回值。CLI 层(cli.mjs loopGuard)负责
 * 读 state + config、写 fence.blockedReason。
 *
 * 判定序(ADR-002):
 *   1. context.windowPercent >= 阈值 → tripped context-window-exceeded
 *   2. context.tokens > 阈值        → tripped context-tokens-exceeded
 *   3. stagesRun >= maxStages       → tripped max-stages-exceeded
 *   4. contextUsage 缺失            → skipped:true, tripped:false
 *   5. 都不满足                     → tripped:false
 *
 * 与 P1 loop.mjs 无耦合;driver 先跑 guard 再跑 loop-next。
 *
 * 注:contextUsage.tokens / contextUsage.windowPercent 需宿主 agent(Claude Code
 * / Codex 等)通过 hook 主动写入 STATE.md。gantry CLI 是独立 Node 进程,拿不到
 * 宿主的真实 token 使用量,不做经验估算。字段当前无生产者时,1/2 分支不会触发,
 * 只由 3(stagesRun)兜底熔断。等接入真实数据源后此消费逻辑自然生效。
 */

const DEFAULT_THRESHOLDS = Object.freeze({
  contextPercent: 85,
  contextTokens: 200000,
  stuckTolerance: 2,
});

/**
 * @param {object} state - readState 输出的快照
 * @param {object} [config] - 项目 config,读 config.loopGuard.* 覆写缺省
 * @returns {{ tripped: boolean, reason?: string, field?: string, skipped?: boolean }}
 */
export function checkLoopGuard(state, config = {}) {
  if (!state || typeof state !== 'object') {
    return { tripped: false, skipped: true };
  }

  const thresholds = resolveThresholds(config);

  // 1 & 2. context 熔断(优先级最高)
  const ctx = state.contextUsage;
  if (ctx && typeof ctx === 'object') {
    const pct = numeric(ctx.windowPercent);
    if (pct != null && pct >= thresholds.contextPercent) {
      return {
        tripped: true,
        reason: 'context-window-exceeded',
        field: 'contextUsage.windowPercent',
      };
    }
    const tokens = numeric(ctx.tokens);
    if (tokens != null && tokens > thresholds.contextTokens) {
      return {
        tripped: true,
        reason: 'context-tokens-exceeded',
        field: 'contextUsage.tokens',
      };
    }
  }

  // 3. stagesRun 熔断
  const maxStages = numeric(state.maxStages) ?? 0;
  const stagesRun = numeric(state.stagesRun) ?? 0;
  if (maxStages > 0 && stagesRun >= maxStages) {
    return {
      tripped: true,
      reason: 'max-stages-exceeded',
      field: 'stagesRun',
    };
  }

  // 4. contextUsage 完全缺失 → skipped(不熔断,交人工判断)
  if (ctx == null) {
    return { tripped: false, skipped: true };
  }

  return { tripped: false };
}

export function resolveThresholds(config = {}) {
  const lg = config?.loopGuard ?? {};
  return {
    contextPercent: numeric(lg.contextPercent) ?? DEFAULT_THRESHOLDS.contextPercent,
    contextTokens: numeric(lg.contextTokens) ?? DEFAULT_THRESHOLDS.contextTokens,
    stuckTolerance: numeric(lg.stuckTolerance) ?? DEFAULT_THRESHOLDS.stuckTolerance,
  };
}

export { DEFAULT_THRESHOLDS };

function numeric(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
