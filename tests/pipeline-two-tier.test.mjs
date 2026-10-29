/**
 * pipeline-two-tier.test.mjs — AC-1 · pipeline 枚举收敛为 light / full
 *
 * 覆盖：
 *   - 阶段图键集合 = {full, light}，PIPELINES.light === ['fast']
 *   - loop 收敛条件键集合 = {full, light}，WHITELIST 含 gantry-fast
 *   - fast 门禁只认 CLI 固化的 light.json（缺 / 范围非法 → hard block；合法 → 放行）
 *   - src/lib 下（state.mjs 归一化除外）不再出现 micro 管线字面量
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PIPELINES, checkGate } from '../src/lib/phases.mjs';
import { CONVERGE_CONDITIONS, WHITELIST, computeNextStep } from '../src/lib/loop.mjs';

const LIB_DIR = join(import.meta.dirname, '..', 'src', 'lib');

function makeSpecsDir() {
  return mkdtempSync(join(tmpdir(), 'gantry-two-tier-'));
}

function writeLightJson(dir, intent) {
  writeFileSync(join(dir, 'light.json'), JSON.stringify({
    intent,
    baseline: {},
    createdAt: new Date().toISOString(),
  }), 'utf-8');
}

test('AC-1 · PIPELINES 只有 full / light 两档', () => {
  assert.deepEqual(Object.keys(PIPELINES).sort(), ['full', 'light']);
});

test('AC-1 · PIPELINES.light === [fast]（无 change / integration）', () => {
  assert.deepEqual(PIPELINES.light, ['fast']);
});

test('AC-1 · full 的 8 阶段未变', () => {
  assert.deepEqual(
    PIPELINES.full,
    ['change', 'requirement', 'design', 'task', 'dev', 'test', 'review', 'integration'],
  );
});

test('AC-1 · 收敛条件键集合 = {full, light}', () => {
  assert.deepEqual(Object.keys(CONVERGE_CONDITIONS).sort(), ['full', 'light']);
});

test('AC-1 · WHITELIST 含 gantry-fast，且无 micro 相关 token', () => {
  assert.ok(WHITELIST.includes('gantry-fast'), 'WHITELIST 应含内部 token gantry-fast');
  for (const token of WHITELIST) {
    assert.ok(!/micro/i.test(token), `WHITELIST 不应含 micro token: ${token}`);
  }
  assert.ok(Object.isFrozen(WHITELIST), 'WHITELIST 必须保持冻结');
});

test('AC-1/D23 · WHITELIST 中除 blocked 外每个 token 都由 computeNextStep 可达', () => {
  // F-04 的教训:只断言 WHITELIST「含」某 token 发现不了死 token。
  // 这里对每个 token 反查一条能产出它的 state —— 白名单是 driver 的契约面,
  // 任何一个 token 不可达都意味着契约说谎(blocked 是兜底失败态,不在此列)。
  const witnesses = {
    'gantry-change': { pipeline: 'full', currentStage: 'change' },
    'gantry-requirement': { pipeline: 'full', currentStage: 'requirement' },
    'gantry-design': { pipeline: 'full', currentStage: 'design' },
    'gantry-task': { pipeline: 'full', currentStage: 'task' },
    'gantry-dev': { pipeline: 'full', currentStage: 'dev' },
    'gantry-test': { pipeline: 'full', currentStage: 'test' },
    'gantry-review': { pipeline: 'full', currentStage: 'review' },
    'gantry-integration': { pipeline: 'full', currentStage: 'integration' },
    // D23:light 只有 fast 一个阶段,未收敛正是靠这条产生 gantry-fast。
    'gantry-fast': { pipeline: 'light', currentStage: 'fast' },
    done: { pipeline: 'light', currentStage: 'fast', lastStageResult: { ok: true } },
  };

  const reachable = new Set();
  for (const [token, state] of Object.entries(witnesses)) {
    const produced = computeNextStep({
      nextStep: null,
      currentWave: null,
      previousWave: null,
      lastStageResult: null,
      ...state,
    });
    assert.equal(produced, token, `state ${JSON.stringify(state)} 应产出 ${token}, 实际 ${produced}`);
    reachable.add(produced);
  }

  const expected = WHITELIST.filter((t) => t !== 'blocked');
  const missing = expected.filter((t) => !reachable.has(t));
  assert.deepEqual(missing, [], `以下白名单 token 无任何 state 可达(死 token): ${missing.join(', ')}`);
});

test('AC-5 · fast 门禁：缺 light.json 时 hard block', () => {
  const dir = makeSpecsDir();
  try {
    const r = checkGate('fast', dir, { pipeline: 'light' });
    assert.equal(r.passed, false);
    assert.equal(r.hard, true);
    assert.match(r.reason, /light\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-5 · fast 门禁：范围含 ** 时 hard block', () => {
  const dir = makeSpecsDir();
  try {
    writeLightJson(dir, { goal: 'g', accept: [], scope: ['src/**'] });
    const r = checkGate('fast', dir, { pipeline: 'light' });
    assert.equal(r.passed, false);
    assert.equal(r.hard, true);
    assert.match(r.reason, /intent-scope-invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-3 · fast 门禁：light.json 意图范围合法时放行', () => {
  const dir = makeSpecsDir();
  try {
    writeLightJson(dir, { goal: 'g', accept: ['可跑'], scope: ['src/lib/foo.mjs', 'tests/'] });
    const r = checkGate('fast', dir, { pipeline: 'light' });
    assert.equal(r.passed, true, `应放行, 实际: ${r.reason}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-1 · src/lib 下除 state.mjs 归一化外无 micro 管线字面量', () => {
  // 词边界式判定：`microservice`（hard-rules 的跨模块红线关键词，英文单词）不算命中，
  // 只有出现独立的 micro 词（枚举值 / 分支名 / 注释里的管线名）才算残留。
  const MICRO_TOKEN = /(^|[^A-Za-z0-9_])micro([^A-Za-z0-9_]|$)/;
  // 过渡例外：tier-router.mjs 是待删模块，由 T06 负责删除（replacement AC-2 / AC-18）；
  // 该文件不是本 change 的执行路径，T04 不得触碰。T06 落地后此例外自然失效（文件不存在）。
  const PENDING_DELETE = new Set(['tier-router.mjs']);
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.mjs')) continue;
      if (entry === 'state.mjs') continue; // AC-14 存量归一化唯一允许的位置
      if (PENDING_DELETE.has(entry)) continue;
      const content = readFileSync(full, 'utf-8');
      content.split('\n').forEach((line, i) => {
        if (MICRO_TOKEN.test(line)) offenders.push(`${full}:${i + 1}: ${line.trim()}`);
      });
    }
  };
  walk(LIB_DIR);

  assert.deepEqual(offenders, [], `以下位置残留 micro 管线字面量:\n${offenders.join('\n')}`);
});
