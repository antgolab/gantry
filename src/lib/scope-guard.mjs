/**
 * scope-guard.mjs — 文件边界声明 + diff 比对 + 冲突检测
 */

/**
 * 检查实际修改文件是否在任务声明的 write_files 范围内
 * @param {object} task - 任务对象 { writeFiles: string[] }
 * @param {string[]} actualFiles - 实际修改的文件列表 (git diff --name-only)
 * @returns {{ passed: boolean, violations: string[] }}
 */
export function checkScope(task, actualFiles) {
  if (!task.writeFiles || task.writeFiles.length === 0) {
    return { passed: true, violations: [] };
  }
  if (!actualFiles || actualFiles.length === 0) {
    return { passed: true, violations: [] };
  }

  const violations = [];
  for (const file of actualFiles) {
    const allowed = task.writeFiles.some(pattern => matchGlob(pattern, file));
    if (!allowed) {
      violations.push(file);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

/**
 * 检测 wave 内任务的 write_files 交集冲突
 * @param {object[]} tasks - 任务数组 [{ id, writeFiles }]
 * @returns {{ conflicts: Array<{taskA: string, taskB: string, files: string[]}>, forced: string[] }}
 */
export function detectConflicts(tasks) {
  const conflicts = [];
  const forcedSet = new Set();

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const overlap = findOverlap(tasks[i].writeFiles || [], tasks[j].writeFiles || []);
      if (overlap.length > 0) {
        conflicts.push({
          taskA: tasks[i].id,
          taskB: tasks[j].id,
          files: overlap,
        });
        forcedSet.add(tasks[j].id);
      }
    }
  }

  return {
    conflicts,
    forced: [...forcedSet],
  };
}

/**
 * 检测两个任务之间的资源冲突。
 * write/write 是硬冲突；write/read 是软冲突，用于诊断和风险提示。
 * @param {object} taskA
 * @param {object} taskB
 * @returns {Array<{type: string, severity: 'hard'|'soft', files: string[], reason: string}>}
 */
export function findResourceConflicts(taskA, taskB) {
  const conflicts = [];
  const writeWrite = findOverlap(taskA.writeFiles || [], taskB.writeFiles || []);
  if (writeWrite.length > 0) {
    conflicts.push({
      type: 'write-write-conflict',
      severity: 'hard',
      files: writeWrite,
      reason: 'tasks write overlapping files',
    });
  }

  const aWritesBReads = findOverlap(taskA.writeFiles || [], taskB.readFiles || []);
  const bWritesAReads = findOverlap(taskB.writeFiles || [], taskA.readFiles || []);
  const readWrite = [...new Set([...aWritesBReads, ...bWritesAReads])];
  if (readWrite.length > 0) {
    conflicts.push({
      type: 'read-write-risk',
      severity: 'soft',
      files: readWrite,
      reason: 'one task reads files another task writes',
    });
  }

  return conflicts;
}

// --- 内部辅助 ---

/**
 * 简单 glob 匹配 (支持 * 和 **)
 * @param {string} pattern - glob pattern
 * @param {string} filepath - 实际文件路径
 * @returns {boolean}
 */
function matchGlob(pattern, filepath) {
  // Exact match
  if (pattern === filepath) return true;

  // Normalize separators
  const p = pattern.replace(/\\/g, '/');
  const f = filepath.replace(/\\/g, '/');

  if (p === f) return true;

  // Guard against ReDoS: reject overly long inputs
  if (p.length > 500 || f.length > 500) return p === f;

  // ** matches any path segments
  if (p.includes('**')) {
    const regex = globToRegex(p);
    return regex.test(f);
  }

  // Single * matches within one segment
  if (p.includes('*')) {
    const regex = globToRegex(p);
    return regex.test(f);
  }

  // Directory prefix: "src/lib/" matches "src/lib/foo.mjs"
  if (p.endsWith('/') && f.startsWith(p)) return true;

  // Basename match: "foo.mjs" matches "src/foo.mjs"
  if (!p.includes('/') && f.endsWith('/' + p)) return true;
  if (!p.includes('/') && f === p) return true;

  return false;
}

function globToRegex(pattern) {
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§DOUBLESTAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLESTAR§/g, '.*');

  return new RegExp(`^${regex}$`);
}

function findOverlap(filesA, filesB) {
  const overlap = [];
  for (const a of filesA) {
    for (const b of filesB) {
      if (a === b) {
        overlap.push(a);
      } else if (matchGlob(a, b) || matchGlob(b, a)) {
        overlap.push(a.includes('*') ? b : a);
      }
    }
  }
  return [...new Set(overlap)];
}
