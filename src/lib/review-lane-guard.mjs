/**
 * review-lane-guard.mjs — REVIEW lane 上下文隔离 gate (纯逻辑)
 *
 * small-team-mode T14:DEV lane 的上下文(kind=dev-log / dev 目录 / 执行日志)
 * 不得泄漏进 REVIEW 阶段的 context-pack。checkPack 只做纯判定,不读写文件系统、
 * 不接触 state/CLI —— exit code 与 state.pauseReason 集成留给上层。
 */

// DEV 上下文路径模式:dev/ 目录、execution.log、task-*.log
const DEV_PATH_RE = /(?:^|\/)dev\/|execution\.log$|task-.*\.log$/;

/**
 * 判定单条 loadOrder 条目是否命中 DEV 上下文模式。
 * 命中条件(满足任一即视为 DEV 上下文):
 *   - kind === 'dev-log'
 *   - path 命中 DEV_PATH_RE
 */
function isDevContextEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.kind === 'dev-log') return true;
  if (typeof entry.path === 'string' && DEV_PATH_RE.test(entry.path)) return true;
  return false;
}

/**
 * 检查 pack 是否泄漏 DEV 上下文 (扫描 pack.loadOrder)。
 *
 * 纯函数:同输入恒同输出,无副作用。
 *
 * @param {object} pack - context-pack 对象
 * @param {object} [opts]
 * @param {boolean} [opts.strict=true] - strict 时任一 violation 即 ok=false;
 *   strict=false 时仍收集 violations(供审计)但 ok 恒为 true(放行)。
 * @returns {{ ok: boolean, violations: Array<{path: string, kind: string, reason: string}> }}
 */
export function checkPack(pack, { strict = true } = {}) {
  const violations = [];
  const entries = Array.isArray(pack?.loadOrder) ? pack.loadOrder : [];

  for (const entry of entries) {
    if (!isDevContextEntry(entry)) continue;
    violations.push({
      path: entry.path ?? '',
      kind: entry.kind ?? 'unknown',
      reason: entry.kind === 'dev-log'
        ? 'kind=dev-log 属 DEV lane 上下文,禁止进入 REVIEW pack'
        : 'path 命中 DEV 上下文路径模式 (dev/、execution.log、task-*.log)',
    });
  }

  const ok = strict ? violations.length === 0 : true;
  return { ok, violations };
}
