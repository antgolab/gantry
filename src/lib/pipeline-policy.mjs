const VALID_PIPELINES = new Set(['full', 'light']);

export function normalizePipeline(value) {
  const pipeline = value || 'full';
  if (pipeline === 'standard') return 'full';
  if (VALID_PIPELINES.has(pipeline)) return pipeline;
  throw new Error(`未知 pipeline: ${pipeline}（可用: full, light）`);
}

// 注：原 `LIGHT_RISK_RULES` / `assessLightEligibility` 已删除（DESIGN D10 / AC-12）。
// 红线定义唯一源 = src/lib/hard-rules.mjs#detectHardRuleHit / detectRedLines，
// 创建期预检与执行期守卫共用同一套关键词，不再并存第二份定义。

/**
 * 从 PROPOSAL.md 判断本次 change 是否影响用户可见 UI。
 *
 * ui-design 阶段已合入 2-design.md(2026-09-21 · 方向 A'):字段不再驱动
 * pipeline 分支,但仍是 design 阶段决定"§ 8 前端 UI 设计"小节是否展开的
 * 事实源。字段保留:0-change.md 步骤 0.5 依旧要求 PROPOSAL 写清 uiImpact,
 * design 阶段读它决定要不要写前端小节。
 */
export function proposalHasUiImpact(text = '') {
  const content = String(text);
  return /(?:^|\n)\s*uiImpact\s*:\s*true\b/im.test(content)
    || /(?:^|\n)\s*-?\s*\*{0,2}UI\s*影响\*{0,2}\s*:\s*`?(?:是|true|yes)`?\s*$/im.test(content);
}
