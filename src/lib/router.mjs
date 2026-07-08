/**
 * router.mjs — 智能路由：意图识别 + 规模预估 + 流程深度自动选择
 *
 * Two-step: 1) intent keyword parse → 2) code impact scan (grep/find estimate)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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
 * @returns {{ pipeline: Pipeline, model: string, scale: Scale, rationale: string, parallel: boolean }}
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

  const modelMap = {
    trivial: 'fast',
    small: 'fast',
    medium: 'standard',
    large: 'deep',
    architectural: 'deep',
  };

  return {
    pipeline,
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
      // 数组传参 + 走 execFile（不经 shell），关键词作为 grep 的独立参数，
      // 彻底消除命令注入与中文/特殊字符导致的 shell 解析崩溃。
      // -F 固定字符串匹配，避免 kw 被当正则；-l 只列文件名，按行计数即命中文件数。
      const result = execFileSync(
        'grep',
        ['-rlF', kw, '--include=*.mjs', '--include=*.js', '--include=*.ts', '--include=*.tsx', '.'],
        { cwd: projectRoot, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      totalHits += result.split('\n').filter(Boolean).length;
    } catch {
      // grep 无匹配时退出码非 0（execFileSync 抛错）或超时 → 视作 0 命中
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

/**
 * Reroute — 基于累积工件重新评估规模。
 *
 * 修复"路由是一次性决策"的反馈环漏洞：每次推进前用 CHANGE+REQUIREMENT+DESIGN+TASK
 * 的累积文本作为新输入，对比当前 pipeline 是否仍匹配实际规模。
 *
 * 设计约束：
 *   - 只升级、不降级（避免在 estimate 抖动时乒乓）
 *   - taskCount 是真实信号，权重高于关键词
 *   - 文本太稀疏时（< 200 字符）不做意图升级，避免 default=medium 引发的虚假升级
 *   - 返回 advisory，由调用方决定是否实际改 state
 *
 * @param {string} currentPipeline - 当前 pipeline
 * @param {object} signals - { artifactsText, taskCount }
 * @returns {{ shouldUpgrade: boolean, newPipeline: Pipeline, scale: Scale, reason: string }}
 */
export function reroute(currentPipeline, signals = {}) {
  const { artifactsText = '', taskCount = 0 } = signals;
  const PIPELINE_RANK = { light: 0, standard: 1, full: 2 };
  const MIN_TEXT_FOR_REROUTE = 200; // 文本不足 200 字符时不做意图升级

  // 信号 1：从累积工件文本估算规模
  // 防误升：文本太短或没有任何关键词命中时，跳过本路径
  let intentPipeline = null;
  let intentScale = null;
  if (artifactsText.length >= MIN_TEXT_FOR_REROUTE) {
    intentScale = estimateScaleConservative(artifactsText);
    if (intentScale) {
      intentPipeline = PIPELINE_MAP[intentScale];
    }
  }

  // 信号 2：任务数升级
  const { upgraded, newPipeline: taskPipeline, reason: taskReason } = checkUpgrade(currentPipeline, taskCount);

  // 取两个信号中的最高
  let target = currentPipeline;
  const reasons = [];
  if (intentPipeline && PIPELINE_RANK[intentPipeline] > PIPELINE_RANK[target]) {
    target = intentPipeline;
    reasons.push(`artifacts indicate ${intentScale} (→ ${intentPipeline})`);
  }
  if (upgraded && PIPELINE_RANK[taskPipeline] > PIPELINE_RANK[target]) {
    target = taskPipeline;
    reasons.push(taskReason);
  }

  const shouldUpgrade = PIPELINE_RANK[target] > PIPELINE_RANK[currentPipeline];
  return {
    shouldUpgrade,
    newPipeline: target,
    scale: intentScale,
    reason: shouldUpgrade ? reasons.join('; ') : 'no upgrade needed',
  };
}

/**
 * 保守版本的 estimateFromIntent：仅在确实命中关键词时返回，否则 null
 * （estimateFromIntent 在无命中时默认返回 'medium'，对累积工件文本会引发误升级）
 */
function estimateScaleConservative(text) {
  for (const [scale, patterns] of INTENT_SIGNALS_ORDERED) {
    for (const pattern of patterns) {
      if (pattern.test(text)) return scale;
    }
  }
  return null;
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
  // 同时按 ASCII 空白/标点分词，并把连续的中日韩字符切成 2 字段对作为粗略关键词。
  const tokens = [];
  for (const part of intent.split(/[\s,;.!?，。；：、!?]+/)) {
    if (!part) continue;
    if (/^[一-鿿]+$/.test(part)) {
      // 纯中文片段：用 2-gram 抽取关键词候选
      for (let i = 0; i + 1 < part.length; i++) {
        tokens.push(part.slice(i, i + 2));
      }
      if (part.length <= 4) tokens.push(part);
    } else {
      tokens.push(part);
    }
  }
  return tokens
    .filter(w => w.length > 1 && !stopwords.has(w.toLowerCase()))
    .slice(0, 8);
}

function buildRationale(intentScale, codeScale, finalScale) {
  let r = `Intent signals: ${intentScale}`;
  if (codeScale) r += `, code impact: ${codeScale}`;
  if (finalScale !== intentScale) r += ` → upgraded to ${finalScale}`;
  return r;
}
