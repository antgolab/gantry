import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { prepareTask, verifyAndComplete, convergeTask, getTaskReceiptStatus } from '../src/lib/task-cycle.mjs';
import { readTaskRecord, writeTaskRecord, reserveAttempt, taskRecordPath } from '../src/lib/task-record.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-recover-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.gantry/specs/change'), { recursive: true });
  writeFileSync(join(root, 'app.txt'), 'bad');
  writeFileSync(join(root, 'verify.mjs'), "import{readFileSync}from'node:fs';process.exit(readFileSync('app.txt','utf8')==='good'?0:1)");
  writeFileSync(join(root, '.gantry/specs/change/TASKS.md'), '<task id="T01" status="pending"><write_files>app.txt</write_files><verify>node verify.mjs</verify><done>ok</done></task>');
  execFileSync('git', ['init', '-q'], { cwd: root }); execFileSync('git', ['add', '.'], { cwd: root }); return root;
}
const opts = { changeId: 'change' };

test('existing candidate is verified on restart without another executor call', async t => {
  const root = fixture(t); await prepareTask(root, 'T01', opts); writeFileSync(join(root, 'app.txt'), 'good');
  const result = await convergeTask(root, 'T01', { ...opts, execute: async () => { throw Error('must not call'); } });
  assert.equal(result.kind, 'completed'); assert.equal(result.record.repairsUsed, 0);
});

for (const point of ['receipt', 'execution', 'tasks']) test(`recovery after durable ${point} window is idempotent`, async t => {
  const root = fixture(t); await prepareTask(root, 'T01', opts); writeFileSync(join(root, 'app.txt'), 'good');
  const interrupted = await verifyAndComplete(root, 'T01', { ...opts, onCheckpoint: name => { if (name === point) throw Error('simulated crash'); } });
  assert.equal(interrupted.kind, 'blocked');
  const receipt = readTaskRecord(root, 'change', 'T01').receipt;
  const restored = await verifyAndComplete(root, 'T01', opts); assert.equal(restored.kind, 'completed');
  assert.deepEqual(restored.receipt, receipt);
  assert.equal((readFileSync(join(root, '.gantry/specs/change/EXECUTION.md'), 'utf8').match(/## T01/g) ?? []).length, 1);
  assert.equal(getTaskReceiptStatus(root, 'T01', opts).valid, true);
});

test('repair budgets survive separate process and do not reset on restart', async t => {
  const root = fixture(t); await prepareTask(root, 'T01', opts);
  let record = readTaskRecord(root, 'change', 'T01'); record = writeTaskRecord(root, { ...record, attempt: { ...record.attempt, lifecycle: 'returned' } });
  record = reserveAttempt(root, record, { repair: true }); record = reserveAttempt(root, record, { repair: true });
  const url = new URL('../src/lib/task-cycle.mjs', import.meta.url).href;
  const child = execFileSync(process.execPath, ['--input-type=module', '-e', `import{convergeTask}from ${JSON.stringify(url)};let calls=0;const r=await convergeTask(${JSON.stringify(root)},'T01',{changeId:'change',execute:async()=>{calls++;return{exitCode:0}}});console.log(JSON.stringify({kind:r.kind,used:r.record.repairsUsed,calls}));`], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(child), { kind: 'exhausted', used: 3, calls: 2 });
});

test('corrupt records and direct done without entry baseline stay blocked', async t => {
  const root = fixture(t); assert.equal((await verifyAndComplete(root, 'T01', opts)).kind, 'blocked');
  await prepareTask(root, 'T01', opts); const path = taskRecordPath(root, 'change', 'T01'); writeFileSync(path, '{bad');
  const result = await convergeTask(root, 'T01', { ...opts, execute: async () => ({ exitCode: 0 }) });
  assert.equal(result.kind, 'blocked'); assert.equal(readFileSync(path, 'utf8'), '{bad');
});

test('live executor prevents verify and duplicate reservation', async t => {
  const root = fixture(t); const prepared = await prepareTask(root, 'T01', opts);
  assert.equal((await prepareTask(root, 'T01', opts)).kind, 'blocked');
  writeTaskRecord(root, { ...prepared.record, attempt: { ...prepared.record.attempt, lifecycle: 'running', executorPid: process.pid } });
  writeFileSync(join(root, 'app.txt'), 'good');
  const result = await verifyAndComplete(root, 'T01', opts); assert.equal(result.kind, 'blocked'); assert.equal(result.reason, 'executor-still-running');
});

test('external retry exhaustion survives a separate process without new business reservation', async t => {
  const root = fixture(t); await prepareTask(root, 'T01', opts);
  const entry = readTaskRecord(root, 'change', 'T01');
  writeTaskRecord(root, { ...entry, attempt: { ...entry.attempt, lifecycle: 'returned', externalRetriesUsed: 3, result: { exitCode: 1, externalFailure: true, retryable: true } } });
  const url = new URL('../src/lib/task-cycle.mjs', import.meta.url).href;
  const child = execFileSync(process.execPath, ['--input-type=module', '-e', `import{convergeTask}from ${JSON.stringify(url)};let calls=0;const r=await convergeTask(${JSON.stringify(root)},'T01',{changeId:'change',execute:async()=>{calls++;return{exitCode:0}}});console.log(JSON.stringify({kind:r.kind,used:r.record.repairsUsed,retries:r.record.attempt.externalRetriesUsed,calls}));`], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(child), { kind: 'external-exhausted', used: 0, retries: 3, calls: 0 });
});

test('cancellation during retry backoff preserves its reservation for explicit recovery', async t => {
  const root = fixture(t); const abort = new AbortController(); let calls = 0; let observer;
  t.after(() => clearInterval(observer));
  const first = await convergeTask(root, 'T01', { ...opts, signal: abort.signal, execute: async () => {
    calls++; observer = setInterval(() => {
      if (readTaskRecord(root, 'change', 'T01').attempt.externalRetryPending) { clearInterval(observer); abort.abort(); }
    }, 20);
    return { exitCode: 1, externalFailure: true, retryable: true };
  } });
  assert.equal(first.kind, 'cancelled'); assert.equal(first.record.repairsUsed, 0);
  assert.equal(first.record.attempt.externalRetriesUsed, 1); assert.equal(first.record.attempt.externalRetryPending, true);
  const second = await convergeTask(root, 'T01', { ...opts, execute: async ({ attempt }) => {
    calls++; assert.equal(attempt.externalRetriesUsed, 1); writeFileSync(join(root, 'app.txt'), 'good'); return { exitCode: 0 };
  } });
  assert.equal(second.kind, 'completed'); assert.equal(second.record.repairsUsed, 0); assert.equal(calls, 2);
});
