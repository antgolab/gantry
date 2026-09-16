/**
 * ac-gate-cli.test.mjs — CLI gantry ac-gate 端到端(SPEC AC-6)
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');

function makeProject({
  specAcIds = ['AC-1', 'AC-2', 'AC-3'],
  covers = ['AC-1', 'AC-2', 'AC-3'],
  withTestCommands = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ac-gate-cli-'));
  const planningDir = join(root, '.gantry/planning');
  const specsDir = join(root, '.gantry/specs/demo');
  const loopDir = join(root, '.gantry/loop');
  mkdirSync(planningDir, { recursive: true });
  mkdirSync(specsDir, { recursive: true });
  mkdirSync(loopDir, { recursive: true });

  const proseBody = `# STATE

## Pipeline

- **模式**: \`full\`
- **活跃 Change**: \`demo\`
- **当前阶段**: \`review\`
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
  const fenceBlock = `<!-- BEGIN gantry:state -->
\`\`\`json
{
  "nextStep": null,
  "lastStageResult": null,
  "currentWave": null,
  "previousWave": null
}
\`\`\`
<!-- END gantry:state -->
`;
  writeFileSync(join(planningDir, 'STATE.md'), `${proseBody}\n${fenceBlock}`, 'utf-8');
  writeFileSync(join(planningDir, 'config.json'), '{}', 'utf-8');

  const acSections = specAcIds.map(ac => `## ${ac} · demo\n\nGiven ... When ... Then ...\n`).join('\n');
  writeFileSync(join(specsDir, 'SPEC.md'), `# SPEC: demo\n\n${acSections}`, 'utf-8');

  if (withTestCommands) {
    const coversList = covers.map(c => `'${c}'`).join(', ');
    writeFileSync(
      join(loopDir, 'test-commands.yml'),
      `unit:\n  cmd: node --test tests/\n  covers: [${coversList}]\n`,
      'utf-8',
    );
  }
  return root;
}

function run(cwd) {
  return spawnSync('node', [CLI, 'ac-gate'], { cwd, encoding: 'utf-8', timeout: 10000 });
}

test('AC-6 · 全覆盖 → ok · ac=3 exit 0', () => {
  const root = makeProject();
  try {
    const r = run(root);
    assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.match(r.stdout, /^ok · ac=3$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-6 · 部分缺失 → blocked · missing=AC-2,AC-3 exit 2', () => {
  const root = makeProject({ covers: ['AC-1'] });
  try {
    const r = run(root);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /^blocked · missing=AC-2,AC-3$/m);
    assert.match(r.stderr, /\[ac-gate\] missing coverage: AC-2, AC-3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-6 · 通配符 covers:* → ok', () => {
  const root = makeProject({ covers: ['*'] });
  try {
    const r = run(root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ok · ac=3$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-6 · SPEC 无 AC → skip · no-ac exit 0', () => {
  const root = makeProject({ specAcIds: [] });
  try {
    const r = run(root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^skip · no-ac$/m);
    assert.match(r.stderr, /SPEC 无 AC/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-6 · test-commands.yml 缺失 → skip · no-config exit 0', () => {
  const root = makeProject({ withTestCommands: false });
  try {
    const r = run(root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^skip · no-config$/m);
    assert.match(r.stderr, /test-commands\.yml missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-6 · 不写 fence(STATE.md 前后字节相等)', () => {
  const root = makeProject({ covers: ['AC-1'] });
  const statePath = join(root, '.gantry/planning/STATE.md');
  try {
    const before = readFileSync(statePath, 'utf-8');
    run(root);
    const after = readFileSync(statePath, 'utf-8');
    assert.equal(before, after, 'ac-gate 只读契约:不应写 STATE.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
