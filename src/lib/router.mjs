/**
 * router.mjs — 智能路由：意图识别 + 规模预估 + 流程深度自动选择
 *
 * Two-step: 1) intent keyword parse → 2) code impact scan (grep/find estimate)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const SCALE_THRESHOLDS = {
  trivial: { maxFiles: 2, maxLines: 10 },
  small: { maxFiles: 5, maxLines: 50 },
  medium: { maxFiles: 15, maxLines: 500 },
  large: { maxFiles: 50, maxLines: 2000 },
};

const PIPELINE_MAP = {
  trivial: 'light',
  small: 'light',
  medium: 'standard',
  large: 'full',
  architectural: 'full',
};

const STAGE_MAP = {
  light: ['dev', 'verify'],
  standard: ['task', 'dev', 'test', 'review'],
  full: ['design', 'task', 'dev', 'test', 'review', 'integration'],
};

const INTENT_SIGNALS_ORDERED = [
  ['trivial', [
    /typo/i, /拼写/i, /comment/i, /注释/i, /format/i,
    /config/i, /配置/i, /version/i, /版本/i, /readme/i,
  ]],
  ['architectural', [
    /migrat/i, /re-?architect/i, /换(技术)?栈/i, /重构.*架构/i,
    /new service/i, /microservice/i, /新(增)?服务/i,
  ]],
  ['large', [
    /refactor/i, /重构/i, /overhaul/i, /redesign/i,
    /multi.?module/i, /跨模块/i, /全面/i,
  ]],
  ['medium', [
    /feature/i, /功能/i, /implement/i, /实现/i,
    /add.*support/i, /新增/i, /集成/i,
  ]],
  ['small', [
    /fix/i, /bug/i, /修复/i, /patch/i, /hotfix/i,
    /update/i, /更新/i, /adjust/i,
  ]],
];

/**
 * @typedef {'trivial'|'small'|'medium'|'large'|'architectural'} Scale
 * @typedef {'light'|'standard'|'full'} Pipeline
 */

/**
 * 根据意图和上下文自动路由
 * @param {string} intent - 用户意图描述
 * @param {object} context - { projectRoot?, gitStatus? }
 * @returns {{ pipeline: Pipeline, stages: string[], model: string, scale: Scale, rationale: string, parallel: boolean }}
 */
export function route(intent, context = {}) {
  const { projectRoot } = context;

  // Step 1: Intent keyword parse
  const intentScale = estimateFromIntent(intent);

  // Step 2: Code impact scan
  const codeScale = projectRoot ? estimateFromCode(intent, projectRoot) : null;

  // Take the larger of the two estimates
  const scale = resolveScale(intentScale, codeScale);
  const pipeline = PIPELINE_MAP[scale];
  const stages = STAGE_MAP[pipeline];

  const modelMap = {
    trivial: 'fast',
    small: 'fast',
    medium: 'standard',
    large: 'deep',
    architectural: 'deep',
  };

  return {
    pipeline,
    stages,
    model: modelMap[scale],
    scale,
    parallel: scale !== 'trivial' && scale !== 'small',
    rationale: buildRationale(intentScale, codeScale, scale),
  };
}

/**
 * 规模预估（仅基于意图关键词）
 * @param {string} intent
 * @returns {Scale}
 */
export function estimateFromIntent(intent) {
  for (const [scale, patterns] of INTENT_SIGNALS_ORDERED) {
    for (const pattern of patterns) {
      if (pattern.test(intent)) return scale;
    }
  }
  return 'medium';
}

/**
 * 规模预估（基于代码影响扫描）
 * @param {string} intent
 * @param {string} projectRoot
 * @returns {Scale|null}
 */
export function estimateFromCode(intent, projectRoot) {
  const keywords = extractSearchTerms(intent);
  if (keywords.length === 0) return null;

  let totalHits = 0;
  for (const kw of keywords.slice(0, 3)) {
    try {
      const result = execSync(
        `grep -rl "${kw}" --include="*.mjs" --include="*.js" --include="*.ts" --include="*.tsx" . 2>/dev/null | wc -l`,
        { cwd: projectRoot, encoding: 'utf-8', timeout: 5000 }
      ).trim();
      totalHits += parseInt(result, 10) || 0;
    } catch {
      // grep failed or timed out
    }
  }

  if (totalHits === 0) return null;
  if (totalHits <= 2) return 'trivial';
  if (totalHits <= 5) return 'small';
  if (totalHits <= 15) return 'medium';
  if (totalHits <= 50) return 'large';
  return 'architectural';
}

/**
 * 运行时自动升级：如果任务数超过当前管线阈值，升级管线
 * @param {string} currentPipeline - 当前管线
 * @param {number} taskCount - 实际任务数
 * @returns {{ upgraded: boolean, newPipeline: Pipeline, reason: string }}
 */
export function checkUpgrade(currentPipeline, taskCount) {
  const thresholds = { light: 3, standard: 8 };
  const threshold = thresholds[currentPipeline];

  if (threshold && taskCount > threshold) {
    const newPipeline = currentPipeline === 'light' ? 'standard' : 'full';
    return {
      upgraded: true,
      newPipeline,
      reason: `Task count (${taskCount}) exceeds ${currentPipeline} threshold (${threshold})`,
    };
  }

  return { upgraded: false, newPipeline: currentPipeline, reason: '' };
}

// --- 内部辅助 ---

function resolveScale(intentScale, codeScale) {
  if (!codeScale) return intentScale;
  const order = ['trivial', 'small', 'medium', 'large', 'architectural'];
  const intentIdx = order.indexOf(intentScale);
  const codeIdx = order.indexOf(codeScale);
  return order[Math.max(intentIdx, codeIdx)];
}

function extractSearchTerms(intent) {
  const stopwords = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'for', 'in', 'on', 'of', 'and', 'or', 'with', 'this', 'that', '的', '了', '是', '在', '把', '将', '和', '与']);
  return intent
    .split(/[\s,;.!?]+/)
    .filter(w => w.length > 2 && !stopwords.has(w.toLowerCase()))
    .slice(0, 5);
}

function buildRationale(intentScale, codeScale, finalScale) {
  let r = `Intent signals: ${intentScale}`;
  if (codeScale) r += `, code impact: ${codeScale}`;
  if (finalScale !== intentScale) r += ` → upgraded to ${finalScale}`;
  return r;
}
