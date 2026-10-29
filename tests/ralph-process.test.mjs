import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, runShellCommand } from '../src/lib/process-runner.mjs';

const posix = process.platform === 'darwin' || process.platform === 'linux';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function workspace() {
  return mkdtempSync(join(tmpdir(), 'gantry-process-'));
}

function writer(path, ignoreTerm = false) {
  return `const fs=require('node:fs'); ${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}
    fs.appendFileSync(${JSON.stringify(path)}, 'x');
    console.log('writer-ready');
    setInterval(()=>fs.appendFileSync(${JSON.stringify(path)},'x'),10);`;
}

test('runs argv with cwd/env/input and reports actual exit and streams', { skip: !posix }, async () => {
  const cwd = workspace();
  try {
    const streamed = [];
    const r = await runProcess(process.execPath, ['-e', `process.stdin.on('data', b=>{
      console.log(process.cwd(),process.env.GANTRY_PROCESS_TEST,b.toString());
      console.error('stderr-marker'); process.exitCode=7;
    });`], { cwd, env: { ...process.env, GANTRY_PROCESS_TEST: 'value' }, input: 'payload', onOutput: (chunk, stream) => streamed.push([stream, chunk]) });
    assert.equal(r.exitCode, 7);
    assert.match(r.stdout, /value payload/);
    assert.ok(r.stdout.includes(cwd));
    assert.match(r.stderr, /stderr-marker/);
    assert.ok(streamed.some(([stream]) => stream === 'stderr'));
    assert.equal(r.cleanupComplete, true);
    assert.equal(r.timedOut, false);
    assert.equal(r.cancelled, false);
    assert.ok(r.durationMs >= 0);
    assert.equal(r.processGroupId, r.pid);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('keeps bounded output tails while streaming all output', { skip: !posix }, async () => {
  let received = 0;
  const r = await runProcess(process.execPath, ['-e', "process.stdout.write('a'.repeat(20000)+'TAIL'); process.stderr.write('b'.repeat(20000)+'END');"], {
    maxOutputBytes: 128,
    onOutput: chunk => { received += Buffer.byteLength(chunk); },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(Buffer.byteLength(r.stdout), 128);
  assert.equal(Buffer.byteLength(r.stderr), 128);
  assert.ok(r.stdout.endsWith('TAIL'));
  assert.ok(r.stderr.endsWith('END'));
  assert.equal(received, 40007);
});

test('missing executable is a spawn failure, not a retryable external error', { skip: !posix }, async () => {
  const r = await runProcess('/gantry/no-such-executable');
  assert.equal(r.exitCode, null);
  assert.equal(r.spawnError.code, 'ENOENT');
  assert.equal(r.cleanupComplete, true);
  assert.equal(r.timedOut, false);
});

test('pre-aborted signal never spawns', { skip: !posix }, async () => {
  const abort = new AbortController();
  abort.abort();
  let spawned = false;
  const r = await runProcess(process.execPath, ['-e', 'throw Error("must not run")'], { signal: abort.signal, onSpawn: () => { spawned = true; } });
  assert.equal(r.cancelled, true);
  assert.equal(r.pid, null);
  assert.equal(spawned, false);
});

test('deadline kills a TERM-ignoring writer and leaves no later writes', { skip: !posix, timeout: 7000 }, async () => {
  const cwd = workspace();
  const file = join(cwd, 'writes');
  try {
    const r = await runProcess(process.execPath, ['-e', writer(file, true)], { timeoutMs: 400, killGraceMs: 80 });
    assert.equal(r.timedOut, true);
    assert.equal(r.signal, 'SIGKILL');
    assert.equal(r.cleanupComplete, true);
    assert.ok(existsSync(file));
    const after = readFileSync(file, 'utf8');
    await delay(100);
    assert.equal(readFileSync(file, 'utf8'), after);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('cancel cleans descendants while an unrelated process keeps running', { skip: !posix, timeout: 7000 }, async () => {
  const cwd = workspace();
  const file = join(cwd, 'child-writes');
  const other = join(cwd, 'unrelated-writes');
  const abort = new AbortController();
  const otherAbort = new AbortController();
  const unrelated = runProcess(process.execPath, ['-e', writer(other)], { signal: otherAbort.signal, timeoutMs: 5000 });
  try {
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer(file))}],{stdio:'inherit'});setInterval(()=>{},1000);`;
    const r = await runProcess(process.execPath, ['-e', script], {
      signal: abort.signal, killGraceMs: 80,
      onOutput: chunk => { if (chunk.includes('writer-ready')) abort.abort(); },
    });
    assert.equal(r.cancelled, true);
    assert.equal(r.cleanupComplete, true);
    const after = readFileSync(file, 'utf8');
    const otherBefore = readFileSync(other, 'utf8');
    await delay(100);
    assert.equal(readFileSync(file, 'utf8'), after);
    assert.ok(readFileSync(other, 'utf8').length > otherBefore.length);
  } finally {
    otherAbort.abort();
    await unrelated;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('leader exit still cleans live group descendants with inherited pipes', { skip: !posix, timeout: 7000 }, async () => {
  const cwd = workspace();
  const file = join(cwd, 'orphan-writes');
  try {
    const script = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer(file, true))}],{stdio:['ignore','pipe','inherit']});
      c.stdout.on('data',chunk=>{process.stdout.write(chunk); process.exit(0);});`;
    const r = await runProcess(process.execPath, ['-e', script], { killGraceMs: 80, timeoutMs: 2000 });
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.cleanupComplete, true);
    const after = readFileSync(file, 'utf8');
    await delay(100);
    assert.equal(readFileSync(file, 'utf8'), after);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('shell helper executes an authorized command and preserves nonzero result', { skip: !posix }, async () => {
  const r = await runShellCommand('printf "shell-output"; exit 9');
  assert.equal(r.stdout, 'shell-output');
  assert.equal(r.exitCode, 9);
});

test('rejects unbounded or invalid execution options', async () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { killGraceMs: -1 }, { maxOutputBytes: 0 }]) {
    await assert.rejects(runProcess(process.execPath, [], options), /positive|non-negative|finite/i);
  }
});

test('invalid command and argv fail before spawning any executable', async () => {
  for (const [command, args] of [['', []], [null, []], [process.execPath, 'not-an-array'], [process.execPath, [1]]]) {
    await assert.rejects(runProcess(command, args), /command must be a nonempty string and args must be strings/);
  }
});

test('synchronous spawn rejection is returned as a spawn failure', { skip: !posix }, async () => {
  const result = await runProcess('invalid\0executable');
  assert.equal(result.pid, null);
  assert.equal(result.exitCode, null);
  assert.equal(result.spawnError.code, 'ERR_INVALID_ARG_VALUE');
  assert.match(result.spawnError.message, /null bytes/);
  assert.equal(result.cleanupComplete, true);
});

test('throwing onSpawn callback terminates its process instead of losing supervision', { skip: !posix, timeout: 5000 }, async () => {
  let spawned;
  const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    timeoutMs: 3000, killGraceMs: 50,
    onSpawn: identity => { spawned = identity; throw new Error('ownership journal unavailable'); },
  });
  assert.ok(spawned.pid > 0);
  assert.equal(spawned.pid, spawned.processGroupId);
  assert.equal(result.callbackError.message, 'ownership journal unavailable');
  assert.equal(result.cleanupComplete, true);
  assert.equal(result.timedOut, false);
  assert.throws(() => process.kill(spawned.pid, 0), /ESRCH/);
});

test('throwing output callback stops a live writer and retains bounded diagnostics', { skip: !posix, timeout: 5000 }, async () => {
  const cwd = workspace();
  const file = join(cwd, 'callback-writes');
  try {
    const result = await runProcess(process.execPath, ['-e', writer(file, true)], {
      timeoutMs: 3000, killGraceMs: 50,
      onOutput: () => { throw 'output sink disconnected'; },
    });
    assert.equal(result.callbackError.message, 'output sink disconnected');
    assert.match(result.stdout, /writer-ready/);
    assert.equal(result.cleanupComplete, true);
    assert.equal(result.timedOut, false);
    const after = readFileSync(file, 'utf8');
    await delay(100);
    assert.equal(readFileSync(file, 'utf8'), after);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('escaped descendant retaining pipes is reported unclean rather than hanging or claiming cleanup', { skip: !posix, timeout: 7000 }, async () => {
  const cwd = workspace();
  const file = join(cwd, 'escaped-writes');
  let escapedPid;
  try {
    const script = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(writer(file))}], {detached:true, stdio:'inherit'}); console.log('escaped-pid='+child.pid); child.unref();`;
    const result = await runProcess(process.execPath, ['-e', script], { timeoutMs: 4000, killGraceMs: 50 });
    escapedPid = Number(result.stdout.match(/escaped-pid=(\d+)/)?.[1]);
    assert.ok(escapedPid > 0, 'fixture reports exact owned child PID for cleanup');
    assert.equal(result.exitCode, 0);
    assert.equal(result.cleanupComplete, false);
    assert.equal(result.timedOut, false);
    assert.ok(result.durationMs >= 1900 && result.durationMs < 6000);
    const before = readFileSync(file, 'utf8');
    await delay(60);
    assert.ok(readFileSync(file, 'utf8').length > before.length, 'escaped writer is outside process-group guarantee');
  } finally {
    // Only this fixture's explicitly reported detached child is ours to kill.
    if (escapedPid) { try { process.kill(-escapedPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    rmSync(cwd, { recursive: true, force: true });
  }
});
