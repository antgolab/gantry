import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { readState, writeState } from '../src/lib/state.mjs';
import { readTaskRecord } from '../src/lib/task-record.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-ralph-cli-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
  const json = (...args) => { const run = cli(...args, '--json'); return { ...run, data: JSON.parse(run.stdout) }; };
  try {
    git('init', '-b', 'test-ralph'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Ralph test');
    assert.equal(cli('install', '--tool', 'codex').status, 0);
    assert.equal(cli('change', '--id', 'cli-cycle', '真实候选验证').status, 0);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/value.mjs'), 'export const value = 0;\n');
    writeFileSync(join(root, 'verify.mjs'), "import { value } from './src/value.mjs'; import assert from 'node:assert/strict'; assert.equal(value, 1); console.log('verified candidate');\n");
    writeFileSync(join(root, 'user.txt'), 'original user content\n');
    writeFileSync(join(root, '.gantry/specs/cli-cycle/TASKS.md'), `# TASKS
<task id="T01" status="pending">
<name>产生正确值</name>
<read_files>src/value.mjs, verify.mjs</read_files>
<write_files>src/value.mjs</write_files>
<verify>node verify.mjs</verify>
<done>value is one</done>
<depends_on></depends_on>
</task>\n`);
    writeState(root, { ...readState(root), currentStage: 'dev', activeAgent: 'executor' });
    git('add', '.'); git('commit', '-m', 'fixture baseline');
    return fn({ root, git, cli, json });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function taskText(root) { return readFileSync(join(root, '.gantry/specs/cli-cycle/TASKS.md'), 'utf8'); }
function candidate(root) { writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1;\n'); }

test('done without entry baseline blocks even when candidate already passes', () => fixture(({ root, json }) => {
  candidate(root);
  const done = json('done', 'T01');
  assert.equal(done.status, 2);
  assert.equal(done.data.kind, 'blocked');
  assert.match(done.data.reason, /baseline|reservation/);
  assert.match(taskText(root), /status="pending"/);
  assert.equal(readTaskRecord(root, 'cli-cycle', 'T01'), null);
}));

test('real failing verify keeps pending, repaired candidate gets durable matching evidence', () => fixture(({ root, json }) => {
  assert.equal(json('dispatch').data.status, 'dispatched');
  const failed = json('done', 'T01');
  assert.equal(failed.status, 1);
  assert.equal(failed.data.kind, 'failed');
  assert.match(taskText(root), /status="pending"/);
  assert.equal(readTaskRecord(root, 'cli-cycle', 'T01').receipt, null);
  const repair = json('dispatch');
  assert.equal(repair.data.repairOrdinal, 1);
  candidate(root);
  const success = json('done', 'T01');
  assert.equal(success.status, 0, success.stdout + success.stderr);
  assert.equal(success.data.kind, 'completed');
  assert.equal(success.data.receipt.runs[0].exitCode, 0);
  assert.match(success.data.receipt.runs[0].stdout, /verified candidate/);
  assert.match(taskText(root), /status="done"/);
  const record = readTaskRecord(root, 'cli-cycle', 'T01');
  assert.equal(record.repairsUsed, 1);
  assert.equal(record.receipt.contractDigest, record.contract.digest);
  const again = json('done', 'T01');
  assert.equal(again.status, 0);
  const execution = readFileSync(join(root, '.gantry/specs/cli-cycle/EXECUTION.md'), 'utf8');
  assert.equal((execution.match(/<!-- ralph-task:T01:begin -->/g) || []).length, 1);
}));

test('DEV checkpoint creates one task commit, preserves unrelated user edit and cannot duplicate it', () => fixture(({ root, git, cli, json }) => {
  writeFileSync(join(root, 'user.txt'), 'existing user edit\n');
  const initial = git('rev-list', '--count', 'HEAD');
  assert.equal(json('dispatch').status, 0);
  candidate(root);
  assert.equal(json('done', 'T01').status, 0);
  const advance = json('advance');
  assert.equal(advance.status, 0, advance.stdout + advance.stderr);
  assert.equal(readState(root).currentStage, 'test');
  assert.equal(Number(git('rev-list', '--count', 'HEAD')), Number(initial) + 1);
  const committed = git('show', '--format=', '--name-only', 'HEAD').split('\n');
  assert.ok(committed.includes('src/value.mjs'));
  assert.ok(committed.includes('.gantry/specs/cli-cycle/EXECUTION.md'), 'DEV commit must contain the human execution evidence');
  assert.ok(!committed.includes('user.txt'));
  assert.ok(!committed.some(path => /execution\/|ralph.lock|ralph-checkpoint/.test(path)));
  assert.equal(readFileSync(join(root, 'user.txt'), 'utf8'), 'existing user edit\n');
  assert.match(git('diff', '--name-only'), /user.txt/);
  assert.equal(git('diff', '--cached', '--name-only'), '');
  cli('advance');
  assert.equal(Number(git('rev-list', '--count', 'HEAD')), Number(initial) + 1);
}));

test('pre-staged user edits block automatic DEV commit while preserving the index', () => fixture(({ root, git, json }) => {
  writeFileSync(join(root, 'user.txt'), 'user staged edit\n'); git('add', 'user.txt');
  const head = git('rev-parse', 'HEAD');
  assert.equal(json('dispatch').status, 0);
  candidate(root);
  assert.equal(json('done', 'T01').status, 0);
  const advance = json('advance');
  assert.equal(advance.status, 2, advance.stdout + advance.stderr);
  assert.match(advance.data.reason, /预先暂存|索引/);
  assert.equal(readState(root).currentStage, 'dev');
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('diff', '--cached', '--name-only'), 'user.txt');
}));
