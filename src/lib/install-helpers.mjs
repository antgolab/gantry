/**
 * install-helpers
 *
 * 封装 install 阶段 managed entries（侧文件登记条目）的纯函数构造。
 * 供 cli.mjs::installToolsToTarget 使用（T08 接入）。
 */

/**
 * 由 renderer 返回的 `__merge__` 对象构造侧文件登记条目。
 *
 * 入参 content 为 renderer 产出的 `__merge__` merge 对象，含 `addToAllow`
 * 和可选的 `legacyAliases` 字段。返回 `{ 'permissions.allow': [...] }`，
 * 数组是 `addToAllow + legacyAliases` 的拼接（保持顺序，不去重 ——
 * 调用方决定去重策略）。
 *
 * 纯函数：不触碰文件系统，不访问 process.env，不调用 process.exit。
 *
 * @param {{ addToAllow: string[], legacyAliases?: string[] }} content
 * @returns {{ 'permissions.allow': string[] }}
 */
export function buildManagedEntries(content) {
  return {
    'permissions.allow': [
      ...(content.addToAllow || []),
      ...(content.legacyAliases || []),
    ],
  };
}
