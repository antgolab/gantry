/**
 * loop-guard-cli.test.mjs — CLI loop-guard 端到端契约
 *
 * 对齐 SPEC AC-4 / AC-7。spawnSync 起真实 CLI,验证 stdout / stderr /
 * exit code / fence 侧写四重契约。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');

function makeProject({ state = {}, fence = {}, config = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'loop-guard-cli-'));
  const planningDir = join(root, '.gantry/planning');
  mkdirSync(planningDir, { recursive: true });

  const s = {
    pipeline: 'full',
    activeChange: 'demo',
    currentStage: 'dev',
    currentWave: null,
    currentTask: null,
    activeAgent: null,
    autonomous: false,
    stagesRun: 0,
    maxStages: 10,
    retries: 0,
    maxRetries: 3,
    verifyFailCount: 0,
    pauseReason: null,
    contextUsage: null,
    ...state,
  };
  const proseBody = `# STATE

## Pipeline

- **模式**: \`${s.pipeline}\`
- **活跃 Change**: \`${s.activeChange || '无'}\`
- **当前阶段**: \`${s.currentStage}\`
- **当前 Wave**: \`${s.currentWave ?? '—'}\`
- **当前 Task**: \`${s.currentTask ?? '—'}\`
- **活跃 Agent**: \`${s.activeAgent ?? '—'}\`

## 自动模式状态

- **autonomous**: \`${s.autonomous}\`
- **已执行阶段数**: \`${s.stagesRun} / ${s.maxStages}\`
- **重试计数**: \`${s.retries} / ${s.maxRetries}\`
- **验证失败计数**: \`${s.verifyFailCount ?? 0}\`
- **暂停原因**: \`${s.pauseReason ?? '—'}\`
- **上下文 token**: \`${s.contextUsage?.tokens ?? '—'}\`
- **窗口使用率**: \`${s.contextUsage?.windowPercent ?? '—'}\`
`;

  const f = { nextStep: null, lastStageResult: null, currentWave: null, previousWave: null, ...fence };
  const fenceBlock = `<!-- BEGIN gantry:state -->
\`\`\`json
${JSON.stringify(f, null, 2)}
\`\`\`
<!-- END gantry:state -->
`;
  writeFileSync(join(planningDir, 'STATE.md'), `${proseBody}\n${fenceBlock}`, 'utf-8');
  writeFileSync(join(planningDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
  return root;
}

function run(cwd) {
  return spawnSync('node', [CLI, 'loop-guard'], { cwd, encoding: 'utf-8', timeout: 10000 });
}

function readFenceJson(root) {
  const raw = readFileSync(join(root, '.gantry/planning/STATE.md'), 'utf-8');
  const m = raw.match(/```json\n([\s\S]*?)\n```/);
  return m ? JSON.parse(m[1]) : null;
}

test('AC-4 · 未熔断 → stdout=ok exit=0', () => {
  const root = makeProject({
    state: { contextUsage: { windowPercent: 10, tokens: 100 }, stagesRun: 1, maxStages: 10 },
  });
  try {
    const r = run(root);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.equal(r.stdout.trim(), 'ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-4 · context 熔断 → stdout=blocked exit=2 + stderr warn', () => {
  const root = makeProject({
    state: { contextUsage: { windowPercent: 90, tokens: 100 } },
  });
  try {
    const r = run(root);
    assert.equal(r.status, 2);
    assert.equal(r.stdout.trim(), 'blocked');
    assert.match(r.stderr, /\[loop-guard warn\] context-window-exceeded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-3 · stagesRun 熔断 → exit 2', () => {
  const root = makeProject({
    state: { contextUsage: { windowPercent: 0, tokens: 0 }, stagesRun: 10, maxStages: 10 },
  });
  try {
    const r = run(root);
    assert.equal(r.status, 2);
    assert.equal(r.stdout.trim(), 'blocked');
    assert.match(r.stderr, /max-stages-exceeded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-7 · 熔断写 fence.blockedReason', () => {
  const root = makeProject({
    state: { contextUsage: { windowPercent: 95 } },
  });
  try {
    run(root);
    const fence = readFenceJson(root);
    assert.equal(fence.lastStageResult.blockedReason, 'loop-guard: context-window-exceeded');
    assert.equal(fence.lastStageResult.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-7 · 已有 blockedReason 不覆盖', () => {
  const root = makeProject({
    state: { contextUsage: { windowPercent: 95 } },
    fence: { lastStageResult: { ok: false, blockedReason: 'preexisting reason' } },
  });
  try {
    run(root);
    const fence = readFenceJson(root);
    assert.equal(fence.lastStageResult.blockedReason, 'preexisting reason', '不应被覆盖');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-2 · config.loopGuard.contextPercent 覆写生效', () => {
  const root = makeProject({
    state: { contextUsage: { windowPercent: 50, tokens: 1 } },
    config: { loopGuard: { contextPercent: 40 } },
  });
  try {
    const r = run(root);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /context-window-exceeded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-4 · 单行输出契约', () => {
  const root = makeProject({
    state: { contextUsage: { windowPercent: 10, tokens: 1 } },
  });
  try {
    const r = run(root);
    const lines = r.stdout.replace(/\n$/, '').split('\n');
    assert.equal(lines.length, 1, `stdout 应为单行,得到 ${lines.length} 行: ${JSON.stringify(r.stdout)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
