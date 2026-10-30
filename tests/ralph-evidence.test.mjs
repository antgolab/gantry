import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkGate } from '../src/lib/phases.mjs';
import { prepareTask, verifyAndComplete } from '../src/lib/task-cycle.mjs';
import { createContract, captureManifest, computeContentDigest, checkTaskScope, detectTaskWeakening, inspectVerificationOutput, receiptMatches, receiptIsValid } from '../src/lib/task-evidence.mjs';

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'ralph-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const put = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  put('src/a.js', 'original'); put('tests/a.test.js', "test('a', () => { assert.equal(1, 1); });");
  put('.gitignore', '.gantry/\nignored.js\nnode_modules/\n');
  git('add', '.'); git('commit', '-qm', 'base');
  return { root, git, put };
}

test('contract fixes acceptance and ignores mutable status', () => {
  const task = { verify: 'node --test', readFiles: ['src/*'], writeFiles: ['src/a.js'], done: 'works' };
  const a = createContract(task, { checks: ['lint'], deadlineSnapshot: { verifyMs: 100 } });
  assert.equal(a.digest, createContract({ ...task, status: 'done' }, { checks: ['lint'], deadlineSnapshot: { verifyMs: 100 } }).digest);
  for (const patch of [{ verify: 'true' }, { done: 'other' }]) assert.notEqual(a.digest, createContract({ ...task, ...patch }).digest);
});

test('manifest observes clean, dirty, index, untracked, deletion and modes', t => {
  const { root, git, put } = repo(t);
  put('src/a.js', 'user dirty'); const baseline = captureManifest(root);
  assert(baseline.entries.some(e => e.path === 'tests/a.test.js'));
  assert.deepEqual(checkTaskScope(baseline, captureManifest(root), ['tests/*']).changedFiles, []);
  put('src/a.js', 'task change'); put('new.js', 'new'); git('add', 'new.js');
  rmSync(join(root, 'tests/a.test.js')); chmodSync(join(root, 'src/a.js'), 0o755);
  const current = captureManifest(root);
  assert.notEqual(computeContentDigest(baseline), computeContentDigest(current));
  const scope = checkTaskScope(baseline, current, ['src/**']);
  assert.deepEqual(scope.outOfScope, ['new.js', 'tests/a.test.js']);
  git('add', 'src/a.js'); const staged = captureManifest(root);
  assert.notEqual(computeContentDigest(current), computeContentDigest(staged));
});

test('runtime artifacts excluded but ignored acceptance paths can be included', t => {
  const { root, put } = repo(t); const a = captureManifest(root);
  put('.gantry/planning/state.json', '{}'); put('.gantry/specs/x/EXECUTION.md', 'log');
  put('.gantry/specs/x/execution/T01.json', '{"receipt":1}');
  assert.equal(a.manifestDigest, captureManifest(root).manifestDigest);
  put('.gantry/config.json', '{"checks":1}');
  const b = captureManifest(root, { includePaths: ['.gantry/config.json'] });
  put('.gantry/config.json', '{"checks":2}');
  assert.notEqual(b.manifestDigest, captureManifest(root, { includePaths: ['.gantry/config.json'] }).manifestDigest);
  put('ignored.js', 'source');
  assert.throws(() => captureManifest(root, { includePaths: ['ignored.js'] }), /ignored/i);
});

test('removing a tracked parent directory is represented as deletion', t => {
  const { root } = repo(t); const before = captureManifest(root);
  rmSync(join(root, 'src'), { recursive: true });
  const after = captureManifest(root);
  assert.deepEqual(checkTaskScope(before, after, ['src/**']).changedFiles, ['src/a.js']);
  assert.equal(after.entries.find(e => e.path === 'src/a.js').worktreeHash, null);
});

test('staged test deletion cannot be hidden by restoring the worktree', t => {
  const { root, git, put } = repo(t); const before = captureManifest(root);
  rmSync(join(root, 'tests/a.test.js')); git('add', 'tests/a.test.js');
  put('tests/a.test.js', "test('a', () => { assert.equal(1, 1); });");
  const result = detectTaskWeakening(before, captureManifest(root));
  assert.equal(result.hit, true);
  assert(result.reasons.some(r => r.source === 'indexContent'));
});

test('normal new tests and added todo do not imply weakening', t => {
  const { root, put } = repo(t); const before = captureManifest(root);
  put('tests/new.test.js', "test('new', () => { assert.ok(true); });");
  assert.equal(detectTaskWeakening(before, captureManifest(root)).hit, false);
  put('tests/new.test.js', "test.todo('new');");
  assert.equal(detectTaskWeakening(before, captureManifest(root)).hit, false);
});

test('non-executable permission changes invalidate evidence', t => {
  const { root } = repo(t); const before = captureManifest(root);
  chmodSync(join(root, 'src/a.js'), 0o600);
  assert.notEqual(before.manifestDigest, captureManifest(root).manifestDigest);
});

test('external symlinks fail closed', t => {
  const { root } = repo(t); symlinkSync(tmpdir(), join(root, 'outside'));
  assert.throws(() => captureManifest(root), /symlink/i);
});

test('submodule index entries fail closed instead of omitting source', t => {
  const { root, git } = repo(t);
  git('update-index', '--add', '--cacheinfo', '160000', git('rev-parse', 'HEAD').trim(), 'module');
  assert.throws(() => captureManifest(root), /submodule/i);
});

test('scope supports recursive glob and never exempts gantry acceptance config', () => {
  const a = { entries: [] }; const b = { entries: [{ path: 'dist/sub/a.js', worktreeHash: 'x' }, { path: '.gantry/config.json', worktreeHash: 'y' }] };
  assert.deepEqual(checkTaskScope(a, b, ['dist/**']).outOfScope, ['.gantry/config.json']);
  assert.equal(checkTaskScope(a, b, ['../**']).ok, false);
});

test('weakening detects deleted test files without treating package edits as weakening', t => {
  const { root, put } = repo(t); const a = captureManifest(root);
  rmSync(join(root, 'tests/a.test.js')); put('package.json', '{"scripts":{"test":"true"}}');
  const result = detectTaskWeakening(a, captureManifest(root));
  assert.equal(result.hit, true); assert.equal(result.reviewRequired, true);
  assert(result.files.includes('tests/a.test.js')); assert(!result.files.includes('package.json'));
});

test('TAP verification rejects empty, failing and wholly skipped suites; partial skips remain counts', () => {
  const tap = (tests, pass, fail = 0, skipped = 0, todo = 0) => `TAP version 13\n# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# skipped ${skipped}\n# todo ${todo}\n`;
  assert.equal(inspectVerificationOutput(tap(2, 2)).ok, true);
  assert.equal(inspectVerificationOutput(tap(2, 1, 0, 1)).ok, true);
  assert.equal(inspectVerificationOutput(tap(2, 1, 0, 0, 1)).ok, true);
  for (const output of [tap(0, 0), tap(2, 1, 1), tap(2, 0, 0, 2), tap(2, 0, 0, 0, 2)]) assert.equal(inspectVerificationOutput(output).ok, false);
  assert.equal(inspectVerificationOutput('other runner passed').counts, null);
  assert.equal(inspectVerificationOutput('docs generated', { kind: 'command' }).ok, true);
});

test('receipt matches contract and actual content independent of HEAD', t => {
  const { root, put } = repo(t); const contract = createContract({ verify: 'test' }); const manifest = captureManifest(root);
  const receipt = { contractDigest: contract.digest, contentDigest: computeContentDigest(manifest) };
  assert.equal(receiptMatches(receipt, contract, manifest), true);
  put('src/a.js', 'changed without commit');
  assert.equal(receiptMatches(receipt, contract, captureManifest(root)), false);
  assert.equal(receiptMatches(receipt, createContract({ verify: 'true' }), manifest), false);
});

test('TASKS completion status is metadata while acceptance text remains protected', t => {
  const { root, git, put } = repo(t);
  const path = '.gantry/specs/demo/TASKS.md';
  put(path, '<task id="T01" status="pending"><verify>test</verify></task>');
  git('add', '-f', path);
  const options = { includePaths: [path, '.gantry/planning/config.json'] };
  const baseline = captureManifest(root, options);
  put(path, '<task id="T01" status="done"><verify>test</verify></task>'); git('add', '-f', path);
  assert.equal(captureManifest(root, options).manifestDigest, baseline.manifestDigest);
  put(path, '<task id="T01" status="done"><verify>true</verify></task>');
  assert.notEqual(captureManifest(root, options).manifestDigest, baseline.manifestDigest);
  put('.gantry/planning/config.json', '{"ralph":{"verifyTimeoutMs":100}}');
  const configured = captureManifest(root, options);
  put('.gantry/planning/config.json', '{"ralph":{"verifyTimeoutMs":200}}');
  assert.notEqual(captureManifest(root, options).manifestDigest, configured.manifestDigest);
});


test('receipt rejects successful-looking commands with unsafe process outcomes', t => {
  const { root } = repo(t);
  const manifest = captureManifest(root);
  const contract = createContract({ verify: 'node --test' });
  const receipt = { schemaVersion: 1, pass: true, contractDigest: contract.digest, contentDigest: manifest.manifestDigest,
    runs: [{ exitCode: 0, inspection: { ok: true }, cleanupComplete: true }] };
  assert.equal(receiptIsValid(receipt, contract, manifest), true);
  for (const outcome of [{ cleanupComplete: false }, { timedOut: true }, { cancelled: true }, { spawnError: 'missing' }, { exitCode: 1 }]) {
    assert.equal(receiptIsValid({ ...receipt, runs: [{ ...receipt.runs[0], ...outcome }] }, contract, manifest), false);
  }
});

test('static TEST gate requires current real receipt and never executes verify', async t => {
  const { root, put } = repo(t);
  const specs = join(root, '.gantry/specs/gate');
  put('.gantry/logs/verify-count', '');
  put('.gantry/specs/gate/TASKS.md', '<task id="T01" status="pending"><write_files>src/a.js</write_files><verify>node -e "require(\'fs\').appendFileSync(\'.gantry/logs/verify-count\', \'x\')"</verify><done>unchanged candidate is valid</done></task>');
  put('.gantry/planning/STATE.md', '# STATE\n\n- **活跃 Change**: `gate`\n- **当前阶段**: `dev`\n- **模式**: `full`\n');
  assert.equal((await prepareTask(root, 'T01')).kind, 'prepared');
  assert.equal((await verifyAndComplete(root, 'T01')).kind, 'completed');
  assert.equal(checkGate('test', specs, {}, null, root).passed, true);
  assert.equal(readFileSync(join(root, '.gantry/logs/verify-count'), 'utf8'), 'x');
  put('src/a.js', 'subsequent change with same HEAD');
  const stale = checkGate('test', specs, {}, null, root);
  assert.equal(stale.passed, false);
  assert.match(stale.reason, /凭据.*过期/);
  assert.equal((await verifyAndComplete(root, 'T01')).kind, 'completed');
  assert.equal(checkGate('test', specs, {}, null, root).passed, true);
  put('.gantry/planning/config.json', '{"ralph":null}');
  const invalidConfig = checkGate('test', specs, {}, null, root);
  assert.equal(invalidConfig.passed, false);
  assert.match(invalidConfig.reason, /invalid ralph config/);
  rmSync(join(root, '.gantry/planning/config.json'));
  rmSync(join(specs, 'execution/T01.json'));
  assert.equal(checkGate('test', specs, {}, null, root).passed, false);
});


test('explicit coverage map is acceptance input while loop logs remain excluded', t => {
  const { root, put } = repo(t);
  const options = { includePaths: ['.gantry/loop/test-commands.yml'] };
  put('.gantry/loop/test-commands.yml', 'unit:\n  cmd: node --test\n  covers: [AC-1]\n');
  const first = captureManifest(root, options);
  put('.gantry/loop/last-dispatch.log', 'runtime output');
  assert.equal(captureManifest(root, options).manifestDigest, first.manifestDigest);
  put('.gantry/loop/test-commands.yml', 'unit:\n  cmd: true\n  covers: [AC-1]\n');
  const next = captureManifest(root, options);
  assert.notEqual(next.manifestDigest, first.manifestDigest);
  assert.equal(detectTaskWeakening(first, next).hit, false);
});

test('runtime deadlines and planned write scope do not change acceptance but verify does',()=>{
  const task={verify:'node --test',writeFiles:['src/a.js'],done:'works'};
  const first=createContract(task,{deadlineSnapshot:{verifyTimeoutMs:1}});
  assert.equal(first.digest,createContract(task,{deadlineSnapshot:{verifyTimeoutMs:9999}}).digest);
  assert.notEqual(first.digest,createContract({...task,verify:'true'}).digest);
  assert.equal(first.digest,createContract({...task,writeFiles:['**']}).digest);
});

test('project config formatting is stable; substantive settings invalidate evidence without scope violation',t=>{
  const {root,git,put}=repo(t); const path='.gantry/planning/config.json';
  put(path,'{"ralph":{"verifyTimeoutMs":1000},"autonomous":{"maxStagesPerRun":5}}');
  git('add','-f',path);
  const options={includePaths:[path]};const first=captureManifest(root,options);
  put(path,'{\n "autonomous": {"maxStagesPerRun": 5}, "ralph": {"verifyTimeoutMs": 1000}\n}');
  git('add','-f',path);
  assert.equal(first.manifestDigest,captureManifest(root,options).manifestDigest);
  put(path,'{"ralph":{"verifyTimeoutMs":2000}}');
  const changed=captureManifest(root,options);
  assert.notEqual(first.manifestDigest,changed.manifestDigest);
  assert.equal(checkTaskScope(first,changed,['src/a.js']).ok,true);
  assert.equal(detectTaskWeakening(first,changed).hit,false);
});


test('package and runner config edits invalidate evidence without declaring weakening',t=>{
  const {root,put,git}=repo(t);
  for(const path of ['package.json','vitest.config.mjs','playwright.config.mjs','eslint.config.mjs'])put(path,'{}');
  git('add','.');const before=captureManifest(root);
  for(const path of ['package.json','vitest.config.mjs','playwright.config.mjs','eslint.config.mjs'])put(path,'{"updated":true}');
  const after=captureManifest(root);
  assert.notEqual(before.manifestDigest,after.manifestDigest);
  assert.equal(detectTaskWeakening(before,after).hit,false);
});


test('reference list changes keep acceptance stable and test refactors are not judged by token counts',t=>{
  const task={verify:'node --test',readFiles:['src/a.js'],writeFiles:['src/a.js'],done:'works'};
  assert.equal(createContract(task).digest,createContract({...task,readFiles:['src/**']}).digest);
  const {root,put}=repo(t);const before=captureManifest(root);
  put('tests/a.test.js',"test('combined',()=>{}); test.todo('later');");
  assert.equal(detectTaskWeakening(before,captureManifest(root)).hit,false);
});
