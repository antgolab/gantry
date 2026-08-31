import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
let tmpDir;

function run(...args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: tmpDir,
    encoding: 'utf-8',
    timeout: 15000,
  });
}

function readState() {
  return readFileSync(join(tmpDir, '.gantry/planning/STATE.md'), 'utf-8');
}

function enterDev(changeId = 'auto-tasks') {
  run('install', '--tool', 'codex');
  run('change', '--id', changeId, '连续调度多个任务');

  const statePath = join(tmpDir, '.gantry/planning/STATE.md');
  const state = readFileSync(statePath, 'utf-8')
    .replace('- **当前阶段**: `change`', '- **当前阶段**: `dev`')
    .replace('- **活跃 Agent**: `planner`', '- **活跃 Agent**: `executor`');
  writeFileSync(statePath, state, 'utf-8');

  const tasksPath = join(tmpDir, '.gantry/specs', changeId, 'TASKS.md');
  writeFileSync(tasksPath, `# TASKS

<task id="T01" status="pending" parallel="true">
  <name>first</name>
  <write_files>src/first.mjs</write_files>
  <depends_on></depends_on>
</task>

<task id="T02" status="pending" parallel="true">
  <name>second</name>
  <write_files>src/second.mjs</write_files>
  <depends_on></depends_on>
</task>

<task id="T03" status="pending" parallel="false">
  <name>third</name>
  <write_files>src/third.mjs</write_files>
  <depends_on>T01,T02</depends_on>
</task>
`, 'utf-8');
}

beforeEach(() => {
  tmpDir = join(import.meta.dirname, `.tmp-auto-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('gantry dispatch', () => {
  it('按 canonical wave 调度，并在部分完成后保留同一 wave', () => {
    enterDev();

    const first = JSON.parse(run('dispatch', '--json'));
    assert.deepEqual(first, { status: 'dispatched', waveId: 1, taskIds: ['T01', 'T02'] });
    assert.match(readState(), /当前 Wave\*\*: `1`/);
    assert.match(readState(), /当前 Task\*\*: `T01`/);
    assert.match(readState(), /重试计数\*\*: `0 \/ 3`/);
    assert.equal(
      JSON.parse(readFileSync(join(tmpDir, '.gantry/planning/context-pack.json'), 'utf-8')).taskId,
      'T01',
    );

    run('done', 'T01');
    assert.match(readFileSync(join(tmpDir, '.gantry/planning/STATE.md'), 'utf-8'), /当前 Task\*\*: `—`/);
    assert.match(readFileSync(join(tmpDir, '.gantry/planning/STATE.md'), 'utf-8'), /当前 Wave\*\*: `1`/);

    const remainder = JSON.parse(run('dispatch', '--json'));
    assert.deepEqual(remainder, { status: 'dispatched', waveId: 1, taskIds: ['T02'] });
    assert.match(readState(), /重试计数\*\*: `1 \/ 3`/);

    run('done', 'T02');
    const secondWave = JSON.parse(run('dispatch', '--json'));
    assert.deepEqual(secondWave, { status: 'dispatched', waveId: 2, taskIds: ['T03'] });
    assert.match(readState(), /重试计数\*\*: `0 \/ 3`/);
    run('done', 'T03');
    assert.deepEqual(JSON.parse(run('dispatch', '--json')), { status: 'all_done' });
    assert.match(readState(), /重试计数\*\*: `0 \/ 3`/);
  });

  it('同一 wave 超过 maxRetries 后降级为主 Agent 接管', () => {
    enterDev();

    assert.equal(JSON.parse(run('dispatch', '--json')).status, 'dispatched');
    for (let retry = 1; retry <= 3; retry++) {
      assert.equal(JSON.parse(run('dispatch', '--json')).status, 'dispatched');
      assert.match(readState(), new RegExp(`重试计数\\*\\*: \`${retry} \/ 3\``));
    }

    const exhausted = JSON.parse(run('dispatch', '--json'));
    assert.deepEqual(exhausted, {
      status: 'fallback_main',
      waveId: 1,
      taskIds: ['T01', 'T02'],
      retries: 3,
      maxRetries: 3,
    });
    assert.match(readState(), /当前 Wave\*\*: `1`/);
    assert.match(readState(), /当前 Task\*\*: `T01`/);
    assert.match(readState(), /重试计数\*\*: `3 \/ 3`/);
    assert.match(readState(), /暂停原因\*\*: `—`/);
    assert.equal(
      JSON.parse(readFileSync(join(tmpDir, '.gantry/planning/context-pack.json'), 'utf-8')).taskId,
      'T01',
    );
  });

  it('只允许在 DEV 阶段调度', () => {
    run('install', '--tool', 'codex');
    assert.throws(() => run('dispatch', '--json'), /dispatch 只允许在 dev 阶段运行/);
  });
});

describe('Codex auto skill', () => {
  it('生成每 wave 一个新子 Agent 的编排协议', () => {
    run('install', '--tool', 'codex');
    const skill = readFileSync(join(tmpDir, '.agents/skills/gantry-auto/SKILL.md'), 'utf-8');

    assert.match(skill, /gantry dispatch --json/);
    assert.match(skill, /spawn_agent/);
    assert.match(skill, /wait_agent/);
    assert.match(skill, /每个 wave.*一个.*子 Agent/);
    assert.match(skill, /wave 内.*逐.*task/);
    assert.match(skill, /子 Agent 禁止执行 `gantry advance`/);
    assert.match(skill, /fallback_main/);
    assert.match(skill, /禁止调用 `spawn_agent` 或 `followup_task`/);
    assert.match(skill, /主 Agent.*逐.*task/);
    assert.doesNotMatch(skill, /fresh worker/);
  });
});

describe('Claude Code auto skill', () => {
  it('生成每 wave 一个新子 Agent 的编排协议', () => {
    run('install', '--tool', 'claude');
    const skill = readFileSync(join(tmpDir, '.claude/skills/gantry-auto/SKILL.md'), 'utf-8');

    assert.match(skill, /gantry dispatch --json/);
    assert.match(skill, /`Agent` 工具/);
    assert.match(skill, /subagent_type.*general-purpose/);
    assert.match(skill, /同步等待/);
    assert.match(skill, /每个 wave.*一个.*子 Agent/);
    assert.match(skill, /子 Agent 禁止执行 `gantry advance`/);
    assert.match(skill, /fallback_main/);
    assert.match(skill, /禁止调用 `Agent` 工具或通过 resume/);
    assert.match(skill, /主 Agent.*逐.*task/);
    assert.doesNotMatch(skill, /fresh worker/);
  });
});
