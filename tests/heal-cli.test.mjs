/**
 * heal-cli.test.mjs — CLI gantry heal 端到端(SPEC AC-4/AC-5)
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');

function makeProject({ withExecution = true, fence = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'heal-cli-'));
  const planningDir = join(root, '.gantry/planning');
  const specsDir = join(root, '.gantry/specs/demo');
  mkdirSync(planningDir, { recursive: true });
  mkdirSync(specsDir, { recursive: true });

  const proseBody = `# STATE

## Pipeline

- **模式**: \`full\`
- **活跃 Change**: \`demo\`
- **当前阶段**: \`dev\`
- **当前 Wave**: \`—\`
- **当前 Task**: \`—\`
- **活跃 Agent**: \`—\`

## 自动模式状态

- **autonomous**: \`false\`
- **已执行阶段数**: \`0 / 10\`
- **重试计数**: \`0 / 3\`
- **验证失败计数**: \`0\`
- **暂停原因**: \`—\`
- **上下文 token**: \`—\`
- **窗口使用率**: \`—\`
`;
  const f = { nextStep: null, lastStageResult: null, currentWave: null, previousWave: null, ...fence };
  const fenceBlock = `<!-- BEGIN gantry:state -->
\`\`\`json
${JSON.stringify(f, null, 2)}
\`\`\`
<!-- END gantry:state -->
`;
  writeFileSync(join(planningDir, 'STATE.md'), `${proseBody}\n${fenceBlock}`, 'utf-8');
  writeFileSync(join(planningDir, 'config.json'), '{}', 'utf-8');

  if (withExecution) {
    writeFileSync(join(specsDir, 'EXECUTION.md'), '# EXECUTION: demo\n\n## Entries\n', 'utf-8');
  }
  return root;
}

function run(cwd, ...args) {
  return spawnSync('node', [CLI, 'heal', ...args], { cwd, encoding: 'utf-8', timeout: 10000 });
}

function readFenceJson(root) {
  const raw = readFileSync(join(root, '.gantry/planning/STATE.md'), 'utf-8');
  const m = raw.match(/```json\n([\s\S]*?)\n```/);
  return m ? JSON.parse(m[1]) : null;
}

test('AC-4 · 记录成功 → stdout `recorded #1` exit 0', () => {
  const root = makeProject();
  try {
    const r = run(root, 'T02', '--reason', 'verify failed', '--command', 'node --test tests/foo.mjs');
    assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.match(r.stdout, /^recorded #1$/m);
    const exec = readFileSync(join(root, '.gantry/specs/demo/EXECUTION.md'), 'utf-8');
    assert.match(exec, /### T02 · attempt #1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-4 · 二次记录 → `recorded #2`', () => {
  const root = makeProject();
  try {
    run(root, 'T02', '--reason', 'r1');
    const r = run(root, 'T02', '--reason', 'r2');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^recorded #2$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-4 · 缺 --reason → exit 1 + stderr', () => {
  const root = makeProject();
  try {
    const r = run(root, 'T02');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--reason required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-4 · EXECUTION.md 缺失 → exit 1', () => {
  const root = makeProject({ withExecution: false });
  try {
    const r = run(root, 'T02', '--reason', 'r');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /execution file missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-5 · --check count=0 → ok · attempts=0/3 exit 0', () => {
  const root = makeProject();
  try {
    const r = run(root, '--check', 'T02');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ok · attempts=0\/3$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-5 · --check count=2 → ok · attempts=2/3 exit 0', () => {
  const root = makeProject();
  try {
    run(root, 'T02', '--reason', 'r1');
    run(root, 'T02', '--reason', 'r2');
    const r = run(root, '--check', 'T02');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ok · attempts=2\/3$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-5 · --check count=3 → blocked exit 2 + 写 fence', () => {
  const root = makeProject();
  try {
    run(root, 'T02', '--reason', 'r1');
    run(root, 'T02', '--reason', 'r2');
    run(root, 'T02', '--reason', 'r3');
    const r = run(root, '--check', 'T02');
    assert.equal(r.status, 2);
    assert.match(r.stdout, /^blocked · attempts=3\/3$/m);
    assert.match(r.stderr, /\[heal\] limit exceeded/);
    const fence = readFenceJson(root);
    assert.equal(fence.lastStageResult.blockedReason, 'heal: limit exceeded task=T02');
    assert.equal(fence.lastStageResult.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-5 · 已有非空 blockedReason 不覆盖', () => {
  const root = makeProject({ fence: { lastStageResult: { ok: false, blockedReason: 'preexisting' } } });
  try {
    run(root, 'T02', '--reason', 'r1');
    run(root, 'T02', '--reason', 'r2');
    run(root, 'T02', '--reason', 'r3');
    run(root, '--check', 'T02');
    const fence = readFenceJson(root);
    assert.equal(fence.lastStageResult.blockedReason, 'preexisting');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
