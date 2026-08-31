import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGate } from '../src/lib/phases.mjs';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli.mjs');
const REFLECTION_FIELDS = [
  'problem',
  'cause',
  'next',
];
const RETIRED_FIELDS = ['deviation', 'friction', 'reusable', 'improvement', 'promotion'];

const read = path => readFileSync(join(ROOT, path), 'utf-8');
let tmpDir;

function run(...args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: tmpDir,
    encoding: 'utf-8',
  });
}

beforeEach(() => {
  tmpDir = join(import.meta.dirname, `.tmp-reflection-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  run('install', '--tool', 'codex');
  run('change', '--id', 'reflection-fixture', 'reflection fixture');
  writeFileSync(join(tmpDir, '.gantry/specs/reflection-fixture/TASKS.md'), `
<task id="T01" status="pending"><verify>node --test</verify><done>done</done></task>
<task id="T02" status="pending"><verify>node --test</verify><done>done</done></task>
`, 'utf-8');
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('task execution reflection contract', () => {
  it('EXECUTION template exposes concise reflection fields and permits none', () => {
    const template = read('templates/EXECUTION.md');
    for (const field of REFLECTION_FIELDS) {
      assert.match(template, new RegExp(`- ${field}:`), `missing ${field}`);
    }
    assert.match(template, /none/);
    assert.match(template, /不得凑数/);
    for (const field of RETIRED_FIELDS) {
      assert.doesNotMatch(template, new RegExp(`- ${field}:`), `retired ${field}`);
    }
  });

  it('DEV and Executor require reflection before task completion', () => {
    const dev = read('phases/4-dev.md');
    const executor = read('src/agents/executor.md');

    assert.match(dev, /微复盘/);
    assert.match(dev, /problem.*cause.*next/s);
    assert.match(executor, /微复盘/);
    assert.match(executor, /problem.*cause.*next/s);
  });

  it('gantry done creates and appends entries with the same reflection fields', () => {
    run('done', 'T01');
    run('done', 'T02');

    const execution = readFileSync(
      join(tmpDir, '.gantry/specs/reflection-fixture/EXECUTION.md'),
      'utf-8',
    );
    for (const taskId of ['T01', 'T02']) {
      const start = execution.indexOf(`### ${taskId}`);
      assert.notEqual(start, -1, `missing ${taskId}`);
      const next = execution.indexOf('\n### ', start + 1);
      const entry = execution.slice(start, next === -1 ? undefined : next);
      for (const field of REFLECTION_FIELDS) {
        assert.match(entry, new RegExp(`- ${field}:`), `${taskId} missing ${field}`);
      }
    }
  });

  it('TEST gate rejects unfinished execution TODOs and accepts completed records', () => {
    run('done', 'T01');
    run('done', 'T02');

    const specsDir = join(tmpDir, '.gantry/specs/reflection-fixture');
    const blocked = checkGate('test', specsDir, { pipeline: 'full' });
    assert.equal(blocked.passed, false);
    assert.match(blocked.reason, /EXECUTION\.md.*TODO/);

    const executionPath = join(specsDir, 'EXECUTION.md');
    const completed = readFileSync(executionPath, 'utf-8').replaceAll('TODO', 'none');
    writeFileSync(executionPath, completed, 'utf-8');
    assert.equal(checkGate('test', specsDir, { pipeline: 'full' }).passed, true);
  });
});
