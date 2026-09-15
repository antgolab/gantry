/**
 * friction.mjs — Friction 事件流采集 + 打分 (ADR-004)
 *
 * 事件流只落 EXECUTION.md 的 `## friction-events` 段 (不进 STATE.md)。
 * - recordEvent(changeId, {kind, ts, meta}) → 追加一行 JSON 到段尾
 * - getEvents(changeId) → 解析事件流回 [{kind, ts, meta}]
 * - getScore(changeId, weights) → 按 weights[kind] 加权求和
 *
 * kind 白名单与 config-schema 默认 weights 键严格对齐 (L-001)。
 * 零依赖,纯 Node.js。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { specsPath } from './paths.mjs';
import { DEFAULT_LEARNINGS_CONFIG } from './config-schema.mjs';

const SECTION_HEADER = '## friction-events';
const EXECUTION_HEADER = '# EXECUTION';
const NEXT_SECTION_RE = /^##[ \t]/m;

/** 合法事件 kind — 与 config-schema 默认 weights 键严格对齐 (L-001)。 */
export const FRICTION_KINDS = Object.keys(DEFAULT_LEARNINGS_CONFIG.friction.weights);

/**
 * 追加一条摩擦事件。
 * @param {string} changeId
 * @param {{kind: string, ts?: string, meta?: object}} event
 * @param {object|string} [opts] - { baseDir } 或 baseDir 字符串,覆盖默认 `.gantry/specs` 前缀 (测试用)
 */
export function recordEvent(changeId, event, opts = {}) {
  const { kind, ts, meta } = normalizeEvent(event);
  if (!FRICTION_KINDS.includes(kind)) {
    throw new Error(`未知 friction 事件 kind: ${kind}`);
  }

  const line = JSON.stringify({ kind, ts, meta });
  const filePath = executionPath(changeId, resolveBaseDir(opts));

  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${EXECUTION_HEADER}\n\n${SECTION_HEADER}\n${line}\n`, 'utf-8');
    return;
  }

  // 读改写 + rename 原子落盘 (非 seek+write)
  const content = readFileSync(filePath, 'utf-8');
  const next = appendToContent(content, line);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, next, 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * 解析事件流。
 * @param {string} changeId
 * @param {object|string} [opts] - { baseDir } 或 baseDir 字符串
 * @returns {{kind: string, ts: string, meta: object}[]}
 */
export function getEvents(changeId, opts = {}) {
  const filePath = executionPath(changeId, resolveBaseDir(opts));
  if (!existsSync(filePath)) return [];
  return parseEvents(readFileSync(filePath, 'utf-8'));
}

/**
 * 按 weights[kind] 加权求和,未知 kind 权重视为 0。
 * @param {string} changeId
 * @param {object} weights - {[kind]: number}
 * @param {object|string} [opts] - { baseDir } 或 baseDir 字符串
 * @returns {number}
 */
export function getScore(changeId, weights, opts = {}) {
  const events = getEvents(changeId, opts);
  const w = weights && typeof weights === 'object' ? weights : {};
  let score = 0;
  for (const e of events) {
    const v = w[e.kind];
    if (typeof v === 'number') score += v;
  }
  return score;
}

// --- 内部 ---

function resolveBaseDir(opts) {
  if (opts == null) return null;
  if (typeof opts === 'string') return opts;
  if (typeof opts === 'object' && typeof opts.baseDir === 'string') return opts.baseDir;
  return null;
}

function executionPath(changeId, baseDir) {
  if (baseDir) return join(baseDir, changeId, 'EXECUTION.md');
  return specsPath(changeId, 'EXECUTION.md');
}

function normalizeEvent(event) {
  const e = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  return {
    kind: e.kind,
    ts: typeof e.ts === 'string' && e.ts ? e.ts : new Date().toISOString(),
    meta: e.meta && typeof e.meta === 'object' && !Array.isArray(e.meta) ? e.meta : {},
  };
}

/**
 * 将事件行追加到 content 的 `## friction-events` 段。
 * 段边界: 段头之后到下一个 `## ` (或文件末)。
 */
function appendToContent(content, line) {
  const headerRe = /^## friction-events[ \t]*$/m;
  const hm = headerRe.exec(content);

  if (!hm) {
    // 无段头 → 在文件末追加段头 + 事件行 (与既有多段之间留空行隔离)
    const trimmed = content.replace(/\n+$/, '');
    const prefix = trimmed ? `${trimmed}\n\n` : '';
    return `${prefix}${SECTION_HEADER}\n${line}\n`;
  }

  // 段已存在 → 在下个 `## ` 段头前插入;若段是文件末段,收敛尾换行后追加
  const afterHeader = content.slice(hm.index + hm[0].length);
  const next = NEXT_SECTION_RE.exec(afterHeader);
  if (next) {
    const at = hm.index + hm[0].length + next.index;
    return content.slice(0, at) + line + '\n' + content.slice(at);
  }
  return content.replace(/\n+$/, '') + '\n' + line + '\n';
}

function parseEvents(content) {
  const events = [];
  let inSection = false;
  for (const raw of content.split('\n')) {
    if (raw.trim() === SECTION_HEADER) {
      inSection = true;
      continue;
    }
    if (NEXT_SECTION_RE.test(raw)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;

    const t = raw.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj.kind === 'string') events.push(obj);
    } catch {
      // 跳过非 JSON 行
    }
  }
  return events;
}
