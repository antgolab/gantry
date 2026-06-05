/**
 * tasks.mjs — TASK.md XML 解析 + wave 分组 + 执行调度
 * 解析 gantry 的 TASK.md 格式，支持 wave 并行执行
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectConflicts } from './scope-guard.mjs';

/**
 * 解析 TASK.md 中的任务列表
 * 支持 XML 格式: <task id="T01" status="pending" parallel="true" depends="T00">
 * @param {string} taskMdPath - TASK.md 文件路径
 * @returns {Array} 任务数组
 */
export function parseTasks(taskMdPath) {
  if (!existsSync(taskMdPath)) return [];

  const content = readFileSync(taskMdPath, 'utf-8');
  const tasks = [];

  // 匹配 <task ...>...</task> 块
  const taskRegex = /<task\s+([^>]+)>([\s\S]*?)<\/task>/g;
  let match;

  while ((match = taskRegex.exec(content)) !== null) {
    const attrs = parseAttributes(match[1]);
    const body = match[2].trim();

    tasks.push({
      id: attrs.id || `T${tasks.length.toString().padStart(2, '0')}`,
      status: attrs.status || 'pending',
      parallel: attrs.parallel === 'true' || attrs.parallel === '[P]',
      depends: attrs.depends ? attrs.depends.split(',').map(s => s.trim()) : [],
      title: extractTitle(body),
      readFiles: extractList(body, 'read_files'),
      writeFiles: extractList(body, 'write_files'),
      verify: extractField(body, 'verify'),
      body,
    });
  }

  // 如果没有 XML 格式，尝试解析简单列表格式
  if (tasks.length === 0) {
    return parseSimpleFormat(content);
  }

  return tasks;
}

/**
 * 将任务分组为 waves（基于依赖关系）
 * @param {Array} tasks - 任务数组
 * @returns {Array<Array>} waves 数组，每个 wave 包含可并行执行的任务
 */
export function groupWaves(tasks) {
  const pending = tasks.filter(t => t.status !== 'done');
  if (pending.length === 0) return [];

  const waves = [];
  const done = new Set(tasks.filter(t => t.status === 'done').map(t => t.id));
  const remaining = new Set(pending.map(t => t.id));

  let safety = 0;
  while (remaining.size > 0 && safety < 100) {
    const wave = [];
    for (const task of pending) {
      if (!remaining.has(task.id)) continue;
      const depsResolved = task.depends.every(dep => done.has(dep));
      if (depsResolved) {
        wave.push(task);
      }
    }

    if (wave.length === 0) {
      // 循环依赖或无法解析 — 强制取第一个
      const first = pending.find(t => remaining.has(t.id));
      if (first) wave.push(first);
      else break;
    }

    // Conflict detection: split wave if write_files overlap
    const { forced } = detectConflicts(wave);
    const safeWave = wave.filter(t => !forced.includes(t.id));
    const conflicted = wave.filter(t => forced.includes(t.id));

    if (safeWave.length > 0) {
      waves.push(safeWave);
      for (const t of safeWave) {
        done.add(t.id);
        remaining.delete(t.id);
      }
    }
    // Conflicted tasks stay in remaining for next iteration (forced sequential)
    if (safeWave.length === 0 && conflicted.length > 0) {
      // All tasks conflict — take first one only
      waves.push([conflicted[0]]);
      done.add(conflicted[0].id);
      remaining.delete(conflicted[0].id);
    }
    safety++;
  }

  return waves;
}

/**
 * 获取下一个待执行的任务
 */
export function getNextTask(tasks) {
  const waves = groupWaves(tasks);
  if (waves.length === 0) return null;
  return waves[0][0];
}

/**
 * 获取当前 wave 中的所有任务
 */
export function getCurrentWave(tasks) {
  const waves = groupWaves(tasks);
  if (waves.length === 0) return [];
  return waves[0];
}

/**
 * 检查所有任务是否完成
 */
export function allTasksDone(tasks) {
  return tasks.length > 0 && tasks.every(t => t.status === 'done');
}

/**
 * 获取任务执行进度
 */
export function getProgress(tasks) {
  if (tasks.length === 0) return { total: 0, done: 0, percent: 0 };
  const done = tasks.filter(t => t.status === 'done').length;
  return {
    total: tasks.length,
    done,
    pending: tasks.length - done,
    percent: Math.round((done / tasks.length) * 100),
  };
}

// --- 内部辅助 ---

function parseAttributes(attrStr) {
  const attrs = {};
  const regex = /(\w+)="([^"]*?)"/g;
  let m;
  while ((m = regex.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function extractTitle(body) {
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('-') && !trimmed.startsWith('<')) {
      return trimmed.replace(/^#+\s*/, '');
    }
  }
  return '';
}

function extractList(body, field) {
  const regex = new RegExp(`${field}:\\s*\\[([^\\]]+)\\]`, 'i');
  const match = body.match(regex);
  if (!match) return [];
  return match[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
}

function extractField(body, field) {
  const regex = new RegExp(`${field}:\\s*(.+)`, 'i');
  const match = body.match(regex);
  return match ? match[1].trim() : null;
}

function parseSimpleFormat(content) {
  const tasks = [];
  const lines = content.split('\n');
  let currentTask = null;

  for (const line of lines) {
    // 匹配 "- [ ] T01: 标题" 或 "- [x] T01: 标题"
    const match = line.match(/^-\s*\[([ xX])\]\s*(T\d+):\s*(.+)/);
    if (match) {
      if (currentTask) tasks.push(currentTask);
      currentTask = {
        id: match[2],
        status: match[1] === ' ' ? 'pending' : 'done',
        parallel: line.includes('[P]'),
        depends: [],
        title: match[3],
        readFiles: [],
        writeFiles: [],
        verify: null,
        body: match[3],
      };
    }
  }
  if (currentTask) tasks.push(currentTask);
  return tasks;
}
