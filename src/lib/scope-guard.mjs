/**
 * scope-guard.mjs — 任务间资源冲突检测
 *
 * 仅暴露 findResourceConflicts:被 tasks.mjs 用于 wave 调度。
 * 早期还有 checkScope/detectConflicts 给 gate.mjs 用,gate.mjs 已下线。
 */

/**
 * 检测两个任务之间的资源冲突。
 * write/write 是硬冲突;write/read 是软冲突,用于诊断和风险提示。
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

function matchGlob(pattern, filepath) {
  if (pattern === filepath) return true;
  const p = pattern.replace(/\\/g, '/');
  const f = filepath.replace(/\\/g, '/');
  if (p === f) return true;
  if (p.length > 500 || f.length > 500) return p === f;

  if (p.includes('**')) return globToRegex(p).test(f);
  if (p.includes('*')) return globToRegex(p).test(f);
  if (p.endsWith('/') && f.startsWith(p)) return true;
  if (!p.includes('/') && f.endsWith('/' + p)) return true;
  if (!p.includes('/') && f === p) return true;
  return false;
}

function globToRegex(pattern) {
  const regex = pattern
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
