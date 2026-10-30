/**
 * Task execution metadata. TASKS.md remains the sole source of task completion.
 * Mutations are serialized with the workspace lock and atomically replace one
 * versioned snapshot. Corrupt history is never interpreted as a fresh budget.
 */
import {
  mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync,
  fsyncSync, renameSync, unlinkSync, rmdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export const TASK_RECORD_VERSION = 1;
export const MAX_TASK_REPAIRS = 3;
export const MAX_EXTERNAL_RETRIES = 3;
const ownedLocks = new Map();
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message, code = 'task-record-blocked') {
  const error = new Error(`[task-record] ${message}`);
  error.code = code;
  error.kind = 'blocked';
  throw error;
}
function identity(value) {
  if (typeof value !== 'string' || !ID.test(value) || value === '.' || value === '..') {
    fail('invalid identity');
  }
}

export function taskRecordPath(root, changeId, taskId) {
  identity(changeId);
  identity(taskId);
  return join(root, '.gantry', 'specs', changeId, 'execution', `${taskId}.json`);
}

export function validateTaskRecord(record, changeId = record?.changeId, taskId = record?.taskId) {
  identity(changeId);
  identity(taskId);
  if (!record || record.schemaVersion !== TASK_RECORD_VERSION || record.changeId !== changeId || record.taskId !== taskId) {
    fail('record identity or schema version mismatch');
  }
  if (!Number.isInteger(record.revision) || record.revision < 0 ||
      !Number.isInteger(record.repairsUsed) || record.repairsUsed < 0 || record.repairsUsed > MAX_TASK_REPAIRS) {
    fail('invalid record revision or repair budget');
  }
  if ('status' in record || 'done' in record) fail('record must not duplicate task completion');
  if (!record.contract || typeof record.contract !== 'object' || !record.baseline || typeof record.baseline !== 'object') {
    fail('record contract or baseline missing');
  }
  if (record.attempt != null) {
    const a = record.attempt;
    if (typeof a.id !== 'string' || !['reserved', 'running', 'returned', 'interrupted'].includes(a.lifecycle) ||
        !Number.isInteger(a.repairOrdinal) || a.repairOrdinal !== record.repairsUsed ||
        !Number.isInteger(a.externalRetriesUsed) || a.externalRetriesUsed < 0 || a.externalRetriesUsed > MAX_EXTERNAL_RETRIES ||
        typeof a.reservedAt !== 'string') {
      fail('invalid record attempt');
    }
  } else if (record.repairsUsed !== 0) {
    fail('record budget has no attempt');
  }
  if (record.executorReports != null && (!Array.isArray(record.executorReports) || record.executorReports.length > 4 ||
      record.executorReports.some(report => report?.source !== 'executor' || typeof report.attemptId !== 'string' ||
        typeof report.at !== 'string' || typeof report.text !== 'string' || report.text.length > 4096 || typeof report.truncated !== 'boolean'))) {
    fail('invalid bounded executor reports');
  }
  return record;
}

export function readTaskRecord(root, changeId, taskId) {
  const path = taskRecordPath(root, changeId, taskId);
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`record unreadable: ${error.message}`);
  }
  let record;
  try { record = JSON.parse(text); }
  catch { fail(`record corrupt: ${changeId}/${taskId}`); }
  return validateTaskRecord(record, changeId, taskId);
}

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    // POSIX directory fsync is best effort; file data was fsynced above.
    let directory;
    try { directory = openSync(dirname(path), 'r'); fsyncSync(directory); }
    catch { /* Some filesystems/platforms do not support directory fsync. */ }
    finally { if (directory !== undefined) closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function withWriter(root, options, operation) {
  const key = lockPath(root);
  const nonce = options?.ownerNonce || process.env.GANTRY_RALPH_OWNER_NONCE || ownedLocks.get(key)?.ownerNonce;
  const lock = acquireWorkspaceLock(root, nonce ? { ownerNonce: nonce } : {});
  try { return operation(); } finally { releaseWorkspaceLock(root, lock); }
}

export function createTaskRecord(root, changeId, task, contract, baseline, options = {}) {
  const taskId = typeof task === 'string' ? task : task?.id;
  const path = taskRecordPath(root, changeId, taskId);
  return withWriter(root, options, () => {
    if (existsSync(path)) fail('record already exists; read existing history instead of resetting it');
    const record = {
      schemaVersion: TASK_RECORD_VERSION, changeId, taskId, revision: 0,
      contract: structuredClone(contract), baseline: structuredClone(baseline),
      repairsUsed: 0, attempt: null, candidate: null, receipt: null, failure: null,
    };
    validateTaskRecord(record);
    atomicWrite(path, record);
    return record;
  });
}

export function writeTaskRecord(root, record, options = {}) {
  validateTaskRecord(record);
  return withWriter(root, options, () => {
    const current = readTaskRecord(root, record.changeId, record.taskId);
    if (!current) fail('record missing; create explicitly instead of recreating history');
    const expected = options.expectedRevision ?? record.revision;
    if (current.revision !== expected || record.revision !== expected) fail('stale record revision');
    if (record.repairsUsed < current.repairsUsed) fail('repair budget cannot decrease');
    if (record.attempt?.id === current.attempt?.id &&
        (record.attempt?.externalRetriesUsed ?? 0) < (current.attempt?.externalRetriesUsed ?? 0)) {
      fail('external retry budget cannot decrease');
    }
    const updated = structuredClone({ ...record, revision: current.revision + 1 });
    atomicWrite(taskRecordPath(root, record.changeId, record.taskId), updated);
    return updated;
  });
}

export function reserveAttempt(root, record, { repair = false, ownerNonce = null } = {}) {
  validateTaskRecord(record);
  if (record.attempt?.lifecycle === 'running') fail('record attempt still running; reconcile before reserving');
  if (!repair && record.attempt) fail('initial attempt already reserved');
  if (repair && !record.attempt) fail('initial attempt required before repair');
  if (repair && record.repairsUsed >= MAX_TASK_REPAIRS) fail('task repair budget exhausted', 'task-repairs-exhausted');
  const repairsUsed = record.repairsUsed + (repair ? 1 : 0);
  const next = {
    ...record, repairsUsed, candidate: null, receipt: null,
    executorReports: retainExecutorReports(record),
    attempt: {
      id: randomUUID(), repairOrdinal: repairsUsed, lifecycle: 'reserved',
      reservedAt: new Date().toISOString(), executorPid: null, processGroupId: null,
      ownerNonce, externalRetriesUsed: 0, result: null,
    },
  };
  return writeTaskRecord(root, next, { ownerNonce });
}

function retainExecutorReports(record) {
  const reports = record.executorReports ?? [];
  const output = record.attempt?.result;
  const stdout = typeof output?.stdout === 'string' ? output.stdout : '';
  const stderr = typeof output?.stderr === 'string' ? output.stderr : '';
  if ((!stdout && !stderr) || reports.some(report => report.attemptId === record.attempt.id)) return reports;
  // Preserve claims verbatim as bounded excerpts, never promote them to verify
  // facts. Four business attempts bound the history independently of output size.
  return [...reports, {
    source: 'executor', attemptId: record.attempt.id, at: new Date().toISOString(),
    text: `stdout:\n${stdout.slice(0, 2000)}\nstderr:\n${stderr.slice(0, 2000)}`,
    truncated: stdout.length > 2000 || stderr.length > 2000,
  }].slice(-4);
}

export function recordExternalRetry(root, record, { limit = MAX_EXTERNAL_RETRIES, ownerNonce = null } = {}) {
  validateTaskRecord(record);
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_EXTERNAL_RETRIES) fail('invalid external retry limit');
  if (!record.attempt) fail('attempt required for external retry');
  if (record.attempt.externalRetriesUsed >= limit) fail('external retry budget exhausted', 'task-external-exhausted');
  return writeTaskRecord(root, {
    ...record,
    attempt: { ...record.attempt, externalRetriesUsed: record.attempt.externalRetriesUsed + 1 },
  }, { ownerNonce });
}

function lockPath(root) { return join(root, '.gantry', 'planning', 'ralph.lock'); }
function readOwner(path) {
  try {
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    if (owner.schemaVersion !== 1 || !Number.isInteger(owner.pid) || owner.pid <= 0 ||
        typeof owner.hostname !== 'string' || typeof owner.ownerNonce !== 'string' || !owner.ownerNonce) return null;
    return owner;
  } catch { return null; }
}

export function acquireWorkspaceLock(root, { ownerNonce } = {}) {
  const path = lockPath(root);
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readOwner(path);
    if (ownerNonce && owner?.ownerNonce === ownerNonce && owner.hostname === hostname()) {
      return { ...owner, borrowed: true };
    }
    fail('workspace locked; verify previous owner and its controlled processes before recovery', 'task-workspace-locked');
  }
  const owner = { schemaVersion: 1, pid: process.pid, hostname: hostname(), ownerNonce: randomUUID(), acquiredAt: new Date().toISOString() };
  try { atomicWrite(join(path, 'owner.json'), owner); }
  catch (error) {
    // A failed owner write remains a conservative lock, not an unlocked writer.
    fail(`workspace owner write failed: ${error.message}`);
  }
  const lock = { ...owner, borrowed: false };
  ownedLocks.set(path, lock);
  return lock;
}

export function releaseWorkspaceLock(root, lock) {
  const path = lockPath(root);
  const owner = readOwner(path);
  if (!owner || !lock?.ownerNonce || owner.ownerNonce !== lock.ownerNonce) fail('workspace lock owner mismatch');
  if (lock.borrowed) return;
  if (owner.pid !== process.pid || owner.hostname !== hostname()) fail('workspace lock owner process mismatch');
  unlinkSync(join(path, 'owner.json'));
  rmdirSync(path);
  ownedLocks.delete(path);
}
