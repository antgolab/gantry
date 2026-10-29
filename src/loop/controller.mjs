/** Bounded stage supervisor. Model output is a candidate, never completion proof. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState, readFence, isStageApproved } from '../lib/state.mjs';
import { readConfig } from '../lib/config.mjs';
import { writeContextPack } from '../lib/context-pack.mjs';
import { PHASE_FILES } from '../lib/phases.mjs';
import { computeNextStep, WHITELIST } from '../lib/loop.mjs';
import { runProcess } from '../lib/process-runner.mjs';
import { acquireWorkspaceLock, releaseWorkspaceLock } from '../lib/task-record.mjs';
import { parseTasks, allTasksDone } from '../lib/tasks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');
function positive(value, fallback, name, fromEnv = false) {
  const n = value === undefined ? fallback : fromEnv ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} 需有界正整数`);
  return n;
}
export function readLoopOptions(root, env = process.env) {
  // readConfig is tolerant for ordinary commands; a supervisor must not silently
  // replace malformed deadline configuration with fresh defaults.
  const local = join(root, '.gantry/planning/config.json');
  if (existsSync(local)) JSON.parse(readFileSync(local, 'utf8'));
  const config = readConfig(root);
  const ralph = config.ralph === undefined ? {} : config.ralph;
  if (!ralph || typeof ralph !== 'object' || Array.isArray(ralph)) throw new Error('ralph 配置需对象');
  if (ralph.maxRepairs != null && ralph.maxRepairs !== 3) throw new Error('修复上限固定为3');
  return {
    config,
    executorTimeoutMs: positive(ralph.executorTimeoutMs, 900000, 'executorTimeoutMs'),
    verifyTimeoutMs: positive(ralph.verifyTimeoutMs, 600000, 'verifyTimeoutMs'),
    runTimeoutMs: positive(ralph.runTimeoutMs, 7200000, 'runTimeoutMs'),
    killGraceMs: positive(ralph.killGraceMs, 5000, 'killGraceMs'),
    maxSteps: positive(env.GANTRY_LOOP_MAX_STEPS, 40, 'GANTRY_LOOP_MAX_STEPS', true),
    stageRetries: config.autonomous?.maxRetries ?? 3,
  };
}
export function validatePack(pack, state, taskId = null) {
  if (!pack || pack.stage !== state.currentStage || pack.changeId !== state.activeChange
      || pack.pipeline !== state.pipeline || (pack.taskId ?? null) !== taskId) {
    throw new Error('stage/change/task/context-pack 不一致');
  }
  const phase = `.gantry/core/phases/${PHASE_FILES[state.currentStage]}`;
  if (!pack.loadOrder?.some(entry => entry.kind === 'phase-prompt' && entry.path === phase)) {
    throw new Error('context-pack phase-prompt 不一致');
  }
  return pack;
}

/** Explicit CLI injection is for tests/embedders; defaults always use this package. */
export async function runLoop({ root = process.cwd(), client, quiet = false, env = process.env,
  signal, onOutput = text => process.stdout.write(text), onError = text => process.stderr.write(text),
  runCli, executeCandidate, cycleModule } = {}) {
  if (!['claude', 'codex'].includes(client)) { onError('缺 client 参数(claude | codex)\n'); return 64; }
  if (!['darwin', 'linux'].includes(process.platform)) { onError('headless Ralph 仅支持 macOS/Linux\n'); return 64; }
  let options;
  try { options = readLoopOptions(root, env); } catch (error) { onError(`${error.message}\n`); return 64; }
  if (!Number.isSafeInteger(options.stageRetries) || options.stageRetries < 0) { onError('autonomous.maxRetries 需非负整数\n'); return 64; }
  const abort = new AbortController();
  const abortFromCaller = () => abort.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (signal?.aborted) abortFromCaller();
  let interruptedCode = 130;
  const interrupt = () => { interruptedCode = 130; abort.abort(); };
  const terminate = () => { interruptedCode = 143; abort.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  let deadlineHit = false;
  const timer = setTimeout(() => { deadlineHit = true; abort.abort(); }, options.runTimeoutMs);
  const logs = join(root, '.gantry/loop');
  mkdirSync(logs, { recursive: true });
  let lock;
  const start = Date.now();
  const processOptions = { cwd: root, signal: abort.signal, killGraceMs: options.killGraceMs };
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const stageFailures = new Map();
  const cli = runCli ?? (async args => runProcess(process.execPath, [CLI, ...args], {
    ...processOptions, env: { ...childEnv, GANTRY_RALPH_OWNER_NONCE: lock?.ownerNonce ?? '' },
    timeoutMs: Math.max(1, options.runTimeoutMs - (Date.now() - start)),
    // The child CLI owns verification process groups. Give its signal handler
    // enough time to finish the inner TERM/KILL cleanup before killing the CLI.
    killGraceMs: options.killGraceMs * 2 + 250,
  }));
  const dispatcher = env.GANTRY_LOOP_DISPATCHER ?? join(HERE, `dispatch-${client}.sh`);
  const freezePack = (stage, taskId, attempt) => {
    const state = readState(root);
    const pack = writeContextPack(root, { stage, changeId: state.activeChange, taskId: taskId ?? null });
    validatePack(pack, state, taskId ?? null);
    const frozen = { ...pack, attemptId: attempt?.id ?? null };
    const packs = join(logs, 'packs');
    mkdirSync(packs, { recursive: true });
    const packPath = join(packs, `${state.activeChange}-${taskId ?? stage}-${attempt?.id ?? 'stage'}.json`);
    writeFileSync(packPath, JSON.stringify(frozen, null, 2) + '\n');
    return packPath;
  };
  const dispatch = async (stage, taskId, attempt, onSpawn) => {
    const packPath = freezePack(stage, taskId, attempt);
    const log = join(logs, 'last-dispatch.log');
    writeFileSync(log, '');
    return runProcess('bash', [dispatcher, stage, ...(taskId ? [taskId] : []), '--pack', packPath], {
      ...processOptions, timeoutMs: options.executorTimeoutMs, onSpawn,
      env: { ...childEnv, PROJECT_ROOT: root, GANTRY_RALPH_OWNER_NONCE: lock?.ownerNonce ?? '',
        GANTRY_RALPH_TASK_ID: taskId ?? '', GANTRY_RALPH_ATTEMPT_ID: attempt?.id ?? '' },
      onOutput(chunk) { appendFileSync(log, chunk); if (!quiet) onOutput(chunk); },
    });
  };
  try {
    lock = acquireWorkspaceLock(root);
    for (let step = 1; step <= options.maxSteps; step++) {
      if (abort.signal.aborted) return deadlineHit ? 3 : interruptedCode;
      const state = readState(root);
      const fence = readFence(root);
      const token = computeNextStep({ ...state, ...fence, currentStage: state.currentStage, pipeline: state.pipeline });
      if (!WHITELIST.includes(token)) return 5;
      if (state.currentStage === 'idle' || !state.activeChange) { onError('无活跃 change，请先运行 gantry change\n'); return 2; }
      if (token === 'blocked') { onError(`blocked: ${fence.lastStageResult?.blockedReason ?? '阶段位置不一致'}\n`); return 2; }
      if (token === 'done') { onOutput(`✓ done (steps=${step} elapsed=${Date.now() - start}ms)\n`); return 0; }
      const stage = token.slice(7);
      if (stage !== state.currentStage) { onError('token 与当前阶段不一致\n'); return 2; }
      if (!quiet) onOutput(`[loop] step=${step}/${options.maxSteps} stage=${stage} token=${token} attempt=1\n`);
      if (state.pipeline === 'full' && stage === 'dev') {
        const cycle = cycleModule ?? await import('../lib/task-cycle.mjs');
        while (true) {
          if (abort.signal.aborted) return deadlineHit ? 3 : interruptedCode;
          const refreshed = await cycle.revalidateCompletedTasks(root, { changeId: state.activeChange, ownerNonce: lock.ownerNonce, signal: abort.signal, config: options.config });
          if (refreshed.kind !== 'completed') { onError(`${refreshed.kind}: ${refreshed.reason ?? '依赖重验失败'}\n`); return refreshed.exitCode ?? 2; }
          const task = cycle.selectReadyTask(root, { changeId: state.activeChange });
          if (!task) {
            const tasks = parseTasks(join(root, '.gantry/specs', state.activeChange, 'TASKS.md'));
            if (!tasks.length || !allTasksDone(tasks)) { onError('blocked: 无可执行任务或依赖缺有效证据\n'); return 2; }
            break;
          }
          const pack = writeContextPack(root, { stage, changeId: state.activeChange, taskId: task.id });
          validatePack(pack, state, task.id);
          const result = await cycle.convergeTask(root, task.id, {
            changeId: state.activeChange, ownerNonce: lock.ownerNonce, signal: abort.signal,
            config: options.config, timeoutMs: options.verifyTimeoutMs,
            execute: async input => executeCandidate
              ? executeCandidate({ ...input, packPath: freezePack(stage, task.id, input.attempt) })
              : dispatch(stage, task.id, input.attempt, input.onSpawn),
          });
          if (result.kind !== 'completed') { onError(`${result.kind}: ${result.reason ?? task.id}\n`); return abort.signal.aborted ? (deadlineHit ? 3 : interruptedCode) : (result.exitCode ?? 2); }
        }
      } else {
        const pack = writeContextPack(root, { stage, changeId: state.activeChange, taskId: null });
        validatePack(pack, state);
        // Approved drafts can go straight through the gate without a fresh model
        // changing the bytes the user just reviewed.
        const reviewArtifact = stage === 'design' ? 'DESIGN.md' : 'UAT.md';
        const awaitingReview = ['design', 'integration'].includes(stage)
          && existsSync(join(root, '.gantry/specs', state.activeChange, reviewArtifact));
        if (!awaitingReview && !(['design', 'integration'].includes(stage) && isStageApproved(root, stage))) {
          const result = await dispatch(stage);
          if (result.cancelled || result.timedOut) return deadlineHit ? 3 : (result.cancelled ? interruptedCode : 3);
          if (!result.cleanupComplete || result.spawnError) { onError('blocked: 客户端无法安全执行/清理\n'); return 2; }
          if (result.exitCode !== 0) { onError(`blocked: 未分类客户端失败 exit=${result.exitCode}\n`); return result.exitCode === 64 ? 64 : 2; }
        }
      }
      const advanced = await cli(['advance', '--json']);
      if (abort.signal.aborted) return deadlineHit ? 3 : interruptedCode;
      writeFileSync(join(logs, 'last-advance.log'), advanced.stdout + advanced.stderr);
      let outcome;
      try { outcome = JSON.parse(advanced.stdout); } catch { onError('blocked: advance 未返回有效 JSON\n'); return 2; }
      appendFileSync(join(logs, 'metrics.jsonl'), JSON.stringify({ ts: new Date().toISOString(), step, stage, token, rc: advanced.exitCode, attempt: 1 }) + '\n');
      if (outcome.pausedForApproval || advanced.exitCode === 2) { onError(`blocked: ${outcome.reason ?? '人工确认关卡'}\n`); return 2; }
      if (advanced.exitCode === 1 && advanced.cleanupComplete && stage !== 'dev' && readState(root).currentStage === stage) {
        const failures = (stageFailures.get(stage) ?? 0) + 1;
        stageFailures.set(stage, failures);
        if (failures <= options.stageRetries) { onError(`retry: ${stage} gate ${failures}/${options.stageRetries}\n`); continue; }
      }
      if (advanced.exitCode !== 0 || !advanced.cleanupComplete) { onError(`blocked: advance ${outcome.reason ?? advanced.exitCode}\n`); return advanced.exitCode || 2; }
      const after = readState(root);
      if (outcome.reachedEnd === 'integration' && after.currentStage === 'integration'
          && after.activeChange === state.activeChange && isStageApproved(root, 'integration')) {
        onOutput(`✓ done (steps=${step} elapsed=${Date.now() - start}ms)\n`);
        return 0;
      }
      if (after.currentStage === state.currentStage && after.activeChange === state.activeChange) { onError('stuck: advance 未推进\n'); return 5; }
      onOutput(quiet ? `step=${step}/${options.maxSteps} stage=${stage} rc=0\n` : `[loop] step=${step}/${options.maxSteps} ok\n`);
      if (after.currentStage === 'idle') return 0;
    }
    return 3;
  } catch (error) { onError(`blocked: ${error.message}\n`); return 2; }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    if (lock) releaseWorkspaceLock(root, lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const client = args.find(arg => ['claude', 'codex'].includes(arg));
  const unknown = args.find(arg => !['claude', 'codex', '--quiet', '-q', '--verbose', '-v', '--help', '-h'].includes(arg));
  if (args.includes('--help') || args.includes('-h')) console.log('用法: gantry loop <claude|codex> [--quiet|-q] [--verbose|-v]');
  else if (unknown) { console.error(`未知参数 '${unknown}'`); process.exitCode = 64; }
  else process.exitCode = await runLoop({ client, quiet: args.includes('--quiet') || args.includes('-q') });
}
