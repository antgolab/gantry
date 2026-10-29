import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { readState, writeState } from '../src/lib/state.mjs';
import { readTaskRecord } from '../src/lib/task-record.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
function fixture(fn, writeFiles = 'src/value.mjs') {
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
<write_files>${writeFiles}</write_files>
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
function failCommit({ root, json }, mutate = () => {}) {
  assert.equal(json('dispatch').status, 0);
  candidate(root);
  mutate(root);
  assert.equal(json('done', 'T01').status, 0);
  const hook = join(root, '.git/hooks/pre-commit');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  assert.equal(json('advance').status, 2);
  assert.equal(readState(root).currentStage, 'dev');
  rmSync(hook);
}
function committedCheckpoint(ctx, mutate) {
  failCommit(ctx, mutate);
  const marker = join(ctx.root, '.gantry/planning/ralph-checkpoint.json');
  const pending = JSON.parse(readFileSync(marker, 'utf8'));
  // Reproduce a crash after Git succeeds but before Gantry removes its marker.
  ctx.git('commit', '-m', pending.message);
  assert.equal(ctx.git('rev-parse', 'HEAD^{tree}'), pending.tree);
  return { marker, head: ctx.git('rev-parse', 'HEAD') };
}

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
  assert.equal(git('diff', 'HEAD', '--', '.gantry/specs/cli-cycle/EXECUTION.md'), '', 'execution receipt must be fully committed');
  cli('advance');
  assert.equal(Number(git('rev-list', '--count', 'HEAD')), Number(initial) + 1);
}));

test('failed commit with unchanged reservation resumes once and commits current execution evidence', () => fixture(ctx => {
  const { root, git, json } = ctx;
  const count = Number(git('rev-list', '--count', 'HEAD'));
  failCommit(ctx);
  const resumed = json('advance');
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(readState(root).currentStage, 'test');
  assert.equal(Number(git('rev-list', '--count', 'HEAD')), count + 1);
  assert.equal(git('show', 'HEAD:src/value.mjs'), 'export const value = 1;');
  assert.equal(git('diff', 'HEAD', '--', '.gantry/specs/cli-cycle/EXECUTION.md'), '');
  json('advance');
  assert.equal(Number(git('rev-list', '--count', 'HEAD')), count + 1);
}));

test('failed commit cannot omit a newly required in-scope module on resume', () => fixture(ctx => {
  const { root, git, json } = ctx;
  failCommit(ctx);
  const head = git('rev-parse', 'HEAD');
  const index = git('write-tree');
  writeFileSync(join(root, 'src/new.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'src/value.mjs'), "export { value } from './new.mjs';\n");
  const resumed = json('advance');
  assert.equal(resumed.status, 2, resumed.stdout + resumed.stderr);
  assert.match(resumed.data.reason, /清单.*变化/);
  assert.equal(readState(root).currentStage, 'dev');
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('write-tree'), index, 'blocked resume must preserve reserved index');
}, 'src/*.mjs'));

test('failed commit preserves user-staged contents inside the reserved file set', () => fixture(ctx => {
  const { root, git, json } = ctx;
  failCommit(ctx);
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 42;\n');
  git('add', 'src/value.mjs');
  candidate(root);
  const index = git('write-tree');
  const resumed = json('advance');
  assert.equal(resumed.status, 2, resumed.stdout + resumed.stderr);
  assert.match(resumed.data.reason, /索引/);
  assert.equal(git('write-tree'), index);
  assert.equal(git('show', ':src/value.mjs'), 'export const value = 42;');
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(readState(root).currentStage, 'dev');
}));

test('failed commit blocks after user unstages a reserved file', () => fixture(ctx => {
  const { root, git, json } = ctx;
  failCommit(ctx);
  git('reset', 'HEAD', '--', 'src/value.mjs');
  const index = git('write-tree');
  const resumed = json('advance');
  assert.equal(resumed.status, 2, resumed.stdout + resumed.stderr);
  assert.match(resumed.data.reason, /索引/);
  assert.equal(git('write-tree'), index);
  assert.equal(readState(root).currentStage, 'dev');
}));

test('successful commit interrupted before marker cleanup recovers without another commit', () => fixture(ctx => {
  const { root, git, json } = ctx;
  const { marker, head } = committedCheckpoint(ctx);
  const execution = join(root, '.gantry/specs/cli-cycle/EXECUTION.md');
  writeFileSync(execution, readFileSync(execution, 'utf8') + '\n<!-- framework receipt refreshed -->\n');
  const resumed = json('advance');
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(readState(root).currentStage, 'test');
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(existsSync(marker), false);
  assert.match(readFileSync(execution, 'utf8'), /framework receipt refreshed/);
}));

for (const change of ['new required module', 'deleted source', 'same-file edit', 'user-staged content']) {
  test(`successful commit recovery blocks ${change} and preserves index`, () => fixture(ctx => {
    const { root, git, json } = ctx;
    const { marker, head } = committedCheckpoint(ctx, root => {
      if (change === 'deleted source') writeFileSync(join(root, 'src/extra.mjs'), 'export const extra = 1;\n');
    });
    if (change === 'new required module') {
      writeFileSync(join(root, 'src/new.mjs'), 'export const value = 1;\n');
      writeFileSync(join(root, 'src/value.mjs'), "export { value } from './new.mjs';\n");
    } else if (change === 'deleted source') {
      rmSync(join(root, 'src/extra.mjs'));
    } else if (change === 'same-file edit') {
      writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1; // new candidate\n');
    } else {
      writeFileSync(join(root, 'src/value.mjs'), 'export const value = 42;\n');
      git('add', 'src/value.mjs');
      candidate(root);
    }
    const index = git('write-tree');
    const resumed = json('advance');
    assert.equal(resumed.status, 2, resumed.stdout + resumed.stderr);
    assert.match(resumed.data.reason, /源码|清单|索引/);
    assert.equal(readState(root).currentStage, 'dev');
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.equal(git('write-tree'), index);
    assert.equal(existsSync(marker), true);
    if (change === 'user-staged content') assert.equal(git('show', ':src/value.mjs'), 'export const value = 42;');
  }, 'src/*.mjs'));
}

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
