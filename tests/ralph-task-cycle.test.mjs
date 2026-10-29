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

test('preflight blocks before executor or attempt reservation', async t => {
  const root = fixture(t, { preflight: 'node -e "process.exit(7)"' }); let calls = 0;
  const result = await convergeTask(root, 'T01', { ...opts, execute: async () => { calls++; } });
  assert.equal(result.kind, 'blocked'); assert.match(result.reason, /preflight/); assert.equal(calls, 0);
  assert.equal(readTaskRecord(root, 'change', 'T01'), null);
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

test('zero tests and test weakening block false greens', async t => {
  const root = fixture(t, { verify: `node -e "console.log('# tests 0\\n# pass 0\\n# fail 0')"` });
  await prepareTask(root, 'T01', opts);
  const zero = await verifyAndComplete(root, 'T01', opts); assert.equal(zero.kind, 'failed'); assert.equal(zero.reason, 'zero-tests');
  writeFileSync(join(root, 'other.txt'), 'out of bounds');
  const out = await verifyAndComplete(root, 'T01', opts); assert.equal(out.kind, 'blocked'); assert.equal(out.reason, 'out-of-scope');
});

test('unknown nonzero executor exit blocks rather than spending business repairs', async t => {
  const root = fixture(t); let calls = 0;
  const options = { ...opts, execute: async () => { calls++; return { exitCode: 17 }; } };
  const first = await convergeTask(root, 'T01', options);
  assert.equal(first.kind, 'blocked'); assert.equal(first.reason, 'executor-failure-unclassified');
  const resumed = await convergeTask(root, 'T01', options);
  assert.equal(resumed.kind, 'blocked'); assert.equal(calls, 1); assert.equal(resumed.record.repairsUsed, 0);
});

test('missing verification runner blocks without launching a repair', async t => {
  const root = fixture(t, { verify: 'gantry-missing-runner-for-test-93481' }); let calls = 0;
  const result = await convergeTask(root, 'T01', { ...opts, execute: async () => { calls++; return { exitCode: 0 }; } });
  assert.equal(result.kind, 'blocked'); assert.equal(result.reason, 'command-unavailable');
  assert.equal(calls, 1); assert.equal(result.record.repairsUsed, 0);
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
  for (const config of [{ ralph: null }, { ralph: [] }, { ralph: { runTimeoutMs: 0 } }, { ralph: { maxRepairs: 4 } }, { ralph: { checkpointCommands: 'true' } }]) {
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

// Ignored project source cannot be represented by the content receipt. Refuse
// the task rather than accepting a verification result for invisible inputs.
test('ignored explicit task source blocks before executor or reservation', async t => {
  const root = fixture(t, { verify: 'true' });
  mkdirSync(join(root, 'private'), { recursive: true });
  writeFileSync(join(root, 'private/value.mjs'), 'export default 1;');
  writeFileSync(join(root, '.git/info/exclude'), 'private/\n');
  const path = join(root, '.gantry/specs/change/TASKS.md');
  writeFileSync(path, content(root).replace('<write_files>app.txt</write_files>', '<write_files>private/value.mjs</write_files>'));
  let calls = 0;
  const prepared = await convergeTask(root, 'T01', { ...opts, execute: async () => { calls++; return { exitCode: 0 }; } });
  assert.equal(prepared.kind, 'blocked'); assert.match(prepared.reason, /ignored.*source|unobservable.*source/);
  assert.equal(calls, 0); assert.equal(readTaskRecord(root, 'change', 'T01'), null);
});

test('ignored source selected by recursive task glob is rejected without reading it', async t => {
  const root = fixture(t, { verify: 'true' });
  mkdirSync(join(root, 'src/private'), { recursive: true });
  writeFileSync(join(root, 'src/private/value.mjs'), 'sensitive ignored content');
  writeFileSync(join(root, '.git/info/exclude'), 'src/private/\n');
  const path = join(root, '.gantry/specs/change/TASKS.md');
  writeFileSync(path, content(root).replace('<read_files>app.txt</read_files>', '<read_files>src/**/*.mjs</read_files>'));
  const prepared = await prepareTask(root, 'T01', opts);
  assert.equal(prepared.kind, 'blocked'); assert.match(prepared.reason, /src\/private\/value\.mjs/);
  assert.doesNotMatch(prepared.reason, /sensitive ignored content/);
});

test('existing ignored source makes query, repeated done and static gate fail closed', async t => {
  const root = fixture(t, { verify: 'true' });
  await prepareTask(root, 'T01', opts);
  assert.equal((await verifyAndComplete(root, 'T01', opts)).kind, 'completed');
  // A tracked file remains observable even when an ignore rule matches it.
  execFileSync('git', ['rm', '--cached', 'app.txt'], { cwd: root });
  writeFileSync(join(root, '.git/info/exclude'), 'app.txt\n');
  const status = getTaskReceiptStatus(root, 'T01', opts);
  assert.equal(status.valid, false); assert.match(status.reason, /ignored.*source|unobservable.*source/);
  const done = await verifyAndComplete(root, 'T01', opts);
  assert.equal(done.kind, 'blocked'); assert.match(done.reason, /ignored.*source|unobservable.*source/);
  const { checkGate } = await import('../src/lib/phases.mjs');
  const gate = checkGate('test', join(root, '.gantry/specs/change'), { pipeline: 'full' }, null, root);
  assert.equal(gate.passed, false); assert.equal(gate.hard, true); assert.match(gate.reason, /ignored.*source|unobservable.*source/);
});

test('ignored dependency and framework knowledge reads are not treated as task source', async t => {
  const root = fixture(t, { verify: 'true' });
  for (const directory of ['node_modules/pkg', '.context', '.gantry/specs/other']) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, 'node_modules/pkg/index.js'), 'external dependency');
  writeFileSync(join(root, '.context/NOTES.md'), 'team knowledge');
  writeFileSync(join(root, '.git/info/exclude'), 'node_modules/\n.context/\n.gantry/\n');
  const path = join(root, '.gantry/specs/change/TASKS.md');
  writeFileSync(path, content(root).replace('<read_files>app.txt</read_files>', '<read_files>app.txt, node_modules/**, .context/**, .gantry/specs/other/*</read_files>'));
  assert.equal((await prepareTask(root, 'T01', opts)).kind, 'prepared');
});

test('tracked task source remains observable under ignore rules and recursive globs', async t => {
  const root = fixture(t, { verify: 'true' });
  mkdirSync(join(root, 'src/private'), { recursive: true });
  writeFileSync(join(root, 'src/private/value.mjs'), 'export default 1;');
  execFileSync('git', ['add', 'src'], { cwd: root });
  writeFileSync(join(root, '.git/info/exclude'), 'app.txt\nsrc/\n');
  const path = join(root, '.gantry/specs/change/TASKS.md');
  writeFileSync(path, content(root).replace('<read_files>app.txt</read_files>', '<read_files>app.txt, src/**/*.mjs</read_files>'));
  assert.equal((await prepareTask(root, 'T01', opts)).kind, 'prepared');
});

test('ignored future task source is refused before it exists', async t => {
  const root = fixture(t, { verify: 'true' });
  writeFileSync(join(root, '.git/info/exclude'), 'private/\n');
  const path = join(root, '.gantry/specs/change/TASKS.md');
  writeFileSync(path, content(root).replace('<write_files>app.txt</write_files>', '<write_files>private/**/*.mjs</write_files>'));
  const prepared = await prepareTask(root, 'T01', opts);
  assert.equal(prepared.kind, 'blocked'); assert.match(prepared.reason, /ignored source boundary: private\//);
  assert.equal(readTaskRecord(root, 'change', 'T01'), null);
});

test('ignored source created during verification cannot receive a receipt', async t => {
  const root = fixture(t, { verify: `mkdir -p src/private; echo hidden > src/private/value.mjs` });
  writeFileSync(join(root, '.git/info/exclude'), 'src/private/\n');
  const path = join(root, '.gantry/specs/change/TASKS.md');
  writeFileSync(path, content(root).replace('<read_files>app.txt</read_files>', '<read_files>src/**/*.mjs</read_files>'));
  assert.equal((await prepareTask(root, 'T01', opts)).kind, 'prepared');
  const done = await verifyAndComplete(root, 'T01', opts);
  assert.equal(done.kind, 'blocked'); assert.match(done.reason, /ignored source boundary/);
  assert.equal(readTaskRecord(root, 'change', 'T01').receipt, null);
});
