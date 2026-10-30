/** Protocol regression checks: source contract, parseable task fields and adapter behavior. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseTasks } from '../src/lib/tasks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(root, path), 'utf8');

test('full DEV protocols agree on single-task reservation, candidate boundary and actual completion', () => {
  for (const file of ['phases/4-dev.md', 'skills/auto.md', 'skills/exec.md']) {
    const text = read(file);
    assert.match(text, /dispatch.*--json/);
    assert.match(text, /fresh executor/);
    assert.match(text, /done/);
    assert.match(text, /ralph\.maxRepairs/);
    assert.doesNotMatch(text, /同一条消息里为每个 task|整波 revert 后重跑|status":"fallback_main"|禁止串行等待/);
    assert.match(text, /候选/);
  }
  const phase = read('phases/4-dev.md');
  assert.match(phase, /receipt → EXECUTION → TASKS/);
  assert.match(phase, /先扣额度|先扣后启动/);
  assert.match(read('skills/auto.md'), /advance --approve/);
  assert.match(read('src/agents/executor.md'), /不改 TASKS\/EXECUTION\/STATE/);
});

test('TASKS template declares optional command lists without splitting shell comma arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-protocol-'));
  try {
    const path = join(dir, 'TASKS.md');
    const template = read('templates/TASKS.md');
    assert.match(template, /<preflight>/);
    assert.match(template, /<checks>/);
    assert.match(template, /checkpointCommands/);
    writeFileSync(path, `<task id="T01"><name>x</name><write_files>src/x.mjs</write_files><preflight>node --version\nnode -e "console.log('a,b')"</preflight><verify>node --test test.mjs</verify><checks>node --check src/x.mjs\nnode -e "console.log('c,d')"</checks><done>works</done></task>`);
    const [task] = parseTasks(path);
    assert.deepEqual(task.preflight, ['node --version', `node -e "console.log('a,b')"`]);
    assert.deepEqual(task.checks, ['node --check src/x.mjs', `node -e "console.log('c,d')"`]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('both adapters reject DEV without a task and mismatched frozen pack before invoking a client', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-adapter-protocol-'));
  try {
    mkdirSync(join(dir, '.gantry/core/phases'), { recursive: true });
    mkdirSync(join(dir, '.gantry/planning'), { recursive: true });
    writeFileSync(join(dir, '.gantry/core/phases/4-dev.md'), '# phase');
    writeFileSync(join(dir, '.gantry/planning/context-pack.json'), JSON.stringify({ stage: 'dev', taskId: 'T02' }));
    for (const client of ['claude', 'codex']) {
      const adapter = join(root, `src/loop/dispatch-${client}.sh`);
      let output = spawnSync('bash', [adapter, 'dev'], { cwd: dir, env: { ...process.env, PROJECT_ROOT: dir }, encoding: 'utf8' });
      assert.equal(output.status, 64, `${client} requires task`);
      output = spawnSync('bash', [adapter, 'dev', 'T01'], { cwd: dir, env: { ...process.env, PROJECT_ROOT: dir }, encoding: 'utf8' });
      assert.equal(output.status, 64, `${client} checks frozen identity`);
      assert.match(output.stderr, /identity mismatch/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('user docs retain content receipts, bounded failures and honest recovery limits', () => {
  const text = read('docs/loop.md');
  for (const word of ['checkpointCommands', 'runTimeoutMs', 'killGraceMs', 'advance --approve', 'execution/<task>.json', 'null', '旧锁', '初次', '三次修复']) assert.ok(text.includes(word), word);
  assert.doesNotMatch(text, /dispatch 非零且 rc≠64.*退避后重跑同一 phase|按 pipeline 顺序推导.*后继/);
});

test('rendered Codex and Claude auto skills cannot reintroduce parallel waves or unbounded fallback', async () => {
  const { render: codex } = await import('../tools/renderers/codex.mjs');
  const { render: claude } = await import('../tools/renderers/claude-code.mjs');
  const core = { phases: {}, rules: '', methodology: '' };
  const commands = { auto: read('skills/auto.md') };
  for (const [render, path] of [[codex, '.agents/skills/gantry-auto/SKILL.md'], [claude, '.claude/skills/gantry-auto/SKILL.md']]) {
    const rendered = render(core, commands, {});
    const text = rendered[path];
    assert.ok(text, path);
    assert.match(text, /每次成功预约只创建一个 fresh executor subagent/);
    assert.match(text, /attemptId、repairOrdinal/);
    assert.match(text, /gantry done <id> --json/);
    assert.doesNotMatch(text, /fallback_main|同一条消息里为本 wave|全部创建后再逐个|本 wave 的每个 taskId/);
    assert.match(text, /ralph\.maxRepairs 次修复（默认3）/);
    assert.match(text, /宿主共用预算/);
    assert.match(text, /精确恢复.*已保存 contract 原值/);
  }
});
