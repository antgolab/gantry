/** Optional paid workflow eval. No engine/auth opt-in means SKIP, never PASS. */
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture, gradeTrial, runModelTrial, summarizeTrials, protocolHash, CLI } from './behavior-harness.mjs';

const engine = process.env.GANTRY_EVAL_ENGINE;
const trials = Number(process.env.GANTRY_EVAL_TRIALS ?? 3);
if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10) throw new Error('GANTRY_EVAL_TRIALS must be 1..10');
const out = process.env.GANTRY_EVAL_OUT ?? mkdtempSync(join(tmpdir(), 'gantry-model-evals-'));
mkdirSync(out, { recursive: true });
const protocolDigest = protocolHash();
const cases = [
  { id: 'bounded-candidate', prompt: `Fix src/value.mjs so value equals 1, without changing behavior.test.mjs or user.txt. Use this CLI to reserve, verify and complete: node ${JSON.stringify(CLI)} dispatch --json, then implement, then node ${JSON.stringify(CLI)} done T01 --json. No subagents and no commit.`, assertions: { requiredExitCode: 0, taskReceiptValid: true, unchangedFiles: ['behavior.test.mjs', 'user.txt'], requiredToolCalls: ['gantry:dispatch', 'gantry:done'], forbiddenToolCalls: ['Agent', 'Task'], overblockGuard: true } },
  { id: 'read-only-no-overorchestration', prompt: 'Read src/value.mjs and tell me its current exported value. Do not edit files, execute a task, or create subagents.', assertions: { requiredExitCode: 0, unchangedFiles: ['src/value.mjs', 'user.txt', 'behavior.test.mjs'], forbiddenToolCalls: ['Agent', 'Task', 'gantry:dispatch', 'gantry:done'], overblockGuard: true } },
];
let failed = false;
for (const scenario of cases) {
  const results = [];
  for (let i = 0; i < trials; i++) {
    const cleanups = []; const f = createFixture({ after: fn => cleanups.push(fn) }, { tool: engine === 'claude' ? 'claude' : 'codex' });
    const dir = join(out, `${scenario.id}-${i + 1}`); mkdirSync(dir);
    try {
      const run = await runModelTrial({ root: f.root, engine, prompt: scenario.prompt, tracePath: join(dir, 'trace.jsonl') });
      const verdict = run.status === 'completed' ? gradeTrial(f.observe(run.result, run.toolCalls), scenario.assertions) : { status: run.status, reason: run.reason };
      results.push({ ...verdict, model: run.model ?? null, engine: engine ?? null });
      writeFileSync(join(dir, 'result.json'), JSON.stringify({ verdict, result: run.result ?? null, toolCalls: run.toolCalls ?? [], model: run.model ?? null }, null, 2));
    } finally { cleanups.reverse().forEach(fn => fn()); }
  }
  const summary = summarizeTrials(results, { scenario: scenario.id, engine: engine ?? null, models: [...new Set(results.map(r => r.model).filter(Boolean))], protocolDigest });
  appendFileSync(join(out, 'history.jsonl'), JSON.stringify({ ...summary, at: new Date().toISOString() }) + '\n');
  console.log(JSON.stringify(summary));
  if (!['pass', 'inconclusive'].includes(summary.status) || (summary.status === 'inconclusive' && summary.skipped !== trials)) failed = true;
}
console.log(`Artifacts: ${out}`);
if (failed) process.exitCode = 1;
