/**
 * review-lane-guard.mjs — REVIEW lane 上下文隔离 gate (纯逻辑)
 *
 * 按 context-pack schema v2 的 `kind` 字段白名单隔离 REVIEW lane 上下文,
 * 不再按路径黑名单 (DEV_PATH_RE 已废除, 见 ADR-REVBL-004)。
 * checkPack 只做纯判定, 不读写文件系统、不接触 state/CLI ——
 * exit code 与 state.pauseReason 集成留给上层。
 */

/**
 * REVIEW lane 允许装载的 context-pack entry kind 白名单。
 *
 * 集合构成:
 *   - 未来预留 schema v3+ kind: spec-doc / design-doc / review-doc / test-doc / adr
 *   - 现仓真实使用 kind: context-doc / agent-prompt / phase-prompt
 *     (以上 3 个同时是 TASKS 初始白名单成员)
 *   - DEV 阶段 grep 全仓 (`.gantry/core/**`, `src/**`) 补齐遗漏:
 *       artifact (SPEC/DESIGN/TASKS 等 change 工件, REVIEW 必读)
 *       lessons  (LESSONS.md, REVIEW 查阅历史教训)
 *       learning (单条 team learning 条目, REVIEW 可能需要)
 *   - progress 刻意不加入: 它是 DEV 中断恢复产物 (`<task-id>-PROGRESS.md`),
 *     REVIEW 不消费。
 */
export const ALLOWED_REVIEW_KINDS = [
  'spec-doc', 'design-doc', 'review-doc', 'test-doc',
  'adr', 'context-doc', 'agent-prompt', 'phase-prompt',
  'artifact', 'lessons', 'learning',
];

/**
 * 按 kind 白名单检查 pack 是否含 REVIEW lane 不应装载的上下文。
 *
 * 纯函数:同输入恒同输出,无副作用。
 *
 * @param {object} pack - context-pack 对象
 * @param {object} [opts]
 * @param {string} [opts.lane] - 当前 lane;非 'review' 时不做过滤,
 *   allowed 直接等于 pack.loadOrder (保持其他 lane 不受影响)。
 * @param {string[]} [opts.allowKind=[]] - escape hatch:额外放行的 kind
 *   (对应 CLI `--allow-kind <kind>`),不改白名单常量。
 * @returns {{ allowed: Array<object>, blocked: Array<{path: string, kind: string, reason: string}> }}
 */
export function checkPack(pack, { lane, allowKind = [] } = {}) {
  const entries = Array.isArray(pack?.loadOrder) ? pack.loadOrder : [];

  if (lane !== 'review') {
    return { allowed: entries, blocked: [] };
  }

  const allowed = [];
  const blocked = [];

  for (const entry of entries) {
    const kind = entry?.kind ?? 'unknown';
    if (ALLOWED_REVIEW_KINDS.includes(kind) || allowKind.includes(kind)) {
      allowed.push(entry);
    } else {
      blocked.push({
        path: entry?.path ?? '',
        kind,
        reason: `kind "${kind}" 不在 ALLOWED_REVIEW_KINDS 白名单`,
      });
    }
  }

  return { allowed, blocked };
}
