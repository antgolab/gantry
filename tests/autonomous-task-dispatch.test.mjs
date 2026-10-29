import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
  execFileSync('git', ['init', '-b', 'test-ralph'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Ralph test'], { cwd: tmpDir });
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
  <verify>node --version</verify>
  <depends_on></depends_on>
</task>

<task id="T02" status="pending" parallel="true">
  <name>second</name>
  <write_files>src/second.mjs</write_files>
  <verify>node --version</verify>
  <depends_on></depends_on>
</task>

<task id="T03" status="pending" parallel="false">
  <name>third</name>
  <write_files>src/third.mjs</write_files>
  <verify>node --version</verify>
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
  it('每次只预约一个ready任务，完成后再调度下一项及依赖任务', () => {
    enterDev();
    const first = JSON.parse(run('dispatch', '--json'));
    assert.equal(first.status, 'dispatched');
    assert.deepEqual(first.taskIds, ['T01']);
    assert.equal(first.repairOrdinal, 0);
    assert.ok(first.attemptId);
    const record = JSON.parse(readFileSync(join(tmpDir, '.gantry/specs/auto-tasks/execution/T01.json'), 'utf8'));
    assert.equal(record.attempt.id, first.attemptId);
    assert.equal(record.repairsUsed, 0);
    assert.equal(JSON.parse(readFileSync(join(tmpDir, '.gantry/planning/context-pack.json'), 'utf8')).taskId, 'T01');
    assert.match(readState(), /当前 Task\*\*: `T01`/);
    run('done', 'T01');
    const second = JSON.parse(run('dispatch', '--json'));
    assert.deepEqual(second.taskIds, ['T02']);
    assert.equal(second.repairOrdinal, 0);
    run('done', 'T02');
    const dependent = JSON.parse(run('dispatch', '--json'));
    assert.deepEqual(dependent.taskIds, ['T03']);
    run('done', 'T03');
    assert.deepEqual(JSON.parse(run('dispatch', '--json')), { status: 'all_done' });
  });

  it('重复dispatch拒绝未返回预约，不重复消费预算也不无限fallback', () => {
    enterDev();
    const first = JSON.parse(run('dispatch', '--json'));
    for (let n = 0; n < 5; n++) {
      const retry = spawnSync(process.execPath, [CLI, 'dispatch', '--json'], { cwd: tmpDir, encoding: 'utf8' });
      assert.equal(retry.status, 2, retry.stderr);
      const blocked = JSON.parse(retry.stdout);
      assert.equal(blocked.status, 'blocked');
      assert.match(blocked.reason, /reserved/);
      assert.equal(blocked.record.attempt.id, first.attemptId);
      assert.equal(blocked.record.repairsUsed, 0);
    }
  });

  it('只允许在 DEV 阶段调度', () => {
    run('install', '--tool', 'codex');
    const result = spawnSync(process.execPath, [CLI, 'dispatch', '--json'], { cwd: tmpDir, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(JSON.parse(result.stdout).reason, /dispatch 只允许在活跃 dev 阶段运行/);
  });
});

describe('Codex auto skill', () => {
  it('生成每次预约一个 fresh 子 Agent 的顺序编排协议', () => {
    run('install', '--tool', 'codex');
    const skill = readFileSync(join(tmpDir, '.agents/skills/gantry-auto/SKILL.md'), 'utf-8');

    assert.match(skill, /gantry dispatch --json/);
    assert.match(skill, /spawn_agent/);
    assert.match(skill, /wait_agent/);
    assert.match(skill, /每次成功预约只创建一个 fresh executor subagent/);
    assert.match(skill, /context dev --task <id> --json/);
    assert.match(skill, /真实验收通过才完成任务/);
    assert.match(skill, /共享工作区不并行写/);
    assert.match(skill, /禁止 commit、gantry done\/dispatch\/advance/);
    assert.doesNotMatch(skill, /fallback_main/);
    assert.match(skill, /禁止调用 `spawn_agent` 或 `followup_task`/);
    assert.match(skill, /不得在主上下文接管清零/);
    assert.match(skill, /初次执行 \+ 三次修复/);
  });
});

describe('Claude Code auto skill', () => {
  it('生成每次预约一个 fresh 子 Agent 的顺序编排协议', () => {
    run('install', '--tool', 'claude');
    const skill = readFileSync(join(tmpDir, '.claude/skills/gantry-auto/SKILL.md'), 'utf-8');

    assert.match(skill, /gantry dispatch --json/);
    assert.match(skill, /`Agent` 工具/);
    assert.match(skill, /subagent_type.*general-purpose/);
    assert.match(skill, /同步等待/);
    assert.match(skill, /每次成功预约只创建一个 fresh executor subagent/);
    assert.match(skill, /共享工作区不并行写/);
    assert.match(skill, /context dev --task <id> --json/);
    assert.doesNotMatch(skill, /禁止使用并行 Agent 调用/);
    assert.match(skill, /禁止 commit、gantry done\/dispatch\/advance/);
    assert.doesNotMatch(skill, /fallback_main/);
    assert.match(skill, /禁止调用 `Agent` 工具或通过 resume/);
    assert.match(skill, /不得在主上下文接管清零/);
    assert.match(skill, /初次执行 \+ 三次修复/);
  });
});
