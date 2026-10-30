/** Bounded stage supervisor. Model output is a candidate, never completion proof. */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { readState, readFence, isStageApproved } from '../lib/state.mjs';
import { readConfig } from '../lib/config.mjs';
import { writeContextPack } from '../lib/context-pack.mjs';
import { PHASE_FILES } from '../lib/phases.mjs';
import { computeNextStep, WHITELIST } from '../lib/loop.mjs';
import { runProcess } from '../lib/process-runner.mjs';
import { acquireWorkspaceLock, releaseWorkspaceLock, MAX_TASK_REPAIRS } from '../lib/task-record.mjs';
import { DEFAULT_RALPH_DEADLINES } from '../lib/task-evidence.mjs';
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
  if (!Number.isSafeInteger(ralph.maxRepairs ?? MAX_TASK_REPAIRS) || (ralph.maxRepairs ?? MAX_TASK_REPAIRS) < 0) throw new Error('maxRepairs 需非负安全整数');
  return {
    config,
    executorTimeoutMs: positive(ralph.executorTimeoutMs, DEFAULT_RALPH_DEADLINES.executorTimeoutMs, 'executorTimeoutMs'),
    verifyTimeoutMs: positive(ralph.verifyTimeoutMs, DEFAULT_RALPH_DEADLINES.verifyTimeoutMs, 'verifyTimeoutMs'),
    runTimeoutMs: positive(ralph.runTimeoutMs, DEFAULT_RALPH_DEADLINES.runTimeoutMs, 'runTimeoutMs'),
    killGraceMs: positive(ralph.killGraceMs, DEFAULT_RALPH_DEADLINES.killGraceMs, 'killGraceMs'),
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
export async function runLoop({ root = process.cwd(), client, quiet = false, autoApprove = false, verbose = false, env = process.env,
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
  let timer = setTimeout(() => { deadlineHit = true; abort.abort(); }, options.runTimeoutMs);
  const logs = join(root, '.gantry/loop');
  mkdirSync(logs, { recursive: true });
  // 全量日志 loop.log 放唯一临时目录（避免多进程/多次运行串写同一文件）；
  // last-dispatch/last-advance/metrics/packs 仍在 .gantry/loop/。GANTRY_LOOP_LOG_DIR
  // 可显式指定固定位置（测试/嵌入方用），否则 mkdtemp 保证唯一。
  let fullLogDir;
  if (env.GANTRY_LOOP_LOG_DIR) {
    fullLogDir = env.GANTRY_LOOP_LOG_DIR;
    mkdirSync(fullLogDir, { recursive: true });
  } else {
    fullLogDir = mkdtempSync(join(tmpdir(), 'gantry-loop-log-'));
  }
  const fullLog = join(fullLogDir, 'loop.log');
  // 控制台只留进度（onOutput）与错误（onError）；onOutput/onError 包装成「先落盘再上屏」，
  // 模型 dispatch 流另行处理（见 dispatch）。
  const consoleOut = onOutput;
  const consoleErr = onError;
  onOutput = (text) => { appendFileSync(fullLog, text); consoleOut(text); };
  onError = (text) => { appendFileSync(fullLog, text); consoleErr(text); };
  if (!quiet) consoleOut(`[loop] 全量日志: ${fullLog}\n`);
  let lock;
  const start = Date.now();
  const processOptions = { cwd: root, signal: abort.signal, killGraceMs: options.killGraceMs };
  const refreshOptions = () => {
    options = readLoopOptions(root, env);
    if (!Number.isSafeInteger(options.stageRetries) || options.stageRetries < 0) throw new Error('autonomous.maxRetries 需非负整数');
    processOptions.killGraceMs = options.killGraceMs;
    clearTimeout(timer);
    const remaining = options.runTimeoutMs - (Date.now() - start);
    if (remaining <= 0) { deadlineHit = true; abort.abort(); }
    else timer = setTimeout(() => { deadlineHit = true; abort.abort(); }, remaining);
  };
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const stageFailures = new Map();
  const metricsPath = join(logs, 'metrics.jsonl');
  const recoveryKey = state => `${state.activeChange}:${state.currentStage}`;
  const retryStage = (state, feedback) => {
    refreshOptions();
    const key = recoveryKey(state);
    if ((stageFailures.get(key)?.failures ?? 0) > options.stageRetries) return false;
    const failures = (stageFailures.get(key)?.failures ?? 0) + 1;
    const recovery = { failures, feedback };
    stageFailures.set(key, recovery);
    appendFileSync(metricsPath, JSON.stringify({ ts: new Date().toISOString(), changeId: state.activeChange,
      stage: state.currentStage, gateRecovery: recovery }) + '\n');
    if (failures > options.stageRetries) {
      onError(`exhausted: ${state.currentStage} gate repairs=${options.stageRetries}; ${feedback.reason}\n`);
      return false;
    }
    onOutput(`retry: ${state.currentStage} gate ${failures}/${options.stageRetries}; ${feedback.reason}\n`);
    return true;
  };
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
    const frozen = { ...pack, attemptId: attempt?.id ?? null,
      gateFeedback: stageFailures.get(recoveryKey(state)) ?? null };
    const packs = join(logs, 'packs');
    mkdirSync(packs, { recursive: true });
    const packPath = join(packs, `${state.activeChange}-${taskId ?? stage}-${attempt?.id ?? 'stage'}.json`);
    writeFileSync(packPath, JSON.stringify(frozen, null, 2) + '\n');
    return packPath;
  };
  const dispatch = async (stage, taskId, attempt, onSpawn) => {
    refreshOptions();
    const packPath = freezePack(stage, taskId, attempt);
    const log = join(logs, 'last-dispatch.log');
    writeFileSync(log, '');
    return runProcess('bash', [dispatcher, stage, ...(taskId ? [taskId] : []), '--pack', packPath], {
      ...processOptions, timeoutMs: options.executorTimeoutMs, onSpawn,
      env: { ...childEnv, PROJECT_ROOT: root, GANTRY_RALPH_OWNER_NONCE: lock?.ownerNonce ?? '',
        GANTRY_RALPH_TASK_ID: taskId ?? '', GANTRY_RALPH_ATTEMPT_ID: attempt?.id ?? '' },
      onOutput(chunk) { appendFileSync(log, chunk); appendFileSync(fullLog, chunk); if (verbose) consoleOut(chunk); },
    });
  };
  try {
    lock = acquireWorkspaceLock(root);
    // Reuse the existing metrics journal so restarting cannot reset gate retries.
    if (existsSync(metricsPath)) for (const line of readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean)) {
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      if (entry.gateRecovery) stageFailures.set(`${entry.changeId}:${entry.stage}`, entry.gateRecovery);
      if (entry.gateRecovered) stageFailures.delete(`${entry.changeId}:${entry.stage}`);
    }
    for (let step = 1; step <= options.maxSteps; step++) {
      refreshOptions();
      if (abort.signal.aborted) return deadlineHit ? 3 : interruptedCode;
      const state = readState(root);
      const fence = readFence(root);
      // A new loop invocation retries the current gates. Historical diagnostics
      // are not an independent gate that can prevent checking a repaired task.
      const currentResult = fence.lastStageResult ? { ...fence.lastStageResult, blockedReason: null } : null;
      const token = computeNextStep({ ...state, ...fence, lastStageResult: currentResult, currentStage: state.currentStage, pipeline: state.pipeline });
      if (!WHITELIST.includes(token)) return 5;
      if (state.currentStage === 'idle' || !state.activeChange) { onError('无活跃 change，请先运行 gantry change\n'); return 2; }
      if (token === 'blocked') { onError(`blocked: ${fence.lastStageResult?.blockedReason ?? '阶段位置不一致'}\n`); return 2; }
      if (token === 'done') { onOutput(`✓ done (steps=${step} elapsed=${Date.now() - start}ms)\n`); return 0; }
      const stage = token.slice(7);
      if (stage !== state.currentStage) { onError('token 与当前阶段不一致\n'); return 2; }
      if (!quiet) onOutput(`[loop] step=${step}/${options.maxSteps} stage=${stage} token=${token} attempt=1\n`);
      if (state.pipeline === 'full' && stage === 'dev') {
        const cycle = cycleModule ?? await import('../lib/task-cycle.mjs');
        const feedback = stageFailures.get(recoveryKey(state))?.feedback;
        if (feedback?.outcome?.checkpoint) {
          const checkpoint = feedback.outcome.checkpoint;
          const taskId = checkpoint.record?.taskId ?? checkpoint.results?.at(-1)?.taskId;
          if (taskId) {
            const repaired = await cycle.convergeTask(root, taskId, {
              changeId: state.activeChange, ownerNonce: lock.ownerNonce, signal: abort.signal,
              gateFeedback: { reason: feedback.reason, runs: checkpoint.commands ?? checkpoint.runs ?? [] },
              execute: async input => executeCandidate
                ? executeCandidate({ ...input, packPath: freezePack(stage, taskId, input.attempt) })
                : dispatch(stage, taskId, input.attempt, input.onSpawn),
            });
            if (repaired.kind !== 'completed') { onError(`${repaired.kind}: ${repaired.reason}\n`); return repaired.exitCode ?? 2; }
          }
        }
        while (true) {
          refreshOptions();
          if (abort.signal.aborted) return deadlineHit ? 3 : interruptedCode;
          const refreshed = await cycle.revalidateCompletedTasks(root, { changeId: state.activeChange, ownerNonce: lock.ownerNonce, signal: abort.signal,
            execute: async input => executeCandidate
              ? executeCandidate({ ...input, packPath: freezePack(stage, input.task.id, input.attempt) })
              : dispatch(stage, input.task.id, input.attempt, input.onSpawn),
          });
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
            execute: async input => executeCandidate
              ? executeCandidate({ ...input, packPath: freezePack(stage, task.id, input.attempt) })
              : dispatch(stage, task.id, input.attempt, input.onSpawn),
          });
          if (result.kind !== 'completed') { onError(`${result.kind}: ${result.reason ?? task.id}${result.lastFailure?.reason ? `; last: ${result.lastFailure.reason}` : ''}\n`); return abort.signal.aborted ? (deadlineHit ? 3 : interruptedCode) : (result.exitCode ?? 2); }
          if (result.scope?.outOfScope.length) onOutput(`[loop] ${task.id} 范围提示（不阻断）:\n${result.scope.outOfScope.map(path => `  ${path}`).join('\n')}\n`);
        }
      } else {
        const pack = writeContextPack(root, { stage, changeId: state.activeChange, taskId: null });
        validatePack(pack, state);
        // Approved drafts can go straight through the gate without a fresh model
        // changing the bytes the user just reviewed.
        const reviewArtifact = stage === 'design' ? 'DESIGN.md' : 'UAT.md';
        const awaitingReview = ['design', 'integration'].includes(stage)
          && existsSync(join(root, '.gantry/specs', state.activeChange, reviewArtifact));
        if ((stageFailures.get(recoveryKey(state))?.failures ?? 0) <= options.stageRetries &&
            (stageFailures.has(recoveryKey(state)) || (!awaitingReview && !(['design', 'integration'].includes(stage) && isStageApproved(root, stage))))) {
          const result = await dispatch(stage);
          if (result.cancelled || result.timedOut) return deadlineHit ? 3 : (result.cancelled ? interruptedCode : 3);
          if (!result.cleanupComplete || result.spawnError) { onError('blocked: 客户端无法安全执行/清理\n'); return 2; }
          if (result.exitCode !== 0) {
            if (result.exitCode !== 64 && retryStage(state, { reason: `客户端失败 exit=${result.exitCode}`, stdout: result.stdout, stderr: result.stderr })) { step--; continue; }
            return result.exitCode === 64 ? 64 : 2;
          }
        }
      }
      const advanced = await cli(['advance', '--json']);
      if (abort.signal.aborted) return deadlineHit ? 3 : interruptedCode;
      writeFileSync(join(logs, 'last-advance.log'), advanced.stdout + advanced.stderr);
      appendFileSync(fullLog, advanced.stdout + advanced.stderr);
      let outcome;
      try { outcome = JSON.parse(advanced.stdout); } catch { onError('blocked: advance 未返回有效 JSON\n'); return 2; }
      appendFileSync(join(logs, 'metrics.jsonl'), JSON.stringify({ ts: new Date().toISOString(), step, stage, token, rc: advanced.exitCode, attempt: 1 }) + '\n');
      if (outcome.pausedForApproval && readState(root).currentStage !== stage) {
        // Entering the next approval stage is a successful transition too.
        stageFailures.delete(recoveryKey(state));
        appendFileSync(metricsPath, JSON.stringify({ changeId: state.activeChange, stage, gateRecovered: true }) + '\n');
      }
      if (outcome.pausedForApproval) {
        // --auto-approve：无人值守环境替人批准 hard-lock 关卡（change/design/integration）。
        // 只自动批准「内容绑定的摘要」这一层，不自动跳过 hard 门禁。留痕到 metrics.jsonl。
        if (autoApprove && outcome.pausedForApproval) {
          if (outcome.stop) {
            // 已在关卡阶段、工件已生成：自动批准并继续推进。
            const approved = await cli(['advance', '--approve', outcome.pausedForApproval, '--json']);
            writeFileSync(join(logs, 'last-advance.log'), approved.stdout + approved.stderr);
            appendFileSync(fullLog, approved.stdout + approved.stderr);
            appendFileSync(join(logs, 'metrics.jsonl'), JSON.stringify({ ts: new Date().toISOString(), step, stage: outcome.pausedForApproval, autoApprove: true, rc: approved.exitCode }) + '\n');
            if (approved.exitCode !== 0) {
              let reason = '未知';
              try { reason = JSON.parse(approved.stdout).reason ?? reason; } catch { /* 非 JSON 输出保留占位 */ }
              if (approved.cleanupComplete && [1, 2].includes(approved.exitCode) && retryStage(readState(root), {
                reason, stdout: approved.stdout, stderr: approved.stderr,
              })) { step--; continue; }
              onError(`blocked: 自动批准 ${outcome.pausedForApproval} 后推进失败（${reason}）\n`);
              return approved.exitCode || 2;
            }
            if (!quiet) onOutput(`[loop] auto-approved ${outcome.pausedForApproval}\n`);
          }
          // stop===false：advance 已推进进关卡阶段，continue 让下一轮先 dispatch 生成工件再走 stop===true 分支。
          continue;
        }
        onError(`blocked: ${outcome.reason ?? '人工确认关卡'}\n`); return 2;
      }
      if ([1, 2].includes(advanced.exitCode) && advanced.cleanupComplete && readState(root).currentStage === stage) {
        // DEV commit ownership/integrity stops are not code defects. A failing
        // checkpoint is repairable; it re-enters task convergence on the next turn.
        const repairable = stage !== 'dev' || outcome.checkpoint &&
          (outcome.checkpoint.kind === 'failed' || (await import('../lib/task-cycle.mjs')).canRepairGate(outcome.checkpoint));
        if (repairable && retryStage(state, { reason: outcome.reason ?? '阶段门禁未通过', outcome,
          stdout: advanced.stdout, stderr: advanced.stderr })) { step--; continue; }
      }
      if (advanced.exitCode !== 0 || !advanced.cleanupComplete) { onError(`blocked: advance ${outcome.reason ?? advanced.exitCode}\n`); return advanced.exitCode || 2; }
      const after = readState(root);
      if (after.currentStage === state.currentStage && after.activeChange === state.activeChange) { onError('stuck: advance 未推进\n'); return 5; }
      stageFailures.delete(recoveryKey(state));
      appendFileSync(metricsPath, JSON.stringify({ changeId: state.activeChange, stage, gateRecovered: true }) + '\n');
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
  const unknown = args.find(arg => !['claude', 'codex', '--quiet', '-q', '--verbose', '-v', '--auto-approve', '--help', '-h'].includes(arg));
  if (args.includes('--help') || args.includes('-h')) console.log('用法: gantry loop <claude|codex> [--quiet|-q] [--verbose|-v] [--auto-approve]');
  else if (unknown) { console.error(`未知参数 '${unknown}'`); process.exitCode = 64; }
  else process.exitCode = await runLoop({ client, quiet: args.includes('--quiet') || args.includes('-q'), autoApprove: args.includes('--auto-approve'), verbose: args.includes('--verbose') || args.includes('-v') });
}
