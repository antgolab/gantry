/** Execution evidence for workflow evals. Never grade a model's claims as tool calls. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runProcess } from '../../src/lib/process-runner.mjs';
import { captureManifest, computeContentDigest } from '../../src/lib/task-evidence.mjs';
import { getTaskReceiptStatus } from '../../src/lib/task-cycle.mjs';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const CLI = join(REPO, 'src/cli.mjs');
const hash = text => createHash('sha256').update(text).digest('hex');
export function createFixture(t, { verify = 'node --test --test-reporter=tap behavior.test.mjs', extraTasks = '', tool = 'codex' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-eval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'eval@example.test'); git('config', 'user.name', 'Eval');
  const files = JSON.parse(readFileSync(new URL('./fixtures/behavior.json', import.meta.url), 'utf8'));
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
  const dir = join(root, '.gantry/specs/eval');
  const tasksPath = join(dir, 'TASKS.md');

  mkdirSync(join(root, '.gantry/planning'), { recursive: true });
  // Actual install/state setup via CLI, not a mocked completion state.
  execFileSync(process.execPath, [CLI, 'install', '--tool', tool], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [CLI, 'change', '--id', 'eval', 'behavior eval'], { cwd: root, stdio: 'pipe' });
  writeFileSync(tasksPath, `<task id="T01" status="pending"><name>Fix value</name><read_files>src/value.mjs, behavior.test.mjs</read_files><write_files>src/value.mjs</write_files><verify>${verify}</verify><done>value equals one</done></task>\n${extraTasks}`);
  const statePath = join(root, '.gantry/planning/STATE.md');
  // Keep normal CLI state representation while selecting this fixture's DEV entry.
  const stateModule = fileURLToPath(new URL('../../src/lib/state.mjs', import.meta.url));
  execFileSync(process.execPath, ['--input-type=module', '-e', `import {readState,writeState} from ${JSON.stringify(stateModule)}; const root=${JSON.stringify(root)}; writeState(root,{...readState(root),currentStage:'dev',activeAgent:'executor'});`], { cwd: root });
  git('add', '.'); git('commit', '-qm', 'fixture');
  const before = captureManifest(root);
  const controls = ['.gantry/specs/eval/TASKS.md', '.gantry/specs/eval/EXECUTION.md', '.gantry/planning/STATE.md'];
  const readControls = () => Object.fromEntries(controls.map(path => [path, existsSync(join(root, path)) ? hash(readFileSync(join(root, path))) : null]));
  const beforeControls = readControls();
  const calls = [];
  return { root, before, calls, tasksPath, statePath,
    tasks: () => readFileSync(tasksPath, 'utf8'),
    async cli(...args) {
      calls.push({ name: `gantry:${args[0]}`, input: args.slice(1) });
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      return runProcess(process.execPath, [CLI, ...args], { cwd: root, env, timeoutMs: 15000, killGraceMs: 100 });
    },
    observe(result, toolCalls = calls) {
      const after = captureManifest(root);
      return { root, before, after, beforeControls, afterControls: readControls(), result, toolCalls, receipt: getTaskReceiptStatus(root, 'T01', { changeId: 'eval' }) };
    },
  };
}
export function gradeTrial(trial, assertions = {}) {
  if (trial.result?.spawnError || trial.result?.timedOut || trial.result?.cancelled || trial.result?.cleanupComplete === false) return { status: 'infra-error', failures: ['execution infrastructure did not complete'] };
  const failures = [];
  const before = new Map(trial.before.entries.map(e => [e.path, e.worktreeHash]));
  const after = new Map(trial.after.entries.map(e => [e.path, e.worktreeHash]));
  for (const [path, value] of Object.entries(trial.beforeControls ?? {})) before.set(path, value);
  for (const [path, value] of Object.entries(trial.afterControls ?? {})) after.set(path, value);
  const names = trial.toolCalls.map(c => c.name);
  for (const path of assertions.requiredFiles ?? []) if (!after.has(path) || after.get(path) == null) failures.push(`missing file: ${path}`);
  for (const path of assertions.unchangedFiles ?? []) if (before.get(path) !== after.get(path)) failures.push(`changed file: ${path}`);
  for (const name of assertions.requiredToolCalls ?? []) if (!names.includes(name)) failures.push(`missing tool call: ${name}`);
  for (const name of assertions.forbiddenToolCalls ?? []) if (names.includes(name)) failures.push(`forbidden tool call: ${name}`);
  if (assertions.requiredExitCode !== undefined && trial.result.exitCode !== assertions.requiredExitCode) failures.push(`exit: ${trial.result.exitCode}`);
  if (assertions.taskReceiptValid !== undefined && trial.receipt.valid !== assertions.taskReceiptValid) failures.push(`receipt: ${trial.receipt.valid}`);
  return { status: failures.length ? 'fail' : 'pass', failures, overblock: Boolean(assertions.overblockGuard && failures.length), contentDigest: computeContentDigest(trial.after), newFiles: [...after.keys()].filter(path => !before.has(path)) };
}
export function parseModelTrace(engine, stdout) {
  const events = []; const toolCalls = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    let event; try { event = JSON.parse(line); } catch { throw new Error('invalid model JSONL trace'); }
    events.push(event);
    if (engine === 'claude') for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') toolCalls.push({ name: block.name, input: block.input });
    }
    if (engine === 'codex' && event.type === 'item.completed') {
      const item = event.item;
      if (item?.type === 'command_execution') toolCalls.push({ name: 'shell', input: item.command });
      if (item?.type === 'file_change') toolCalls.push({ name: 'file_change', input: item.changes });
      if (item?.type === 'mcp_tool_call') toolCalls.push({ name: `${item.server}:${item.tool}`, input: item.arguments });
    }
  }
  for (const call of [...toolCalls]) {
    const input = typeof call.input === 'string' ? call.input : JSON.stringify(call.input);
    for (const match of input.matchAll(/(?:gantry|cli\.mjs)[\"'\s]+(dispatch|done|advance|context)\b/g)) toolCalls.push({ name: `gantry:${match[1]}`, input });
  }
  const terminal = engine === 'claude' ? [...events].reverse().find(e => e.type === 'result') : [...events].reverse().find(e => e.type === 'turn.completed');
  return { events, toolCalls, model: events.find(e => e.model)?.model ?? events.find(e => e.type === 'system')?.model ?? null, terminal: Boolean(terminal), error: events.some(e => e.type === 'error' || e.type === 'turn.failed' || e.is_error === true) };
}
export async function runModelTrial({ root, prompt, engine = process.env.GANTRY_EVAL_ENGINE, env = process.env, run = runProcess, tracePath } = {}) {
  if (!engine) return { status: 'skip', reason: 'GANTRY_EVAL_ENGINE is unset; no model requested' };
  if (!['claude', 'codex'].includes(engine)) throw new Error('GANTRY_EVAL_ENGINE must be claude or codex');
  if (env.GANTRY_EVAL_AUTHENTICATED !== '1') return { status: 'skip', reason: 'model auth not confirmed: set GANTRY_EVAL_AUTHENTICATED=1 after authenticating the CLI' };
  const timeoutMs = Number(env.GANTRY_EVAL_TIMEOUT_MS ?? 60000);
  const budget = Number(env.GANTRY_EVAL_MAX_BUDGET_USD ?? 0.5);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isFinite(budget) || budget <= 0) throw new Error('invalid eval timeout/budget');
  // Codex has no portable dollar-cap flag; explicit consent and a deadline are required.
  if (engine === 'codex' && env.GANTRY_EVAL_CODEX_BUDGET_ACK !== '1') return { status: 'skip', reason: 'Codex has no portable USD cap; explicitly acknowledge with GANTRY_EVAL_CODEX_BUDGET_ACK=1' };
  const args = engine === 'claude'
    ? ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-budget-usd', String(budget), '--permission-mode', 'bypassPermissions']
    : ['exec', '--json', '--full-auto', '-C', root, prompt];
  const childEnv = { ...env }; delete childEnv.NODE_TEST_CONTEXT;
  if (tracePath) writeFileSync(tracePath, '');
  const result = await run(engine, args, { cwd: root, env: childEnv, timeoutMs, killGraceMs: 1000, maxOutputBytes: 8 * 1024 * 1024, onOutput(chunk, stream) { if (tracePath && stream === 'stdout') appendFileSync(tracePath, chunk); } });
  if (result.spawnError || result.timedOut || result.cancelled || !result.cleanupComplete || result.exitCode !== 0) return { status: 'infra-error', engine, result };
  try {
    const trace = parseModelTrace(engine, tracePath && existsSync(tracePath) && readFileSync(tracePath, 'utf8') ? readFileSync(tracePath, 'utf8') : result.stdout);
    if (!trace.terminal || trace.error) return { status: 'infra-error', engine, result, trace, reason: 'missing or failed terminal event' };
    return { status: 'completed', engine, result, ...trace };
  } catch (error) { return { status: 'infra-error', engine, result, reason: error.message }; }
}
export function summarizeTrials(trials, metadata = {}) {
  const completed = trials.filter(t => ['pass', 'fail'].includes(t.status));
  const pass = completed.filter(t => t.status === 'pass').length;
  const quorum = completed.length > trials.length / 2;
  return { ...metadata, attempted: trials.length, completed: completed.length, pass, fail: completed.length - pass,
    infrastructureErrors: trials.filter(t => t.status === 'infra-error').length, skipped: trials.filter(t => t.status === 'skip').length,
    overblocks: trials.filter(t => t.overblock).length, status: !quorum ? 'inconclusive' : pass > completed.length / 2 ? 'pass' : 'fail',
    passAtK: pass > 0, passAllK: trials.length > 0 && pass === trials.length };
}
export function protocolHash(root = REPO) {
  const entries = [];
  const walk = path => { if (!existsSync(path)) return; for (const name of readdirSync(path, { withFileTypes: true })) { const full = join(path, name.name); if (name.isDirectory()) walk(full); else if (/\.(md|json|mjs|sh)$/.test(name.name)) entries.push(`${relative(root, full)}\0${readFileSync(full)}`); } };
  for (const dir of ['skills', 'phases', 'src/agents', 'tools/renderers']) walk(join(root, dir));
  entries.push(readFileSync(join(root, 'package.json'), 'utf8'));
  return hash(entries.sort().join('\0'));
}
