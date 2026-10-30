import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { convergeTask, prepareTask, verifyAndComplete, getTaskReceiptStatus, selectReadyTask, checkpointTasks, revalidateCompletedTasks } from '../src/lib/task-cycle.mjs';
import { readTaskRecord } from '../src/lib/task-record.mjs';

function fixture(t, { preflight = '', checks = '', verify = 'node --test --test-reporter=tap behavior.test.mjs' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-cycle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.gantry/specs/change'), { recursive: true });
  writeFileSync(join(root, 'app.txt'), 'bad');
  writeFileSync(join(root, 'behavior.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('behavior',()=>assert.equal(readFileSync('app.txt','utf8'),'good'));\n");
  writeFileSync(join(root, '.gantry/specs/change/TASKS.md'), `<task id="T01" status="pending"><read_files>app.txt</read_files><write_files>app.txt</write_files><verify>${verify}</verify><done>behavior works</done><preflight>${preflight}</preflight><checks>${checks}</checks></task>`);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}
const opts = { changeId: 'change' };
const content = root => readFileSync(join(root, '.gantry/specs/change/TASKS.md'), 'utf8');

test('executor stdout claiming done is not evidence; initial plus three repairs exhaust', async t => {
  const root = fixture(t); let calls = 0;
  const result = await convergeTask(root, 'T01', { ...opts, execute: async ({ attempt }) => { assert.equal(attempt.repairOrdinal, calls++); if (attempt.repairOrdinal > 0) assert.match(readFileSync(join(root, '.gantry/specs/change/EXECUTION.md'), 'utf8'), /Self-Heal Log[\s\S]*command: `node --test/); return { exitCode: 0, stdout: 'ALL DONE PASS' }; } });
  assert.equal(result.kind, 'exhausted'); assert.equal(calls, 4);
  assert.equal(result.record.repairsUsed, 3); assert.doesNotMatch(content(root), /status="done"/);
});

test('third repair may succeed and receipt contains actual TAP counts', async t => {
  const root = fixture(t); const ids = [];
  const result = await convergeTask(root, 'T01', { ...opts, execute: async ({ attempt }) => { ids.push(attempt.id); if (attempt.repairOrdinal === 3) writeFileSync(join(root, 'app.txt'), 'good'); return { exitCode: 0 }; } });
  assert.equal(result.kind, 'completed'); assert.equal(result.record.repairsUsed, 3);
  assert.equal(new Set(ids).size, 4); assert.equal(result.receipt.runs[0].inspection.counts.tests, 1);
  assert.equal(getTaskReceiptStatus(root, 'T01', opts).valid, true);
  assert.match(content(root), /status="done"/);
});

test('preflight failure enters bounded agent repair instead of stopping before dispatch', async t => {
  const root = fixture(t, { preflight: 'node -e "process.exit(7)"' }); let calls = 0;
  const result = await convergeTask(root, 'T01', { ...opts, execute: async () => { calls++; return {exitCode:0}; } });
  assert.equal(result.kind, 'exhausted'); assert.equal(calls, 4);
  assert.match(result.record.failure.reason, /preflight/);
  assert.equal(readTaskRecord(root, 'change', 'T01').repairsUsed, 3);
});

test('checks fail even when focused behavior passed', async t => {
  const root = fixture(t, { checks: 'node -e "process.exit(4)"' });
  await prepareTask(root, 'T01', opts); writeFileSync(join(root, 'app.txt'), 'good');
  const result = await verifyAndComplete(root, 'T01', opts);
  assert.equal(result.kind, 'failed'); assert.equal(result.runs.length, 2);
  assert.doesNotMatch(content(root), /status="done"/);
});

test('verification timeout stops and preserves pending task', async t => {
  const root = fixture(t, { verify: 'node -e "setInterval(()=>{},1000)"' });
  const result = await convergeTask(root, 'T01', { ...opts, timeoutMs: 80, config: { killGraceMs: 30 }, execute: async () => ({ exitCode: 0 }) });
  assert.equal(result.kind, 'timeout'); assert.equal(result.record.repairsUsed, 0);
  assert.doesNotMatch(content(root), /status="done"/);
});

test('ready selection requires dependency status and current valid receipt', async t => {
  const root = fixture(t); const path = join(root, '.gantry/specs/change/TASKS.md');
  writeFileSync(path, content(root) + '\n<task id="T02" status="pending"><write_files>app.txt</write_files><verify>true</verify><done>ok</done><depends_on>T01</depends_on></task>');
  assert.equal(selectReadyTask(root, opts).id, 'T01');
  await prepareTask(root, 'T01', opts); writeFileSync(join(root, 'app.txt'), 'good');
  assert.equal((await verifyAndComplete(root, 'T01', opts)).kind, 'completed');
  assert.equal(selectReadyTask(root, opts).id, 'T02');
  writeFileSync(join(root, 'app.txt'), 'changed');
  assert.equal(selectReadyTask(root, opts), null);
});

test('验收源固定，候选不能改 verify 为 true', async t => {
  const root = fixture(t); await prepareTask(root, 'T01', opts);
  const path = join(root, '.gantry/specs/change/TASKS.md'); writeFileSync(path, content(root).replace('node --test --test-reporter=tap behavior.test.mjs', 'true'));
  const result = await verifyAndComplete(root, 'T01', opts);
  assert.equal(result.kind, 'blocked'); assert.match(result.reason, /contract changed/);
});

test('plain successful shell command records unknown test count, not zero', async t => {
  const root = fixture(t, { verify: 'true' });
  await prepareTask(root, 'T01', opts); const result = await verifyAndComplete(root, 'T01', opts);
  assert.equal(result.kind, 'completed'); assert.equal(result.receipt.runs[0].inspection.counts, null);
  assert.equal((await checkpointTasks(root, opts)).kind, 'completed');
});

test('zero-test failure remains visible even with additional files', async t => {
  const root = fixture(t, { verify: `node -e "console.log('# tests 0\\n# pass 0\\n# fail 0')"` });
  await prepareTask(root, 'T01', opts);
  const zero = await verifyAndComplete(root, 'T01', opts); assert.equal(zero.kind, 'failed'); assert.equal(zero.reason, 'zero-tests');
  writeFileSync(join(root, 'other.txt'), 'out of bounds');
  const out = await verifyAndComplete(root, 'T01', opts); assert.equal(out.kind, 'failed'); assert.equal(out.reason, 'zero-tests');
});

test('nonzero executor exits with a safely returned candidate use the bounded repair budget', async t => {
  const root = fixture(t); let calls = 0;
  const options = { ...opts, execute: async () => { calls++; return { exitCode: 17 }; } };
  const first = await convergeTask(root, 'T01', options);
  assert.equal(first.kind, 'exhausted');
  const resumed = await convergeTask(root, 'T01', options);
  assert.equal(resumed.kind, 'exhausted'); assert.equal(calls, 4); assert.equal(resumed.record.repairsUsed, 3);
});

test('missing verification runner is sent back to the agent until repair budget exhausts', async t => {
  const root = fixture(t, { verify: 'gantry-missing-runner-for-test-93481' }); let calls = 0;
  const result = await convergeTask(root, 'T01', { ...opts, execute: async () => { calls++; return { exitCode: 0 }; } });
  assert.equal(result.kind, 'exhausted'); assert.equal(result.record.failure.reason, 'command-unavailable');
  assert.equal(calls, 4); assert.equal(result.record.repairsUsed, 3);
});

test('preflight may not silently rewrite the baseline', async t => {
  const root = fixture(t, { preflight: `node -e "require('fs').writeFileSync('app.txt','good')"` });
  const result = await prepareTask(root, 'T01', opts);
  assert.equal(result.kind, 'blocked'); assert.equal(result.reason, 'preflight-mutated-content');
  assert.equal(readTaskRecord(root, 'change', 'T01'), null);
});

test('full checkpoint deduplicates the same successful command on identical content', async t => {
  const root = fixture(t, { verify: `node -e "require('fs').appendFileSync('.gantry/planning/counter','x')"` });
  mkdirSync(join(root, '.gantry/planning'), { recursive: true });
  const path = join(root, '.gantry/specs/change/TASKS.md');
  const first = content(root);
  writeFileSync(path, first + first.replace(/T01/g, 'T02'));
  for (const id of ['T01', 'T02']) {
    await prepareTask(root, id, opts);
    assert.equal((await verifyAndComplete(root, id, opts)).kind, 'completed');
  }
  writeFileSync(join(root, 'app.txt'), 'good');
  const before = readFileSync(join(root, '.gantry/planning/counter'), 'utf8').length;
  const verify = readTaskRecord(root, 'change', 'T01').contract.verify;
  assert.equal((await checkpointTasks(root, { ...opts, config: { checkpointCommands: [verify] } })).kind, 'completed');
  assert.equal(readFileSync(join(root, '.gantry/planning/counter'), 'utf8').length - before, 1);
});

test('known external retries use at most sixteen physical calls across four business attempts', { timeout: 90000 }, async t => {
  const root = fixture(t); const calls = new Map(); let physical = 0;
  const result = await convergeTask(root, 'T01', { ...opts, execute: async ({ attempt }) => {
    physical++;
    const n = (calls.get(attempt.id) ?? 0) + 1; calls.set(attempt.id, n);
    return n < 4 ? { exitCode: 1, externalFailure: true, retryable: true } : { exitCode: 0 };
  } });
  assert.equal(result.kind, 'exhausted'); assert.equal(result.record.repairsUsed, 3);
  assert.equal(physical, 16); assert.equal(calls.size, 4); assert.deepEqual([...calls.values()], [4, 4, 4, 4]);
});


test('completed task evidence is refreshed before selecting later dependencies', async t => {
  const root = fixture(t); const path = join(root, '.gantry/specs/change/TASKS.md');
  writeFileSync(path, content(root) + '<task id="T02" status="pending"><write_files>second.txt</write_files><verify>true</verify><done>second</done></task><task id="T03" status="pending"><write_files>third.txt</write_files><verify>true</verify><done>third</done><depends_on>T01,T02</depends_on></task>');
  await prepareTask(root, 'T01', opts); writeFileSync(join(root, 'app.txt'), 'good');
  assert.equal((await verifyAndComplete(root, 'T01', opts)).kind, 'completed');
  await prepareTask(root, 'T02', opts); writeFileSync(join(root, 'second.txt'), 'second');
  assert.equal((await verifyAndComplete(root, 'T02', opts)).kind, 'completed');
  assert.equal(selectReadyTask(root, opts), null);
  assert.equal((await revalidateCompletedTasks(root, opts)).kind, 'completed');
  assert.equal(selectReadyTask(root, opts).id, 'T03');
});

test('invalid explicit Ralph configuration blocks before spending an attempt', async t => {
  for (const config of [{ ralph: null }, { ralph: [] }, { ralph: { runTimeoutMs: 0 } }, { ralph: { maxRepairs: -1 } }, { ralph: { checkpointCommands: 'true' } }]) {
    const root = fixture(t); mkdirSync(join(root, '.gantry/planning'), { recursive: true });
    writeFileSync(join(root, '.gantry/planning/config.json'), JSON.stringify(config));
    const prepared = await prepareTask(root, 'T01', opts);
    assert.equal(prepared.kind, 'blocked'); assert.equal(readTaskRecord(root, 'change', 'T01'), null);
  }
});


test('duplicate task identities cannot reuse one receipt for two task definitions', async t => {
  const root = fixture(t); const path = join(root, '.gantry/specs/change/TASKS.md');
  writeFileSync(path, content(root) + content(root).replace('behavior works', 'another acceptance'));
  const result = await prepareTask(root, 'T01', opts);
  assert.equal(result.kind, 'blocked'); assert.match(result.reason, /duplicate task identities/);
  assert.equal(readTaskRecord(root, 'change', 'T01'), null);
});


test('additional files and updated write guidance do not block real verification',async t=>{
  const root=fixture(t);await prepareTask(root,'T01',opts);
  writeFileSync(join(root,'app.txt'),'good');
  writeFileSync(join(root,'extra.txt'),'additional change');
  const path=join(root,'.gantry/specs/change/TASKS.md');
  writeFileSync(path,content(root).replace('<write_files>app.txt</write_files>','<write_files>app.txt, planned.txt</write_files>'));
  const result=await verifyAndComplete(root,'T01',opts);
  assert.equal(result.kind,'completed',result.reason);
  assert.ok(result.scope.outOfScope.includes('extra.txt'));
  assert.ok(result.receipt.changedFiles.includes('extra.txt'));
  assert.ok(result.receipt.outOfScope.includes('extra.txt'));
  assert.equal(getTaskReceiptStatus(root,'T01',opts).valid,true);
});

test('missing write guidance does not prevent verification',async t=>{
  const root=fixture(t);const path=join(root,'.gantry/specs/change/TASKS.md');
  writeFileSync(path,content(root).replace('<write_files>app.txt</write_files>',''));
  assert.equal((await prepareTask(root,'T01',opts)).kind,'prepared');
  writeFileSync(join(root,'app.txt'),'good');
  const result=await verifyAndComplete(root,'T01',opts);
  assert.equal(result.kind,'completed',result.reason);
  assert.ok(result.scope.outOfScope.includes('app.txt'));
});

test('weakening diagnostics name files and reasons in the loop-visible message',async t=>{
  const root=fixture(t);await prepareTask(root,'T01',opts);
  writeFileSync(join(root,'app.txt'),'good');
  rmSync(join(root,'behavior.test.mjs'));
  const result=await verifyAndComplete(root,'T01',opts);
  assert.equal(result.kind,'blocked');
  assert.match(result.reason,/acceptance-weakened;.*behavior\.test\.mjs: test-file-deleted/);
  assert.ok(result.weakening.files.includes('behavior.test.mjs'));
});


test('package change after reservation runs real verification and preserves the attempt',async t=>{
  const root=fixture(t);await prepareTask(root,'T01',opts);
  const before=readTaskRecord(root,'change','T01');
  writeFileSync(join(root,'package.json'),JSON.stringify({type:'module',scripts:{test:'node --test behavior.test.mjs'}}));
  const failed=await verifyAndComplete(root,'T01',opts);
  assert.equal(failed.kind,'failed',failed.reason);
  assert.equal(failed.reason,'tests-failed');
  writeFileSync(join(root,'app.txt'),'good');
  const completed=await verifyAndComplete(root,'T01',opts);
  assert.equal(completed.kind,'completed',completed.reason);
  assert.equal(completed.record.attempt.id,before.attempt.id);
  assert.equal(completed.record.repairsUsed,before.repairsUsed);
  assert.equal(completed.receipt.runs[0].inspection.counts.tests,1);
});


test('read_files revisions and partial skipped tests complete with actual passing evidence',async t=>{
  const root=fixture(t);await prepareTask(root,'T01',opts);
  const path=join(root,'.gantry/specs/change/TASKS.md');
  writeFileSync(path,content(root).replace('<read_files>app.txt</read_files>','<read_files>app.txt, helpers/*</read_files>'));
  writeFileSync(join(root,'app.txt'),'good');
  const testPath=join(root,'behavior.test.mjs');
  writeFileSync(testPath,readFileSync(testPath,'utf8')+"test.skip('optional platform',()=>{}); test.todo('future');\n");
  const result=await verifyAndComplete(root,'T01',opts);
  assert.equal(result.kind,'completed',result.reason);
  assert.equal(result.receipt.runs[0].inspection.counts.pass,1);
  assert.equal(result.receipt.runs[0].inspection.counts.skipped,1);
  assert.equal(result.receipt.runs[0].inspection.counts.todo,1);
});


test('agent restores deleted test from gate diagnostics before actual verification', async t => {
  const root=fixture(t); const testPath=join(root,'behavior.test.mjs');
  const original=readFileSync(testPath,'utf8'); let calls=0;
  const result=await convergeTask(root,'T01',{...opts,execute:async({record})=>{
    if(++calls===1){rmSync(testPath);writeFileSync(join(root,'app.txt'),'good');}
    else {assert.match(record.failure.reason,/acceptance-weakened.*behavior.test.mjs/);writeFileSync(testPath,original);}
    return {exitCode:0};
  }});
  assert.equal(result.kind,'completed',result.reason); assert.equal(calls,2);
  assert.equal(result.record.repairsUsed,1);assert.equal(result.receipt.runs[0].inspection.counts.pass,1);
});

test('preflight failure diagnostics let agent repair environment in initial candidate',async t=>{
  const root=fixture(t,{preflight:`node -e "process.exit(require('fs').readFileSync('app.txt','utf8')==='good'?0:1)"`});
  let calls=0;
  const result=await convergeTask(root,'T01',{...opts,execute:async({record})=>{
    calls++;assert.match(record.failure.reason,/preflight/);assert.equal(record.failure.runs[0].exitCode,1);
    writeFileSync(join(root,'app.txt'),'good');return {exitCode:0};
  }});
  assert.equal(result.kind,'completed',result.reason);assert.equal(calls,1);
});

test('latest configurable repair limit can exceed three and shrinking it preserves history',async t=>{
  const root=fixture(t);mkdirSync(join(root,'.gantry/planning'),{recursive:true});
  const path=join(root,'.gantry/planning/config.json');
  writeFileSync(path,JSON.stringify({ralph:{maxRepairs:4}}));let calls=0;
  const options={...opts,execute:async()=>{calls++;return {exitCode:0};}};
  const exhausted=await convergeTask(root,'T01',options);
  assert.equal(exhausted.kind,'exhausted');assert.equal(calls,5);assert.equal(exhausted.record.repairsUsed,4);
  writeFileSync(path,JSON.stringify({ralph:{maxRepairs:0}}));
  const resumed=await convergeTask(root,'T01',options);
  assert.equal(resumed.kind,'exhausted');assert.equal(calls,5);assert.equal(resumed.record.repairsUsed,4);
  writeFileSync(path,JSON.stringify({ralph:{maxRepairs:5}}));
  const repaired=await convergeTask(root,'T01',{...opts,execute:async()=>{calls++;writeFileSync(join(root,'app.txt'),'good');return {exitCode:0};}});
  assert.equal(repaired.kind,'completed',repaired.reason);assert.equal(repaired.record.repairsUsed,5);
});

test('changed acceptance is repaired against saved contract without resetting budget',async t=>{
  const root=fixture(t);const path=join(root,'.gantry/specs/change/TASKS.md');const original=content(root);let calls=0;
  const result=await convergeTask(root,'T01',{...opts,execute:async({record,contract})=>{
    if(++calls===1)writeFileSync(path,original.replace('node --test --test-reporter=tap behavior.test.mjs','true'));
    else {assert.match(record.failure.reason,/task contract changed/);assert.match(contract.verify,/node --test/);writeFileSync(path,original);writeFileSync(join(root,'app.txt'),'good');}
    return {exitCode:0};
  }});
  assert.equal(result.kind,'completed',result.reason);assert.equal(calls,2);assert.equal(result.record.repairsUsed,1);
});

test('stale completed dependency is repaired by its owning agent before downstream selection',async t=>{
  const root=fixture(t);writeFileSync(join(root,'app.txt'),'good');
  await prepareTask(root,'T01',opts);await verifyAndComplete(root,'T01',opts);
  writeFileSync(join(root,'app.txt'),'bad');let calls=0;
  const result=await revalidateCompletedTasks(root,{...opts,execute:async({task,record})=>{
    calls++;assert.equal(task.id,'T01');assert.ok(record.failure.reason);writeFileSync(join(root,'app.txt'),'good');return {exitCode:0};
  }});
  assert.equal(result.kind,'completed',result.reason);assert.equal(calls,1);assert.equal(getTaskReceiptStatus(root,'T01',opts).valid,true);
});
