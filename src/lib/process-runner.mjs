import { spawn, spawnSync } from 'node:child_process';

function numberOption(value, name, minimum) {
  if (!Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${name} must be finite and ${minimum === 0 ? 'non-negative' : 'positive'}`);
  }
}

// kill(0) includes zombies on Linux. They cannot do further work and need to
// be reaped by their parent, so only live members prevent group completion.
function groupAlive(group) {
  try { process.kill(-group, 0); } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
  const snapshot = spawnSync('ps', ['-axo', 'pid=,pgid=,stat='], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024,
  });
  if (snapshot.status !== 0 || snapshot.error) return true;
  return snapshot.stdout.split('\n').some(line => {
    const [, pgid, state] = line.trim().split(/\s+/);
    return Number(pgid) === group && state && !state.startsWith('Z');
  });
}

/** Execute one bounded command in its own POSIX process group.
 * Output callbacks receive strings; stdout/stderr retain only bounded tails.
 * Cleanup covers descendants remaining in that group, not daemonized escapes.
 */
export async function runProcess(command, args = [], options = {}) {
  const {
    timeoutMs = 900000, killGraceMs = 5000, maxOutputBytes = 65536,
    cwd, env, signal, onOutput, onSpawn, input, shell = false,
  } = options;
  numberOption(timeoutMs, 'timeoutMs', 1);
  numberOption(killGraceMs, 'killGraceMs', 0);
  numberOption(maxOutputBytes, 'maxOutputBytes', 1);
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new TypeError('command must be a nonempty string and args must be strings');
  }
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error('Process group execution requires macOS or Linux');
  }
  const start = Date.now();
  const result = {
    exitCode: null, signal: null, timedOut: false, cancelled: false,
    stdout: '', stderr: '', pid: null, processGroupId: null,
    startedAt: new Date(start).toISOString(), finishedAt: null, durationMs: 0,
    cleanupComplete: true, spawnError: null,
  };
  const finishResult = () => {
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.now() - start;
    return result;
  };
  if (signal?.aborted) {
    result.cancelled = true;
    return finishResult();
  }

  return new Promise(resolve => {
    let child;
    let deadline;
    let poll;
    let drainDeadline;
    let closed = false;
    let cleaning = false;
    let cleanupDone = false;
    let cleanupStarted = 0;
    let killed = false;
    let finished = false;
    const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };

    function finish() {
      if (finished || !cleanupDone || !closed) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(poll);
      clearTimeout(drainDeadline);
      signal?.removeEventListener('abort', abort);
      result.stdout = tails.stdout.toString('utf8');
      result.stderr = tails.stderr.toString('utf8');
      resolve(finishResult());
    }
    function sendSignal(name) {
      if (!result.processGroupId) return;
      try { process.kill(-result.processGroupId, name); } catch (error) {
        if (error.code !== 'ESRCH') result.cleanupError = { code: error.code, message: error.message };
      }
    }
    function checkCleanup() {
      if (!groupAlive(result.processGroupId)) {
        cleanupDone = true;
        if (!closed) {
          // A descendant that escaped the group may retain inherited pipes.
          // This is outside the cleanup guarantee, but cannot hang a run.
          drainDeadline = setTimeout(() => {
            result.cleanupComplete = false;
            child.stdout.destroy();
            child.stderr.destroy();
            child.stdin.destroy();
            closed = true;
            finish();
          }, 2000);
        }
        finish();
        return;
      }
      const elapsed = Date.now() - cleanupStarted;
      if (!killed && elapsed >= killGraceMs) {
        killed = true;
        sendSignal('SIGKILL');
      }
      if (elapsed >= killGraceMs + 2000) {
        result.cleanupComplete = false;
        cleanupDone = true;
        // A retained pipe must not hang the controller indefinitely.
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        closed = true;
        finish();
        return;
      }
      poll = setTimeout(checkCleanup, 20);
    }
    function cleanup() {
      if (cleaning) return;
      cleaning = true;
      clearTimeout(deadline);
      if (!result.processGroupId) {
        cleanupDone = true;
        finish();
        return;
      }
      cleanupStarted = Date.now();
      sendSignal('SIGTERM');
      checkCleanup();
    }
    function abort() {
      if (cleaning) return;
      result.cancelled = true;
      cleanup();
    }
    function callbackError(error) {
      result.callbackError = { message: error.message ?? String(error) };
      cleanup();
    }
    try {
      child = spawn(command, args, { cwd, env, shell, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      result.spawnError = { code: error.code, message: error.message };
      resolve(finishResult());
      return;
    }
    result.pid = child.pid ?? null;
    result.processGroupId = result.pid;
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', chunk => {
        const combined = Buffer.concat([tails[stream], chunk]);
        tails[stream] = combined.subarray(Math.max(0, combined.length - Math.floor(maxOutputBytes)));
        try { onOutput?.(chunk.toString('utf8'), stream); } catch (error) { callbackError(error); }
      });
    }
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') callbackError(error);
    });
    child.on('error', error => {
      result.spawnError = { code: error.code, message: error.message };
      cleanup();
    });
    child.on('exit', (code, exitSignal) => {
      result.exitCode = code;
      result.signal = exitSignal;
      cleanup();
    });
    child.on('close', () => {
      closed = true;
      finish();
    });
    signal?.addEventListener('abort', abort, { once: true });
    deadline = setTimeout(() => {
      result.timedOut = true;
      cleanup();
    }, timeoutMs);
    child.on('spawn', () => {
      try { onSpawn?.({ pid: result.pid, processGroupId: result.processGroupId }); } catch (error) { callbackError(error); }
    });
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}

export function runShellCommand(command, options = {}) {
  return runProcess('/bin/sh', ['-c', command], options);
}
