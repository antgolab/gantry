/** Controller-owned task convergence. Executors return candidates, never completion. */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseTasks } from './tasks.mjs';
import { readState } from './state.mjs';
import { readConfig } from './config.mjs';
import { resolveArtifactPath } from './artifacts.mjs';
import { createContract, contractsMatch, captureManifest, computeContentDigest, checkTaskScope, detectTaskWeakening, inspectVerificationOutput, receiptIsValid, DEFAULT_RALPH_DEADLINES } from './task-evidence.mjs';
import { MAX_TASK_REPAIRS, createTaskRecord, readTaskRecord, writeTaskRecord, reserveAttempt, recordExternalRetry, acquireWorkspaceLock, releaseWorkspaceLock } from './task-record.mjs';
import { runShellCommand } from './process-runner.mjs';
import { appendHealAttempt } from './self-heal.mjs';
import { classifyFailure, recoveryPlan } from './failure-classification.mjs';

const DEFAULTS = DEFAULT_RALPH_DEADLINES;
const codes = { completed: 0, prepared: 0, failed: 1, blocked: 2, exhausted: 3, 'external-exhausted': 4, cancelled: 130, timeout: 3 };
function result(kind, record = null, reason = null, extra = {}) {
  const failure = reason ? classifyFailure({kind, reason, run:extra.runs?.at(-1),ownerTaskId:record?.taskId}) : null;
  return { kind, exitCode: codes[kind] ?? 2, record, ...(reason ? { reason, failure, recovery:recoveryPlan(failure,{writeFiles:record?.contract?.writeFiles}) } : {}), ...extra };
}
function blocked(message) { const error = new Error(message); error.kind = 'blocked'; throw error; }
function env(root, taskId, opts = {}) {
  const changeId = opts.changeId ?? readState(root).activeChange;
  if (!changeId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(changeId)) blocked('active change missing or invalid');
  const dir = join(root, '.gantry/specs', changeId);
  const path = resolveArtifactPath(dir, 'tasks').path;
  const tasks = parseTasks(path);
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) blocked('duplicate task identities');
  const task = tasks.find(t => t.id === taskId);
  if (taskId && !task) blocked(`unknown task: ${taskId}`);
  const configPath = join(root, '.gantry/planning/config.json');
  if (existsSync(configPath)) { try { const parsed = JSON.parse(readFileSync(configPath, 'utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) blocked('invalid project config'); } catch (error) { blocked(`project config corrupt: ${error.message}`); } }
  const sourceConfig = opts.config === undefined ? readConfig(root) : opts.config;
  const fullConfig = sourceConfig && typeof sourceConfig === 'object' && ['pipeline', 'stages', 'autonomous', 'tool'].some(key => Object.hasOwn(sourceConfig, key));
  const configured = sourceConfig && Object.hasOwn(sourceConfig, 'ralph') ? sourceConfig.ralph
    : opts.config === undefined || fullConfig ? {} : sourceConfig;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) blocked('ralph config must be an object');
  const maxRepairs = configured.maxRepairs ?? MAX_TASK_REPAIRS;
  if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0) blocked('maxRepairs must be a nonnegative safe integer');
  if (configured.checkpointCommands != null && (!Array.isArray(configured.checkpointCommands) || configured.checkpointCommands.some(c => typeof c !== 'string' || !c.trim()))) blocked('checkpointCommands must be an array of commands');
  const deadlines = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, configured[key] ?? value]));
  if (Object.values(deadlines).some(n => !Number.isSafeInteger(n) || n <= 0)) blocked('ralph deadlines must be bounded positive integers');
  // Latest runtime settings are metadata, separate from task acceptance.
  const config = { ...configured, maxRepairs, deadlineSnapshot: deadlines };
  if (task && (typeof task.verify !== 'string' || !task.verify.trim())) blocked('task verify command missing');
  if (opts.timeoutMs != null && (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0)) blocked('timeoutMs must be a bounded positive integer');
  const includePaths = [relative(root, path), '.gantry/planning/config.json', '.gantry/loop/test-commands.yml'];
  return { root, changeId, dir, path, tasks, task, config, deadlines, includePaths, contract: task ? createContract(task, config) : null };
}
function snapshot(e) { return captureManifest(e.root, { includePaths: e.includePaths }); }
function save(e, record, opts) { return writeTaskRecord(e.root, record, { ownerNonce: opts.ownerNonce }); }
function ensureContract(e, record) { if (!contractsMatch(record.contract, e.contract)) blocked('task contract changed; use adjust and approved revision without resetting budget'); }
function receiptValid(e, record, manifest = snapshot(e)) {
  return Boolean(record?.attempt && record.receipt?.attemptId === record.attempt.id && receiptIsValid(record.receipt, e.contract, manifest));
}
export function getTaskReceiptStatus(root, taskId, opts = {}) {
  try {
    const e = env(root, taskId, opts); const record = readTaskRecord(root, e.changeId, taskId);
    if (!record) return { valid: false, kind: 'missing', reason: 'task-record-missing', task: e.task };
    ensureContract(e, record);
    const valid = receiptValid(e, record);
    return { valid, kind: valid ? 'valid' : 'stale', reason: valid ? null : 'receipt-missing-or-stale', record, task: e.task };
  } catch (error) { return { valid: false, kind: 'blocked', reason: error.message }; }
}
export const inspectTaskReceipt = getTaskReceiptStatus;
export function inspectTasks(root, opts = {}) {
  const e = env(root, null, opts);
  const statuses = new Map(e.tasks.filter(t => t.status === 'done').map(t => [t.id, getTaskReceiptStatus(root, t.id, opts)]));
  const readyTask = e.tasks.find(t => t.status !== 'done' && t.depends.every(id => statuses.get(id)?.valid)) ?? null;
  return { tasks: e.tasks, readyTask, allDone: e.tasks.length > 0 && e.tasks.every(t => t.status === 'done'), invalidReceipts: [...statuses].filter(([, s]) => !s.valid).map(([taskId, s]) => ({ taskId, reason: s.reason })) };
}
export function selectReadyTask(root, opts = {}) { return inspectTasks(root, opts).readyTask; }
async function locked(root, opts, operation) {
  let lock;
  try {
    lock = acquireWorkspaceLock(root, { ownerNonce: opts.ownerNonce });
    const e = env(root, null, opts);
    return await operation({ ...opts, ownerNonce: lock.ownerNonce, runStartedAt: opts.runStartedAt ?? Date.now() });
  }
  catch (error) { if (opts.throwErrors) throw error; return result('blocked', null, error.message); }
  finally { if (lock) releaseWorkspaceLock(root, lock); }
}
function runDeadline(e, opts) { return Math.min(opts.deadlineAt ?? Infinity, (opts.runStartedAt ?? Date.now()) + e.deadlines.runTimeoutMs); }
function commandTimeout(e, opts) { return Math.min(opts.timeoutMs ?? e.deadlines.verifyTimeoutMs, Math.max(1, runDeadline(e, opts) - Date.now())); }
async function commands(e, list, opts, kind = 'command') {
  const runs = [];
  for (const command of list) {
    if (opts.signal?.aborted) return { ok: false, kind: 'cancelled', reason: 'cancelled', runs };
    if (Date.now() >= runDeadline(e, opts)) return { ok: false, kind: 'timeout', reason: 'run-deadline', runs };
    const cacheKey = opts.cacheDigest ? `${opts.cacheDigest}:${command}` : null;
    if (cacheKey && opts.commandCache?.has(cacheKey)) {
      const cached = opts.commandCache.get(cacheKey);
      const inspection = inspectVerificationOutput(`${cached.stdout}\n${cached.stderr}`, { kind });
      runs.push({ ...cached, inspection });
      if (!inspection.ok) return { ok: false, kind: 'failed', reason: inspection.reason, runs };
      continue;
    }
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    const run = await runShellCommand(command, { env: childEnv, cwd: e.root, signal: opts.signal, timeoutMs: commandTimeout(e, opts), killGraceMs: e.deadlines.killGraceMs, onOutput: opts.onOutput });
    const inspection = inspectVerificationOutput(`${run.stdout}\n${run.stderr}`, { kind });
    runs.push({ command, ...run, inspection });
    if (run.cleanupComplete === false) return { ok: false, kind: 'blocked', reason: 'process-cleanup-unconfirmed', runs };
    if (run.cancelled || run.timedOut) return { ok: false, kind: run.cancelled ? 'cancelled' : 'timeout', reason: run.cancelled ? 'cancelled' : 'command-timeout', runs };
    if (run.spawnError) return { ok: false, kind: 'blocked', reason: 'command-spawn-error', runs };
    if ([126, 127].includes(run.exitCode)) return { ok: false, kind: 'blocked', reason: 'command-unavailable', runs };
    if (run.exitCode === 0 && inspection.ok && cacheKey) opts.commandCache?.set(cacheKey, runs.at(-1));
    if (run.exitCode !== 0 || !inspection.ok) return { ok: false, kind: 'failed', reason: inspection.reason ?? 'command-failed', runs };
  }
  return { ok: true, runs };
}
async function preflight(e, opts) {
  const check = await commands(e, e.contract.preflight, opts);
  return check.ok ? null : result(check.kind === 'failed' ? 'blocked' : check.kind, null, `preflight: ${check.reason}`, { runs: check.runs });
}
async function prepare(e, opts) {
  let record = readTaskRecord(e.root, e.changeId, e.task.id);
  if (record) {
    if (!opts.repairGates) ensureContract(e, record);
    if (contractsMatch(record.contract, e.contract)) record = { ...record, contract: e.contract };
  }
  if (e.task.status === 'done' && !opts.repairGates) return result('blocked', record, 'task-already-done');
  if (!e.contract.verify.trim()) return result('blocked', record, 'task requires verify');
  if (!e.task.depends.every(id => getTaskReceiptStatus(e.root, id, opts).valid && e.tasks.find(t => t.id === id)?.status === 'done')) return result('blocked', record, 'dependency-receipt-invalid');
  if (record?.attempt?.lifecycle === 'reserved' || record?.attempt?.lifecycle === 'running') return result('blocked', record, 'attempt-already-reserved');
  const baseline = snapshot(e);
  const failure = await preflight(e, opts);
  if (failure && (!opts.repairGates || !canRepairGate(failure))) return failure;
  if (!opts.repairGates && computeContentDigest(baseline) !== computeContentDigest(snapshot(e))) return result('blocked', record, 'preflight-mutated-content');
  if (!record) record = createTaskRecord(e.root, e.changeId, e.task, e.contract, baseline, opts);
  if (record.attempt && record.repairsUsed >= e.config.maxRepairs) return result('exhausted', record, 'task-repair-budget-exhausted', { lastFailure: record.failure });
  record = reserveAttempt(e.root, record, { repair: Boolean(record.attempt), ownerNonce: opts.ownerNonce, limit: e.config.maxRepairs });
  if (failure) record = save(e, { ...record, failure: { kind: failure.kind, reason: failure.reason, runs: failure.runs, at: new Date().toISOString() } }, opts);
  return result('prepared', record, null, { task: e.task, attempt: record.attempt });
}
export async function prepareTask(root, taskId, opts = {}) { return locked(root, opts, owned => prepare(env(root, taskId, owned), owned)); }
function atomicText(path, text) { const temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, text); renameSync(temporary, path); }
function finish(e, record, opts) {
  // Receipt is already durable. These two writes can be replayed independently.
  opts.onCheckpoint?.('receipt', record);
  const execution = join(e.dir, 'EXECUTION.md');
  const marker = `<!-- ralph-task:${e.task.id}:begin -->`; const end = `<!-- ralph-task:${e.task.id}:end -->`;
  const block = `${marker}\n### ${e.task.id} · verified\n\n- receipt: ${record.receipt.contentDigest}\n- attempt: ${record.attempt.id}; repairs: ${record.repairsUsed}/${e.config.maxRepairs}\n- verify: ${record.receipt.runs.map(r => `\`${r.command}\` (exit ${r.exitCode}, tests ${r.inspection.counts?.tests ?? 'unknown'})`).join('; ')}\n- additional files (advisory): ${record.receipt.outOfScope?.join(', ') || 'none'}\n- problem: ${record.failure?.reason ?? 'none'}\n- cause: ${record.failure ? 'see persisted command diagnostics' : 'none'}\n- next: ${record.failure ? 'review persisted diagnostics' : 'none'}\n${end}`;
  let text = existsSync(execution) ? readFileSync(execution, 'utf8') : '# EXECUTION\n';
  const start = text.indexOf(marker); const stop = text.indexOf(end, start);
  text = start >= 0 && stop >= 0 ? text.slice(0, start) + block + text.slice(stop + end.length) : `${text.trimEnd()}\n\n${block}\n`;
  atomicText(execution, text); opts.onCheckpoint?.('execution', record);
  const source = readFileSync(e.path, 'utf8');
  const updated = source.replace(/<task\s+([^>]+)>/g, (tag, attrs) => {
    if (!new RegExp(`\\bid="${e.task.id}"`).test(attrs)) return tag;
    return /\bstatus="[^"]*"/.test(tag) ? tag.replace(/\bstatus="[^"]*"/, 'status="done"') : tag.replace('>', ' status="done">');
  });
  if (updated === source && !parseTasks(e.path).some(t => t.id === e.task.id && t.status === 'done')) blocked('cannot atomically update task XML');
  atomicText(e.path, updated); opts.onCheckpoint?.('tasks', record);
  return result('completed', record, null, { receipt: record.receipt, scope: { changedFiles: record.receipt.changedFiles ?? [], outOfScope: record.receipt.outOfScope ?? [] } });
}
function live(pid) { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
async function verify(e, opts) {
  let record = readTaskRecord(e.root, e.changeId, e.task.id);
  if (!record?.attempt) return result('blocked', record, 'missing task-entry baseline/reservation; explicit migration review required');
  ensureContract(e, record);
  record = { ...record, contract: e.contract };
  if (record.attempt.lifecycle === 'running' && (live(record.attempt.executorPid) || live(record.attempt.processGroupId))) return result('blocked', record, 'executor-still-running');
  if (record.attempt.result?.cleanupComplete === false) return result('blocked', record, 'process-cleanup-unconfirmed');
  const before = snapshot(e);
  opts = { ...opts, cacheDigest: computeContentDigest(before) };
  if (!opts.forceRecheck && receiptValid(e, record, before)) return finish(e, record, opts);
  const scope = checkTaskScope(record.baseline, before, opts.checkpointWriteFiles ?? e.contract.writeFiles);
  // write_files is planning guidance. Report additional files without blocking
  // real verification or conflating concurrent edits with task failure.
  const weakening = detectTaskWeakening(record.baseline, before);
  if (weakening.hit) {
    const details = weakening.reasons.map(item => `${item.path}: ${item.kind}${item.source ? ` (${item.source})` : ''}`).join('; ');
    return result('blocked', record, `acceptance-weakened; ${details}`, { weakening });
  }
  const failure = await preflight(e, opts); if (failure) return { ...failure, record };
  const verification = await commands(e, [e.contract.verify], opts, 'test');
  const checks = verification.ok ? await commands(e, e.contract.checks, opts) : { ok: true, runs: [] };
  const runs = [...verification.runs, ...checks.runs];
  const after = snapshot(e); ensureContract(env(e.root, e.task.id, opts), record);
  const changedDuring = computeContentDigest(before) !== computeContentDigest(after);
  // Operator edits during verification need fresh evidence, not human repair.
  // The existing run deadline bounds repeated edits and keeps the same budget.
  if (changedDuring && checkTaskScope(before, after, []).ok) return verify(env(e.root, e.task.id, opts), opts);
  const failed = !verification.ok ? verification : !checks.ok ? checks : changedDuring ? { kind: 'blocked', reason: 'verification-mutated-content' } : null;
  const candidateDigest = computeContentDigest(after);
  const signature = failed ? createHash('sha256').update(JSON.stringify({ kind: failed.kind, reason: failed.reason, commands: runs.map(run => ({ command: run.command, exitCode: run.exitCode, stdout: run.stdout.replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, '<duration>'), stderr: run.stderr })) })).digest('hex') : null;
  const repeated = failed && record.failure?.signature === signature && record.candidate?.contentDigest === candidateDigest;
  record = save(e, { ...record, receipt: failed ? null : record.receipt, candidate: { contentDigest: candidateDigest, capturedAt: new Date().toISOString() }, attempt: { ...record.attempt, lifecycle: 'returned' }, failure: failed ? { kind: failed.kind, reason: failed.reason, classification: classifyFailure({kind:failed.kind,reason:failed.reason,run:runs.at(-1),priorOutcome:record.receipt ? {passed:true,contentDigest:record.receipt.contentDigest} : null,contentDigest:candidateDigest,ownerTaskId:e.task.id}), signature, runs, at: new Date().toISOString() } : record.failure }, opts);
  if (failed) {
    if (record.failure?.classification?.category === 'flaky-test') return result('blocked', record, 'flaky-test; review unchanged-source verification', {runs, failure:record.failure.classification,recovery:recoveryPlan(record.failure.classification)});
    if (!repeated) {
      const execution = join(e.dir, 'EXECUTION.md');
      if (!existsSync(execution)) atomicText(execution, '# EXECUTION\n');
      const last = runs.at(-1);
      appendHealAttempt(execution, { taskId: e.task.id, reason: `${failed.kind}: ${failed.reason}`, command: last?.command, stderr: last ? `${last.stderr}\n${last.stdout}` : '' });
    }
    return result(failed.kind, record, failed.reason, { runs });
  }
  const receipt = { schemaVersion: 1, pass: true, contractDigest: record.contract.digest, contentDigest: computeContentDigest(after), verifiedAt: new Date().toISOString(), attemptId: record.attempt.id, runs, changedFiles: scope.changedFiles, outOfScope: scope.outOfScope };
  record = save(e, { ...record, receipt }, opts);
  return finish(e, record, opts);
}
export async function verifyAndComplete(root, taskId, opts = {}) { return locked(root, opts, owned => verify(env(root, taskId, owned), owned)); }
function pause(ms, signal) { return new Promise(resolve => { const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true }); if (signal?.aborted) finish(); }); }
export function canRepairGate(outcome) {
  if (!outcome || ['completed', 'cancelled', 'timeout', 'exhausted', 'external-exhausted'].includes(outcome.kind)) return false;
  if (outcome.runs?.some(run => run.cleanupComplete === false || run.cancelled || run.timedOut)) return false;
  return outcome.kind === 'failed' || /^(acceptance-weakened;|flaky-test;|preflight: |command-unavailable$|command-spawn-error$|verification-mutated-content$|task contract changed;)/.test(outcome.reason ?? '');
}
async function verifyForRepair(e, opts) {
  let checked;
  try { checked = await verify(e, opts); }
  catch (error) {
    if (!error.message.startsWith('task contract changed;')) throw error;
    checked = result('blocked', readTaskRecord(e.root, e.changeId, e.task.id), error.message);
  }
  if (!canRepairGate(checked) || !checked.record) return checked;
  const record = save(e, { ...checked.record, receipt: null, failure: {
    ...checked.record.failure, kind: checked.kind, reason: checked.reason,
    runs: checked.runs ?? checked.record.failure?.runs ?? [], at: new Date().toISOString(),
  } }, opts);
  return { ...checked, kind: 'failed', record };
}
export async function convergeTask(root, taskId, opts = {}) {
  return locked(root, opts, async owned => {
    let e = env(root, taskId, owned);
    let deadlineAt = runDeadline(e, owned);
    let record = readTaskRecord(root, e.changeId, taskId);
    // Recovery validates the current candidate before dispatch. External retries
    // remain on their original business reservation across process restarts.
    if (owned.gateFeedback && record?.attempt) {
      // A combination gate can fail while every focused receipt is still valid.
      // Reserve a real repair instead of repeatedly accepting the old receipt.
      record = save(e, { ...record, receipt: null, failure: {
        kind: 'failed', reason: owned.gateFeedback.reason ?? 'checkpoint-failed',
        runs: owned.gateFeedback.runs ?? [], at: new Date().toISOString(),
      }, attempt: { ...record.attempt, lifecycle: 'returned' } }, owned);
    } else if (record?.attempt) {
      const unusedReservation = record.attempt.lifecycle === 'reserved' && !record.candidate && !record.attempt.result;
      const priorOutput = record.attempt.result;
      const pendingExternal = record.attempt.externalRetryPending === true;
      const recovered = await verifyForRepair(e, owned);
      if (recovered.kind !== 'failed') return recovered;
      record = recovered.record;
      const resumeExternal = Boolean(priorOutput?.externalFailure && priorOutput.retryable);
      if (resumeExternal) {
        if (!pendingExternal) {
          if (record.attempt.externalRetriesUsed >= 3) return result('external-exhausted', record, 'external-retry-budget-exhausted');
          record = recordExternalRetry(root, record, { ownerNonce: owned.ownerNonce });
        }
        record = save(e, { ...record, attempt: { ...record.attempt, lifecycle: 'reserved', externalRetryPending: true } }, owned);
      } else if (unusedReservation) record = save(e, { ...record, attempt: { ...record.attempt, lifecycle: 'reserved' } }, owned);

    }
    if (typeof owned.execute !== 'function') return result('blocked', record, 'executor missing');
    for (;;) {
      e = env(root, taskId, owned);
      deadlineAt = runDeadline(e, owned);
      if (owned.signal?.aborted) return result('cancelled', record, 'cancelled');
      if (Date.now() >= deadlineAt) return result('timeout', record, 'run-deadline');
      let prepared;
      // An unused host reservation is consumed by this call, without a second reservation.
      if (record?.attempt?.lifecycle === 'reserved') prepared = result('prepared', record);
      else prepared = await prepare(env(root, taskId, owned), { ...owned, repairGates: true });
      if (prepared.kind !== 'prepared') return prepared;
      record = prepared.record;
      for (;;) {
        if (record.attempt.externalRetryPending) {
          await pause(1000 * 2 ** (record.attempt.externalRetriesUsed - 1), owned.signal);
          if (owned.signal?.aborted) return result('cancelled', record, 'cancelled');
          if (Date.now() >= deadlineAt) return result('timeout', record, 'run-deadline');
        }
        // Re-read before each execution/repair, including same-reservation retries.
        e = env(root, taskId, owned);
        // A changed acceptance contract is repaired against the saved contract;
        // verification still refuses it until the original acceptance is restored.
        deadlineAt = runDeadline(e, owned);
        if (Date.now() >= deadlineAt) return result('timeout', record, 'run-deadline');
        const controller = new AbortController();
        const abort = () => controller.abort(owned.signal?.reason);
        owned.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('executor deadline')), Math.min(e.deadlines.executorTimeoutMs, deadlineAt - Date.now()));
        record = save(e, { ...record, attempt: { ...record.attempt, lifecycle: 'running', externalRetryPending: false } }, owned);
        let output;
        try {
          output = await owned.execute({ root, task: e.task, record, attempt: record.attempt, contract: record.contract, signal: controller.signal, ownerNonce: owned.ownerNonce, onSpawn: ({ pid, processGroupId }) => { record = save(e, { ...record, attempt: { ...record.attempt, executorPid: pid, processGroupId } }, owned); } });
        } catch (error) { output = { exitCode: 1, error: error.message, unknownFailure: true }; }
        finally { clearTimeout(timer); owned.signal?.removeEventListener('abort', abort); }
        output ??= { exitCode: 1, unknownFailure: true };
        record = save(e, { ...record, attempt: { ...record.attempt, lifecycle: 'returned', result: output }, candidate: { contentDigest: computeContentDigest(snapshot(e)), capturedAt: new Date().toISOString() } }, owned);
        if (output.cleanupComplete === false) return result('blocked', record, 'process-cleanup-unconfirmed');
        if (output.cancelled || owned.signal?.aborted) return result('cancelled', record, 'cancelled');
        if (output.timedOut || controller.signal.aborted) return result('timeout', record, 'executor-deadline');
        const verified = await verifyForRepair(env(root, taskId, owned), owned);
        if (verified.kind !== 'failed') return verified;
        record = verified.record;
        if (output.externalFailure && output.retryable) {
          if (record.attempt.externalRetriesUsed >= 3) return result('external-exhausted', record, 'external-retry-budget-exhausted');
          record = recordExternalRetry(root, record, { ownerNonce: owned.ownerNonce });
          record = save(e, { ...record, attempt: { ...record.attempt, externalRetryPending: true } }, owned);
          continue;
        }
        if (output.unknownFailure || output.spawnError || output.externalFailure || output.exitCode !== 0) {
          record = save(e, { ...record, failure: { ...record.failure, executor: output } }, owned);
        }
        break;
      }
    }
  });
}
/** Revalidate completed evidence; an injected executor can repair the owning task. */
export async function revalidateCompletedTasks(root, opts = {}) {
  return locked(root, opts, async owned => {
    const e = env(root, null, owned); const results = [];
    const completed = e.tasks.filter(t => t.status === 'done');
    const allowed = [...new Set(e.tasks.flatMap(t => t.writeFiles))];
    const commandCache = new Map();
    for (const task of completed) {
      if (getTaskReceiptStatus(root, task.id, owned).valid) continue;
      let checked = await (owned.execute ? verifyForRepair : verify)(env(root, task.id, owned), { ...owned, checkpointWriteFiles: allowed, commandCache });
      if (owned.execute && canRepairGate(checked)) checked = await convergeTask(root, task.id, owned);
      results.push({ taskId: task.id, ...checked });
      if (checked.kind !== 'completed') return { ...checked, results };
    }
    return result('completed', null, null, { results });
  });
}
export async function checkpointTasks(root, opts = {}) {
  return locked(root, opts, async owned => {
    const e = env(root, null, owned); const results = [];
    owned = { ...owned, commandCache: new Map() };
    if (!e.tasks.length || e.tasks.some(t => t.status !== 'done')) return result('blocked', null, 'unfinished-tasks', { results });
    for (const task of e.tasks) {
      const checked = await verify(env(root, task.id, owned), { ...owned, checkpointWriteFiles: [...new Set(e.tasks.flatMap(t => t.writeFiles))] }); results.push({ taskId: task.id, ...checked });
      if (checked.kind !== 'completed') return { ...checked, results };
    }
    const latest = env(root, null, owned);
    const combinations = await commands(latest, latest.config.checkpointCommands ?? [], { ...owned, cacheDigest: computeContentDigest(snapshot(latest)) });
    if (!combinations.ok) return result(combinations.kind, null, combinations.reason, { results, commands: combinations.runs });
    // A combination command must not mutate accepted content.
    for (const task of e.tasks) if (!getTaskReceiptStatus(root, task.id, owned).valid) return result('blocked', null, 'checkpoint-mutated-content', { results, commands: combinations.runs });
    return result('completed', null, null, { results, commands: combinations.runs });
  });
}
