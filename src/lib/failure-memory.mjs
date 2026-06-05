/**
 * failure-memory.mjs — LESSONS.md 自动查询 + 失败记录 + bypass 记录
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * 开工前自动查询 LESSONS.md 中与当前任务相关的条目
 * @param {string} specsDir - .specs/<change-id>/ 目录路径
 * @param {object} task - 任务对象 { id, title, writeFiles, body }
 * @returns {{ hits: string[], context: string }}
 */
export function queryBeforeWork(specsDir, task) {
  const lessonsPath = resolveLessonsPath(specsDir);
  if (!lessonsPath || !existsSync(lessonsPath)) {
    return { hits: [], context: '' };
  }

  const content = readFileSync(lessonsPath, 'utf-8');
  const lines = content.split('\n');

  const keywords = buildKeywords(task);
  const hits = [];

  let currentEntry = null;
  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('### ')) {
      if (currentEntry && isRelevant(currentEntry, keywords)) {
        hits.push(currentEntry.trim());
      }
      currentEntry = line + '\n';
    } else if (currentEntry !== null) {
      currentEntry += line + '\n';
    }
  }
  if (currentEntry && isRelevant(currentEntry, keywords)) {
    hits.push(currentEntry.trim());
  }

  const context = hits.length > 0
    ? `⚠️ LESSONS 命中 (${hits.length} 条):\n\n${hits.join('\n\n---\n\n')}`
    : '';

  return { hits, context };
}

/**
 * 任务失败后记录到 LESSONS.md
 * @param {string} specsDir - .specs/<change-id>/ 目录路径
 * @param {object} entry - { taskId, reason, excludedApproaches, timestamp }
 */
export function recordFailure(specsDir, { taskId, reason, excludedApproaches, timestamp }) {
  const lessonsPath = resolveLessonsPath(specsDir);
  if (!lessonsPath) return;

  mkdirSync(dirname(lessonsPath), { recursive: true });
  const ts = timestamp || new Date().toISOString();
  const excluded = (excludedApproaches || []).map(a => `  - ❌ ${a}`).join('\n');

  const entry = `\n\n### [${taskId}] ${reason}\n- 时间: ${ts}\n- 状态: 待确认\n${excluded ? `- 已排除方案:\n${excluded}\n` : ''}`;

  appendFileSync(lessonsPath, entry, 'utf-8');
}

/**
 * --force bypass 时记录到 LESSONS.md
 * @param {string} specsDir - .specs/<change-id>/ 目录路径
 * @param {object} entry - { taskId, reason, timestamp }
 */
export function recordBypass(specsDir, { taskId, reason, timestamp }) {
  const lessonsPath = resolveLessonsPath(specsDir);
  if (!lessonsPath) return;

  mkdirSync(dirname(lessonsPath), { recursive: true });
  const ts = timestamp || new Date().toISOString();
  const entry = `\n\n### [${taskId}] ⚠️ GATE BYPASS (tech debt)\n- 时间: ${ts}\n- 原因: ${reason}\n- 状态: 需要后续处理\n`;

  appendFileSync(lessonsPath, entry, 'utf-8');
}

// --- 内部辅助 ---

function resolveLessonsPath(specsDir) {
  if (!specsDir) return null;
  // LESSONS.md lives at .specs/ level (parent of change dir)
  const parentDir = dirname(specsDir);
  const atParent = join(parentDir, 'LESSONS.md');
  if (existsSync(atParent)) return atParent;

  // Fallback: check in specsDir itself
  const atSpecs = join(specsDir, 'LESSONS.md');
  if (existsSync(atSpecs)) return atSpecs;

  // Fallback: .planning/LESSONS.md
  const planningDir = join(dirname(parentDir), '.planning');
  const atPlanning = join(planningDir, 'LESSONS.md');
  if (existsSync(atPlanning)) return atPlanning;

  // Return parent path for creation
  return atParent;
}

function buildKeywords(task) {
  const keywords = new Set();

  if (task.id) keywords.add(task.id.toLowerCase());
  if (task.title) {
    for (const word of task.title.split(/[\s/\\._-]+/)) {
      if (word.length > 2) keywords.add(word.toLowerCase());
    }
  }
  if (task.writeFiles) {
    for (const f of task.writeFiles) {
      const parts = f.split(/[\s/\\._-]+/);
      for (const p of parts) {
        if (p.length > 2) keywords.add(p.toLowerCase());
      }
    }
  }

  return [...keywords];
}

function isRelevant(entry, keywords) {
  const lower = entry.toLowerCase();
  let matchCount = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) matchCount++;
  }
  // At least 2 keyword matches, or 1 match if few keywords
  return keywords.length <= 2 ? matchCount >= 1 : matchCount >= 2;
}
