/**
 * loop-next-cli.test.mjs — CLI 端到端契约(AC-5)
 *
 * 起真实 `node src/cli.mjs loop-next`,在临时项目根验证:
 *   - stdout 恰好一行,严格匹配白名单正则
 *   - stderr 空,或仅出现 [loop-next warn] 前缀
 *   - exit 0(推进 / done)或 exit 2(blocked)
 *   - fence 与散文区合并逻辑正确(full / light 两档)
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
const WHITELIST_REGEX = /^(gantry-(change|requirement|design|task|dev|test|review|integration|fast)|done|blocked)$/;

function makeProject(prose, fence) {
  const root = mkdtempSync(join(tmpdir(), 'loop-cli-'));
  const planningDir = join(root, '.gantry/planning');
  mkdirSync(planningDir, { recursive: true });

  // 最小散文区(与 renderStateMd 输出兼容:parseStateMd 只挑 "- **key**: `value`" 行)
  const proseBody = `# STATE — test fixture

## Pipeline

- **模式**: \`${prose.pipeline}\`
- **活跃 Change**: \`${prose.activeChange || '无'}\`
- **当前阶段**: \`${prose.currentStage}\`
- **当前 Wave**: \`${prose.currentWave ?? '—'}\`
- **当前 Task**: \`${prose.currentTask ?? '—'}\`
- **活跃 Agent**: \`${prose.activeAgent ?? '—'}\`

## 自动模式状态

- **autonomous**: \`${prose.autonomous ?? false}\`
- **已执行阶段数**: \`${prose.stagesRun ?? 0} / ${prose.maxStages ?? 10}\`
- **重试计数**: \`${prose.retries ?? 0} / ${prose.maxRetries ?? 3}\`
- **验证失败计数**: \`${prose.verifyFailCount ?? 0}\`
- **暂停原因**: \`${prose.pauseReason ?? '—'}\`
- **上下文 token**: \`${prose.contextUsage?.tokens ?? '—'}\`
- **窗口使用率**: \`${prose.contextUsage?.windowPercent ?? '—'}\`
`;

  const fenceBlock = `<!-- BEGIN gantry:state -->
\`\`\`json
${JSON.stringify(fence, null, 2)}
\`\`\`
<!-- END gantry:state -->
`;

  writeFileSync(join(planningDir, 'STATE.md'), `${proseBody}\n${fenceBlock}`, 'utf-8');
  return root;
}

function runLoopNext(cwd) {
  return spawnSync('node', [CLI, 'loop-next'], { cwd, encoding: 'utf-8', timeout: 10000 });
}

/**
 * 新 light 形态：STATE=light@fast 只有在 `<change>/light.json` 存在时才会被
 * readState 保留为 light（DESIGN D9 / AC-14），否则归一化为 full。
 */
function writeLightJson(root, changeId, scope = ['src/lib/foo.mjs']) {
  const dir = join(root, '.gantry/specs', changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'light.json'), JSON.stringify({
    intent: { goal: '一句话目标', accept: [], scope },
    baseline: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');
}

test('AC-5 · full pipeline · design 阶段 → gantry-task(ui-design 已合入 design)', () => {
  const root = makeProject(
    { pipeline: 'full', currentStage: 'design', activeChange: 'demo' },
    { nextStep: null, lastStageResult: null, currentWave: null, previousWave: null },
  );
  try {
    const r = runLoopNext(root);
    assert.equal(r.status, 0, `exit non-zero: stderr=${r.stderr}`);
    assert.equal(r.stdout.trim(), 'gantry-task');
    assert.ok(WHITELIST_REGEX.test(r.stdout.trim()));
    assert.ok(r.stderr === '' || /\[loop-next warn\]/.test(r.stderr), `unexpected stderr: ${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-5 · full pipeline · integration + ok → done, exit 0', () => {
  const root = makeProject(
    { pipeline: 'full', currentStage: 'integration', activeChange: 'demo' },
    { nextStep: null, lastStageResult: { ok: true, blockedReason: null }, currentWave: null, previousWave: null },
  );
  try {
    const r = runLoopNext(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-1/AC-5 · light pipeline · fast + ok → done', () => {
  const root = makeProject(
    { pipeline: 'light', currentStage: 'fast', activeChange: 'demo' },
    { nextStep: null, lastStageResult: { ok: true }, currentWave: null, previousWave: null },
  );
  try {
    writeLightJson(root, 'demo');
    const r = runLoopNext(root);
    assert.equal(r.status, 0, `exit non-zero: stderr=${r.stderr}`);
    assert.equal(r.stdout.trim(), 'done');
    assert.ok(WHITELIST_REGEX.test(r.stdout.trim()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-1/AC-5 · light pipeline · fast 未 ok → blocked, exit 2', () => {
  const root = makeProject(
    { pipeline: 'light', currentStage: 'fast', activeChange: 'demo' },
    { nextStep: null, lastStageResult: null, currentWave: null, previousWave: null },
  );
  try {
    writeLightJson(root, 'demo');
    const r = runLoopNext(root);
    assert.equal(r.status, 2, `期望 blocked, stderr=${r.stderr}`);
    assert.equal(r.stdout.trim(), 'blocked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-5 · blockedReason → stdout=blocked, exit 2', () => {
  const root = makeProject(
    { pipeline: 'full', currentStage: 'dev', activeChange: 'demo' },
    { nextStep: null, lastStageResult: { ok: false, blockedReason: 'human required' }, currentWave: null, previousWave: null },
  );
  try {
    const r = runLoopNext(root);
    assert.equal(r.status, 2);
    assert.equal(r.stdout.trim(), 'blocked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-5 · fence.nextStep 显式命中白名单 → 直接返回', () => {
  const root = makeProject(
    { pipeline: 'full', currentStage: 'dev', activeChange: 'demo' },
    { nextStep: 'gantry-review', lastStageResult: null, currentWave: null, previousWave: null },
  );
  try {
    const r = runLoopNext(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'gantry-review');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-5 · idle 阶段 → gantry-change', () => {
  const root = makeProject(
    { pipeline: 'full', currentStage: 'idle', activeChange: null },
    { nextStep: null, lastStageResult: null, currentWave: null, previousWave: null },
  );
  try {
    const r = runLoopNext(root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'gantry-change');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-5 · 输出严格单行,不带装饰', () => {
  const root = makeProject(
    { pipeline: 'full', currentStage: 'design', activeChange: 'demo' },
    { nextStep: null, lastStageResult: null, currentWave: null, previousWave: null },
  );
  try {
    const r = runLoopNext(root);
    // 允许尾部换行,但除去后必须只剩单 token
    const lines = r.stdout.replace(/\n$/, '').split('\n');
    assert.equal(lines.length, 1, `stdout 应为单行,得到 ${lines.length} 行: ${JSON.stringify(r.stdout)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
