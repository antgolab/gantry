/**
 * tasks.mjs — TASKS.md XML 解析 + wave 分组 + 执行调度
 * 解析 gantry 的 TASKS.md 格式（兼容 TASK.md），支持 wave 并行执行
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findResourceConflicts } from './scope-guard.mjs';

const DEFAULT_SCHEDULER_OPTIONS = {
  maxParallelism: 6,
  respectParallel: true,
  repairBudget: 8,
};

/**
 * 解析 TASKS.md/TASK.md 中的任务列表
 * 支持 XML 格式: <task id="T01" status="pending" parallel="true" depends="T00">
 * @param {string} taskMdPath - TASKS.md/TASK.md 文件路径
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
      depends: parseDepends(attrs.depends, body),
      title: extractTitle(body),
      readFiles: extractList(body, 'read_files'),
      writeFiles: extractList(body, 'write_files'),
      verify: extractField(body, 'verify'),
      estimate: parseEstimate(attrs.estimate, body),
      risk: parseRisk(attrs.risk, body),
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
 * 生成 wave 调度计划和可解释诊断。
 * 使用 Kahn 拓扑调度分层；每层内按资源冲突做有界批处理，避免过宽 wave。
 * @param {Array} tasks
 * @param {object} options
 * @returns {{ waves: Array<Array>, diagnostics: Array<object>, repairs: Array<object> }}
 */
export function scheduleWaves(tasks, options = {}) {
  const config = { ...DEFAULT_SCHEDULER_OPTIONS, ...options };
  const diagnostics = [];
  const repairResult = autoRepairTaskGraph(tasks, config);
  const scheduledTasks = repairResult.tasks;
  const repairs = repairResult.repairs;
  diagnostics.push(...repairResult.diagnostics);
  validateTaskGraph(scheduledTasks);

  const pending = scheduledTasks.filter(t => t.status !== 'done');
  if (pending.length === 0) return { waves: [], diagnostics, repairs };

  const waves = [];
  const done = new Set(scheduledTasks.filter(t => t.status === 'done').map(t => t.id));
  const remaining = new Set(pending.map(t => t.id));

  while (remaining.size > 0) {
    const ready = [];
    for (const task of pending) {
      if (!remaining.has(task.id)) continue;
      const depsResolved = task.depends.every(dep => done.has(dep));
      if (depsResolved) {
        ready.push(task);
      }
    }

    if (ready.length === 0) {
      throw schedulerError('No schedulable tasks found; dependency graph is blocked', [{
        type: 'blocked',
        remaining: [...remaining],
        done: [...done],
      }]);
    }

    const batches = buildReadyBatches(ready, config, diagnostics);
    for (const batch of batches) {
      waves.push(batch);
      for (const task of batch) {
        done.add(task.id);
        remaining.delete(task.id);
      }
    }
  }

  return { waves, diagnostics, repairs };
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
  if (match) return splitList(match[1]);

  const tagRegex = new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`, 'i');
  const tagMatch = body.match(tagRegex);
  if (!tagMatch) return [];
  return splitList(tagMatch[1]);
}

function extractField(body, field) {
  const regex = new RegExp(`${field}:\\s*(.+)`, 'i');
  const match = body.match(regex);
  if (match) return match[1].trim();

  const tagRegex = new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`, 'i');
  const tagMatch = body.match(tagRegex);
  return tagMatch ? tagMatch[1].trim() : null;
}

function splitList(value) {
  return value
    .split(/[\n,]/)
    .map(s => s.trim().replace(/^[-*]\s*/, '').replace(/['"]/g, ''))
    .filter(Boolean);
}

function parseDepends(attrDepends, body) {
  const raw = attrDepends || extractField(body, 'depends_on') || extractField(body, 'depends') || '';
  return splitList(raw);
}

function parseEstimate(attrEstimate, body) {
  const raw = attrEstimate || extractField(body, 'estimate') || extractField(body, 'size') || '';
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function parseRisk(attrRisk, body) {
  const raw = (attrRisk || extractField(body, 'risk') || '').toLowerCase();
  if (['high', 'medium', 'low'].includes(raw)) return raw;
  return 'medium';
}

function autoRepairTaskGraph(tasks, config) {
  let repairedTasks = cloneTasks(tasks);
  const repairs = [];
  const diagnostics = [];

  const cheap = repairCheapDependencyIssues(repairedTasks);
  repairedTasks = cheap.tasks;
  repairs.push(...cheap.repairs);
  diagnostics.push(...cheap.diagnostics);

  let guard = 0;
  while (guard < config.repairBudget) {
    const issues = analyzeTaskGraph(repairedTasks);
    if (issues.length === 0) {
      return { tasks: repairedTasks, repairs, diagnostics };
    }

    const repair = selectSafeRepair(repairedTasks, issues);
    if (!repair) {
      if (repairs.length > 0) {
        diagnostics.push({
          type: 'repair-stopped',
          reason: 'remaining graph issues are not safe to repair automatically',
          issues,
        });
      }
      return { tasks: repairedTasks, repairs, diagnostics };
    }

    const candidate = applyRepairToTasks(repairedTasks, repair);
    const candidateIssues = analyzeTaskGraph(candidate);
    if (candidateIssues.length >= issues.length) {
      diagnostics.push({
        type: 'repair-rejected',
        reason: 'candidate did not reduce graph issues',
        repair,
      });
      return { tasks: repairedTasks, repairs, diagnostics };
    }

    repair.applied = true;
    repairedTasks = candidate;
    repairs.push(repair);
    diagnostics.push({
      type: 'schedule-repair',
      taskId: repair.taskId,
      action: repair.action,
      reason: repair.reason,
      confidence: repair.confidence,
    });
    guard++;
  }

  diagnostics.push({
    type: 'repair-budget-exhausted',
    reason: `stopped after ${config.repairBudget} repairs`,
  });
  return { tasks: repairedTasks, repairs, diagnostics };
}

function cloneTasks(tasks) {
  return tasks.map(task => ({
    ...task,
    depends: [...(task.depends || [])],
    readFiles: [...(task.readFiles || [])],
    writeFiles: [...(task.writeFiles || [])],
  }));
}

function repairCheapDependencyIssues(tasks) {
  const repairs = [];
  const diagnostics = [];
  const repaired = cloneTasks(tasks);
  const ids = new Set(repaired.map(t => t.id));

  for (const task of repaired) {
    const normalized = [];
    const seen = new Set();
    for (const dep of task.depends || []) {
      if (dep === task.id) {
        const repair = {
          action: 'remove-dependency',
          taskId: task.id,
          dependency: dep,
          confidence: 'high',
          reason: 'self dependency cannot be valid',
          applied: true,
        };
        repairs.push(repair);
        diagnostics.push({ type: 'schedule-repair', ...repair });
        continue;
      }

      const normalizedDep = ids.has(dep) ? dep : findUniqueDependencyId(dep, ids);
      if (normalizedDep && normalizedDep !== dep) {
        const repair = {
          action: 'replace-dependency',
          taskId: task.id,
          from: dep,
          to: normalizedDep,
          confidence: 'high',
          reason: 'dependency id has a unique normalized match',
          applied: true,
        };
        repairs.push(repair);
        diagnostics.push({ type: 'schedule-repair', ...repair });
      }

      const nextDep = normalizedDep || dep;
      if (seen.has(nextDep)) {
        const repair = {
          action: 'remove-duplicate-dependency',
          taskId: task.id,
          dependency: nextDep,
          confidence: 'high',
          reason: 'duplicate dependencies do not change ordering',
          applied: true,
        };
        repairs.push(repair);
        diagnostics.push({ type: 'schedule-repair', ...repair });
        continue;
      }

      seen.add(nextDep);
      normalized.push(nextDep);
    }
    task.depends = normalized;
  }

  return { tasks: repaired, repairs, diagnostics };
}

function findUniqueDependencyId(dep, ids) {
  const normalized = normalizeTaskId(dep);
  if (ids.has(normalized)) return normalized;

  const matches = [...ids].filter(id => normalizeTaskId(id) === normalized);
  if (matches.length === 1) return matches[0];

  const near = [...ids].filter(id => dependencyDistance(normalized, normalizeTaskId(id)) <= 1);
  return near.length === 1 ? near[0] : null;
}

function normalizeTaskId(id) {
  const raw = String(id || '').trim().toUpperCase().replace(/O/g, '0');
  const match = raw.match(/^T0*(\d+)$/);
  if (!match) return raw;
  return `T${match[1].padStart(2, '0')}`;
}

function dependencyDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else {
      edits++;
      if (edits > 1) return edits;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else {
        i++;
        j++;
      }
    }
  }
  if (i < a.length || j < b.length) edits++;
  return edits;
}

function analyzeTaskGraph(tasks) {
  const issues = [];
  const ids = new Set();
  const duplicates = [];
  for (const task of tasks) {
    if (ids.has(task.id)) duplicates.push(task.id);
    ids.add(task.id);
  }
  if (duplicates.length > 0) {
    issues.push({ type: 'duplicate-task-id', taskIds: duplicates });
  }

  for (const task of tasks) {
    for (const dep of task.depends || []) {
      if (dep === task.id) {
        issues.push({ type: 'self-dependency', taskId: task.id });
      } else if (!ids.has(dep)) {
        issues.push({ type: 'missing-dependency', taskId: task.id, dependency: dep });
      }
    }
  }

  const cycle = findCycle(tasks);
  if (cycle) {
    issues.push({ type: 'cyclic-dependency', cycle });
  }

  return issues;
}

function selectSafeRepair(tasks, issues) {
  const issue = issues.find(i => i.type === 'cyclic-dependency');
  if (!issue) return null;
  return selectCycleRepair(tasks, issue.cycle);
}

function selectCycleRepair(tasks, cycle) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const edges = [];
  for (let i = 0; i < cycle.length - 1; i++) {
    const from = cycle[i];
    const to = cycle[i + 1];
    const task = byId.get(from);
    const depTask = byId.get(to);
    if (!task || !depTask) continue;
    edges.push({
      taskId: from,
      dependency: to,
      score: dependencyStrength(depTask, task),
    });
  }

  if (edges.length === 0) return null;
  edges.sort((a, b) => a.score - b.score);
  if (edges.length > 1 && edges[0].score === edges[1].score) return null;
  if (edges[0].score > 0) return null;

  return {
    action: 'remove-dependency',
    taskId: edges[0].taskId,
    dependency: edges[0].dependency,
    confidence: 'high',
    reason: 'cycle contains a unique weak dependency edge without file relationship',
    applied: false,
  };
}

function dependencyStrength(depTask, task) {
  const conflicts = findResourceConflicts(depTask, task);
  if (conflicts.some(c => c.severity === 'hard')) return 3;
  if (conflicts.some(c => c.type === 'read-write-risk')) return 2;
  if (hasOrderingLanguage(depTask, task)) return 1;
  return 0;
}

function hasOrderingLanguage(depTask, task) {
  const depText = `${depTask.title || ''} ${depTask.body || ''}`.toLowerCase();
  const taskText = `${task.title || ''} ${task.body || ''}`.toLowerCase();
  const early = ['base', 'shared', 'prepare', 'setup', 'schema', 'foundation', 'generate'];
  const late = ['consume', 'use', 'integrate', 'wire', 'final', 'cleanup'];
  return early.some(word => depText.includes(word)) || late.some(word => taskText.includes(word));
}

function applyRepairToTasks(tasks, repair) {
  const repaired = cloneTasks(tasks);
  const task = repaired.find(t => t.id === repair.taskId);
  if (!task) return repaired;

  if (repair.action === 'remove-dependency') {
    task.depends = (task.depends || []).filter(dep => dep !== repair.dependency);
  } else if (repair.action === 'replace-dependency') {
    task.depends = (task.depends || []).map(dep => dep === repair.from ? repair.to : dep);
  }

  return repaired;
}

function validateTaskGraph(tasks) {
  const diagnostics = analyzeTaskGraph(tasks);
  if (diagnostics.length > 0) {
    throw schedulerError('Invalid task dependencies', diagnostics);
  }
}

function findCycle(tasks) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const byId = new Map(tasks.map(t => [t.id, t]));

  function visit(task) {
    if (visited.has(task.id)) return null;
    if (visiting.has(task.id)) {
      const start = stack.indexOf(task.id);
      return stack.slice(start).concat(task.id);
    }
    visiting.add(task.id);
    stack.push(task.id);
    for (const dep of task.depends || []) {
      if (!byId.has(dep)) continue;
      const cycle = visit(byId.get(dep));
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(task.id);
    visited.add(task.id);
    return null;
  }

  for (const task of tasks) {
    const cycle = visit(task);
    if (cycle) return cycle;
  }
  return null;
}

function buildReadyBatches(ready, config, diagnostics) {
  const serial = config.respectParallel ? ready.filter(task => !task.parallel) : [];
  const parallel = config.respectParallel ? ready.filter(task => task.parallel) : [...ready];
  const batches = [];

  for (const task of serial) {
    batches.push([task]);
    diagnostics.push({
      type: 'serial-task',
      taskId: task.id,
      reason: 'parallel flag is not enabled',
    });
  }

  const remaining = [...parallel].sort(compareTaskPriority);
  while (remaining.length > 0) {
    const batch = [];
    let cursor = 0;
    while (cursor < remaining.length && batch.length < config.maxParallelism) {
      const task = remaining[cursor];
      const conflict = firstBatchConflict(task, batch, diagnostics);
      if (!conflict) {
        batch.push(task);
        remaining.splice(cursor, 1);
      } else {
        diagnostics.push({
          type: conflict.type,
          taskId: task.id,
          with: conflict.with,
          resources: conflict.resources,
          reason: conflict.reason,
        });
        cursor++;
      }
    }
    if (batch.length === 0) {
      batch.push(remaining.shift());
    }
    batches.push(batch);
  }

  return batches;
}

function firstBatchConflict(task, batch, diagnostics) {
  for (const selected of batch) {
    const conflicts = findResourceConflicts(selected, task);
    for (const soft of conflicts.filter(c => c.severity === 'soft')) {
      diagnostics.push({
        type: soft.type,
        taskId: task.id,
        with: selected.id,
        resources: soft.files,
        reason: soft.reason,
      });
    }
    const hard = conflicts.find(c => c.severity === 'hard');
    if (hard) {
      return {
        type: hard.type,
        with: selected.id,
        resources: hard.files,
        reason: hard.reason,
      };
    }
  }
  return null;
}

function compareTaskPriority(a, b) {
  const riskDiff = riskWeight(b.risk) - riskWeight(a.risk);
  if (riskDiff !== 0) return riskDiff;

  const estimateDiff = (b.estimate || 1) - (a.estimate || 1);
  if (estimateDiff !== 0) return estimateDiff;

  const degreeDiff = resourceWeight(b) - resourceWeight(a);
  if (degreeDiff !== 0) return degreeDiff;

  return a.id.localeCompare(b.id);
}

function riskWeight(risk) {
  if (risk === 'high') return 3;
  if (risk === 'medium') return 2;
  return 1;
}

function resourceWeight(task) {
  return (task.writeFiles?.length || 0) * 2 + (task.readFiles?.length || 0);
}

function schedulerError(message, diagnostics) {
  const err = new Error(message);
  err.name = 'SchedulerError';
  err.diagnostics = diagnostics;
  return err;
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
