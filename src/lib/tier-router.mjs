/**
 * tier-router.mjs — Gantry 判据引擎 (ADR-001 Pipeline 三分模型)
 *
 * decideTier(description, fsSnapshot, config) 为纯函数,无副作用:
 *   1. 硬红线: 命中 detectHardRuleHit (单点收敛于 src/lib/hard-rules.mjs) → full
 *   2. 软打分: 5 个软信号,每命中 +1
 *   3. 档位: score=0 → micro, 1≤score≤2 → light, score≥3 → full
 *
 * tierOverride (--tier) 由 CLI 层处理,本函数不读盘、不碰 process、不消费 config 中的覆写。
 */

import { detectHardRuleHit } from './hard-rules.mjs';

/**
 * 软打分信号常量 (仅 tier-router 关心,非硬红线,允许本地定义 — ADR-001 只约束硬红线单点)。
 */

// 信号 3: 描述命中「重构 / refactor / 架构 / 性能优化」类关键词 (中英双语,大小写不敏感)
const REFACTOR_KEYWORDS = ['重构', 'refactor', 'redesign', '架构', '性能优化', 'performance', 'refactoring'];

// 信号 5: 描述含歧义词 (需求未定型的软信号)
const AMBIGUITY_KEYWORDS = ['可能', '大概', '应该', 'maybe', 'probably', 'should'];

// 信号 4: 变更路径以 config/ 或 infra/ 为前缀 (基建 / 配置类改动)
const CONFIG_INFRA_PREFIXES = ['config/', 'infra/'];

/**
 * 判定 tier 档位。
 *
 * @param {string} description - 变更描述
 * @param {object} fsSnapshot - { modifiedFiles: string[], newFiles: string[], pkgJsonDepsDelta: string[] }
 * @param {object} [config] - 保留参数 (CLI 层承载 tierOverride / 阈值),本函数不消费
 * @returns {{ tier: 'micro'|'light'|'full', hits: string[], score: number }}
 *          hits: 硬红线命中为 [ruleId],软打分为 ['soft:<signal-name>', ...]
 */
export function decideTier(description, fsSnapshot, config = {}) {
  const snapshot = normalizeSnapshot(fsSnapshot);

  // 1. 硬红线优先 (ADR-001 单点收敛,禁在本文件重复定义红线常量)
  const hard = detectHardRuleHit(snapshot, description);
  if (hard.hit) {
    return { tier: 'full', hits: [hard.ruleId], score: 0 };
  }

  // 2. 软打分
  const { hits, score } = softScore(snapshot, description);

  // 3. 档位
  const tier = score >= 3 ? 'full' : score >= 1 ? 'light' : 'micro';

  return { tier, hits, score };
}

/**
 * 软打分: 5 个信号,每命中 +1。
 *   soft:multi-file        — modifiedFiles.length > 1
 *   soft:new-file          — newFiles.length > 0
 *   soft:refactor-keyword  — 描述命中重构/架构/性能优化类关键词
 *   soft:config-infra      — 任一变更路径以 config/ 或 infra/ 为前缀
 *   soft:ambiguous         — 描述含歧义词
 */
function softScore(snapshot, description) {
  const hits = [];
  let score = 0;
  const lower = String(description ?? '').toLowerCase();
  const files = [...snapshot.modifiedFiles, ...snapshot.newFiles];

  if (snapshot.modifiedFiles.length > 1) {
    score += 1;
    hits.push('soft:multi-file');
  }

  if (snapshot.newFiles.length > 0) {
    score += 1;
    hits.push('soft:new-file');
  }

  if (REFACTOR_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
    score += 1;
    hits.push('soft:refactor-keyword');
  }

  if (files.some((f) => CONFIG_INFRA_PREFIXES.some((p) => f.startsWith(p)))) {
    score += 1;
    hits.push('soft:config-infra');
  }

  if (AMBIGUITY_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
    score += 1;
    hits.push('soft:ambiguous');
  }

  return { hits, score };
}

function normalizeSnapshot(fsSnapshot) {
  const s = fsSnapshot || {};
  return {
    modifiedFiles: Array.isArray(s.modifiedFiles) ? s.modifiedFiles : [],
    newFiles: Array.isArray(s.newFiles) ? s.newFiles : [],
    pkgJsonDepsDelta: Array.isArray(s.pkgJsonDepsDelta) ? s.pkgJsonDepsDelta : [],
  };
}
