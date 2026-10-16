/**
 * state-compat.test.mjs — 存量 STATE 归一化 + light verify 计数
 *
 * 派生自 AC-14（存量 STATE 兼容）与 AC-6（light 循环 verify 失败不静默放行），
 * 收窄规则见 SPEC「设计期澄清」表 + DESIGN D9 / D8。
 *
 * 覆盖：
 *   - readState：micro / 旧 light(change|integration|fast 无 light.json) → full@同 stage，
 *     stderr 输出一行迁移提示；新 light(fast 且有 light.json) / full 不被归一化
 *   - readState：旧 STATE 解析永不抛错
 *   - normalizeLegacyPipeline：纯函数边界
 *   - recordLightVerify：pass 归零 / 3 次不同诊断不暂停 / 第 4 次暂停 / 诊断重复直接暂停
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, normalizeLegacyPipeline, recordLightVerify } from '../src/lib/state.mjs';

const roots = [];

/**
 * 造一个临时项目目录，按 STATE.md 真实格式（见 state.mjs#renderStateMd 与
 * .gantry/planning/STATE.md）写入一份 STATE.md。
 */
function makeProject({ pipeline, activeChange = null, currentStage = 'idle' }) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-state-compat-'));
  roots.push(root);
  const planning = join(root, '.gantry', 'planning');
  mkdirSync(planning, { recursive: true });
  writeFileSync(join(planning, 'STATE.md'), renderFixture({ pipeline, activeChange, currentStage }), 'utf-8');
  return root;
}

/** 与 renderStateMd 同格式的最小 STATE.md 模板。 */
function renderFixture({ pipeline, activeChange, currentStage }) {
  return `# STATE — 项目协作状态

## Pipeline

- **模式**: \`${pipeline}\`
- **活跃 Change**: \`${activeChange || '无'}\`
- **当前阶段**: \`${currentStage}\`
- **当前 Wave**: \`—\`
- **当前 Task**: \`—\`
- **活跃 Agent**: \`—\`

## 自动模式状态

- **autonomous**: \`false\`
- **已执行阶段数**: \`0 / 3\`
- **重试计数**: \`0 / 3\`
- **验证失败计数**: \`0\`
- **暂停原因**: \`—\`
- **上下文 token**: \`—\`
- **窗口使用率**: \`—\`

---
_最后更新: 2026-10-12_
`;
}

/** 在临时项目里放一份 light.json（新 light 的判据）。 */
function writeLightJson(root, changeId) {
  const dir = join(root, '.gantry', 'specs', changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'light.json'), JSON.stringify({ intent: { goal: 'x', accept: ['y'], scope: ['src/'] } }, null, 2), 'utf-8');
}

/** 捕获 console.error 的一次调用输出（迁移提示走 stderr）。 */
function captureStderr(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
  }
});

describe('AC-14 · readState 存量归一化', () => {
  it('micro@dev → full@dev，stage 不变，stderr 一行提示', () => {
    const root = makeProject({ pipeline: 'micro', activeChange: 'legacy', currentStage: 'dev' });
    let state;
    const lines = captureStderr(() => { state = readState(root); });
    assert.equal(state.pipeline, 'full');
    assert.equal(state.currentStage, 'dev');
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '↑ pipeline 迁移: micro@dev → full@dev');
  });

  it('light@change → full@change，stderr 一行提示', () => {
    const root = makeProject({ pipeline: 'light', activeChange: 'legacy', currentStage: 'change' });
    let state;
    const lines = captureStderr(() => { state = readState(root); });
    assert.equal(state.pipeline, 'full');
    assert.equal(state.currentStage, 'change');
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '↑ pipeline 迁移: light@change → full@change');
  });

  it('light@integration → full@integration，stderr 一行提示', () => {
    const root = makeProject({ pipeline: 'light', activeChange: 'legacy', currentStage: 'integration' });
    let state;
    const lines = captureStderr(() => { state = readState(root); });
    assert.equal(state.pipeline, 'full');
    assert.equal(state.currentStage, 'integration');
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '↑ pipeline 迁移: light@integration → full@integration');
  });

  it('light@fast 且 change 目录无 light.json → full@fast（旧 light）', () => {
    const root = makeProject({ pipeline: 'light', activeChange: 'legacy', currentStage: 'fast' });
    let state;
    const lines = captureStderr(() => { state = readState(root); });
    assert.equal(state.pipeline, 'full');
    assert.equal(state.currentStage, 'fast');
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '↑ pipeline 迁移: light@fast → full@fast');
  });

  it('light@fast 且 change 目录有 light.json → 保持 light@fast，无提示', () => {
    const root = makeProject({ pipeline: 'light', activeChange: 'new-light', currentStage: 'fast' });
    writeLightJson(root, 'new-light');
    let state;
    const lines = captureStderr(() => { state = readState(root); });
    assert.equal(state.pipeline, 'light');
    assert.equal(state.currentStage, 'fast');
    assert.deepEqual(lines, []);
  });

  it('light@idle 合法，不被归一化', () => {
    const root = makeProject({ pipeline: 'light', activeChange: null, currentStage: 'idle' });
    let state;
    const lines = captureStderr(() => { state = readState(root); });
    assert.equal(state.pipeline, 'light');
    assert.equal(state.currentStage, 'idle');
    assert.deepEqual(lines, []);
  });

  it('full 保持 full，无提示', () => {
    const root = makeProject({ pipeline: 'full', activeChange: 'x', currentStage: 'dev' });
    let state;
    const lines = captureStderr(() => { state = readState(root); });
    assert.equal(state.pipeline, 'full');
    assert.deepEqual(lines, []);
  });

  it('未知值 standard@dev → full@dev（容忍旧 STATE）', () => {
    const root = makeProject({ pipeline: 'standard', activeChange: 'legacy', currentStage: 'dev' });
    let state;
    const lines = captureStderr(() => { state = readState(root); });
    assert.equal(state.pipeline, 'full');
    assert.equal(state.currentStage, 'dev');
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '↑ pipeline 迁移: standard@dev → full@dev');
  });

  it('STATE.md 缺失时返回默认 full@idle', () => {
    const root = mkdtempSync(join(tmpdir(), 'gantry-state-compat-'));
    roots.push(root);
    const state = readState(root);
    assert.equal(state.pipeline, 'full');
    assert.equal(state.currentStage, 'idle');
  });

  it('损坏 / 旧格式 STATE.md 解析不抛错', () => {
    const root = mkdtempSync(join(tmpdir(), 'gantry-state-compat-'));
    roots.push(root);
    const planning = join(root, '.gantry', 'planning');
    mkdirSync(planning, { recursive: true });
    writeFileSync(join(planning, 'STATE.md'), '# STATE\n\n随手写的散文，没有任何键值行。\n', 'utf-8');
    const state = readState(root);
    assert.equal(state.pipeline, 'full');
    assert.equal(state.currentStage, 'idle');
  });
});

describe('normalizeLegacyPipeline · 纯函数边界', () => {
  it('light@fast 未探测到 light.json → full，migrated=true，stage 不变', () => {
    const input = { pipeline: 'light', currentStage: 'fast' };
    const r = normalizeLegacyPipeline(input, { hasLightJson: false });
    assert.equal(r.migrated, true);
    assert.equal(r.state.pipeline, 'full');
    assert.equal(r.state.currentStage, 'fast');
  });

  it('light@fast 探测到 light.json → 不迁移', () => {
    const input = { pipeline: 'light', currentStage: 'fast' };
    const r = normalizeLegacyPipeline(input, { hasLightJson: true });
    assert.equal(r.migrated, false);
    assert.equal(r.state.pipeline, 'light');
  });

  it('迁移返回新对象，不原地修改入参', () => {
    const input = { pipeline: 'micro', currentStage: 'dev' };
    const r = normalizeLegacyPipeline(input, {});
    assert.equal(input.pipeline, 'micro');
    assert.notEqual(r.state, input);
  });

  it('full 原样返回同一对象', () => {
    const input = { pipeline: 'full', currentStage: 'dev' };
    const r = normalizeLegacyPipeline(input, {});
    assert.equal(r.migrated, false);
    assert.equal(r.state, input);
  });
});

describe('AC-6 · recordLightVerify 自愈计数', () => {
  it('pass → retries 归零、paused=false', () => {
    const state = { retries: 2, maxRetries: 3, pauseReason: null };
    const r = recordLightVerify(state, { pass: true });
    assert.equal(state.retries, 0);
    assert.equal(r.paused, false);
  });

  it('3 次不同诊断失败不暂停', () => {
    const state = { retries: 0, maxRetries: 3, pauseReason: null };
    let last = null;
    for (const d of ['d1', 'd2', 'd3']) {
      const r = recordLightVerify(state, { pass: false, diagnosis: d, lastDiagnosis: last });
      assert.equal(r.paused, false);
      last = d;
    }
    assert.equal(state.retries, 3);
    assert.equal(state.pauseReason, null);
  });

  it('第 4 次不同诊断失败 → light-verify-failed 暂停', () => {
    const state = { retries: 3, maxRetries: 3, pauseReason: null };
    const r = recordLightVerify(state, { pass: false, diagnosis: 'd4', lastDiagnosis: 'd3' });
    assert.equal(state.retries, 4);
    assert.equal(r.paused, true);
    assert.equal(state.pauseReason, 'light-verify-failed');
  });

  it('诊断与上一条相同 → 直接暂停，retries 不递增', () => {
    const state = { retries: 1, maxRetries: 3, pauseReason: null };
    const r = recordLightVerify(state, { pass: false, diagnosis: 'same', lastDiagnosis: 'same' });
    assert.equal(r.paused, true);
    assert.equal(state.retries, 1);
    assert.equal(state.pauseReason, 'light-verify-no-new-diagnosis');
  });

  it('诊断去空白后与上一条相同 → 直接暂停', () => {
    const state = { retries: 1, maxRetries: 3, pauseReason: null };
    const r = recordLightVerify(state, { pass: false, diagnosis: '  boom  ', lastDiagnosis: 'boom' });
    assert.equal(r.paused, true);
    assert.equal(state.retries, 1);
    assert.equal(state.pauseReason, 'light-verify-no-new-diagnosis');
  });

  it('诊断为空 → 直接暂停，retries 不递增', () => {
    const state = { retries: 2, maxRetries: 3, pauseReason: null };
    const r = recordLightVerify(state, { pass: false, diagnosis: '   ', lastDiagnosis: 'prev' });
    assert.equal(r.paused, true);
    assert.equal(state.retries, 2);
    assert.equal(state.pauseReason, 'light-verify-no-new-diagnosis');
  });

  it('pass 后再次失败从 0 重新计数', () => {
    const state = { retries: 0, maxRetries: 3, pauseReason: null };
    recordLightVerify(state, { pass: false, diagnosis: 'd1', lastDiagnosis: null });
    assert.equal(state.retries, 1);
    recordLightVerify(state, { pass: true });
    assert.equal(state.retries, 0);
    recordLightVerify(state, { pass: false, diagnosis: 'd2', lastDiagnosis: 'd1' });
    assert.equal(state.retries, 1);
  });
});
