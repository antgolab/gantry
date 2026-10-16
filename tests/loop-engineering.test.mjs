/**
 * loop-engineering.test.mjs — 验证 loop engineering 改造后的反馈环行为
 *
 * 覆盖：
 *   - getNextStage() 的 PIPELINES 跳过逻辑
 *   - checkGate() 的 pipeline-aware 前驱判定
 *   - parseStateMd 解析 "N / M" 双值
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getNextStage, checkGate, PIPELINES } from '../src/lib/phases.mjs';
import { writeState, readState } from '../src/lib/state.mjs';

const TMP = join(import.meta.dirname, '.tmp-loop');

function setup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  mkdirSync(TMP, { recursive: true });
}

function teardown() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
}

describe('getNextStage · PIPELINES 跳过', () => {
  it('只保留 full/light 两条管线(ADR-006)', () => {
    assert.deepEqual(Object.keys(PIPELINES).sort(), ['full', 'light']);
  });

  it('light pipeline 只有 fast 一个阶段，无后继', () => {
    assert.deepEqual(PIPELINES.light, ['fast']);
    assert.equal(getNextStage('fast', { pipeline: 'light' }), null);
  });

  it('full pipeline: design → task(ui-design 已合入 design 阶段)', () => {
    assert.equal(getNextStage('design', { pipeline: 'full' }), 'task');
  });

  it('未指定 pipeline: 退回默认 STAGES.next', () => {
    assert.equal(getNextStage('change', {}), 'requirement');
  });

  it('full 的 integration 是终态', () => {
    assert.equal(getNextStage('integration', { pipeline: 'full' }), null);
  });
});

// 新 light 形态：意图由 CLI 固化在 <specsDir>/light.json（DESIGN D4 / AC-3）
function writeLightJson(scope) {
  writeFileSync(join(TMP, 'light.json'), JSON.stringify({
    intent: { goal: '一句话目标', accept: [], scope },
    baseline: {},
    createdAt: new Date().toISOString(),
  }));
}

describe('checkGate · pipeline-aware', () => {
  it('light pipeline 进入 fast 需要合法的 light.json 意图', () => {
    setup();
    writeLightJson(['src/lib/foo.mjs']);
    const r = checkGate('fast', TMP, { pipeline: 'light' });
    assert.equal(r.passed, true, `应放行, 实际: ${r.reason}`);
    teardown();
  });

  it('缺 light.json 时禁止进入 fast(hard block)', () => {
    setup();
    const r = checkGate('fast', TMP, { pipeline: 'light' });
    assert.equal(r.passed, false);
    assert.equal(r.hard, true);
    assert.match(r.reason, /light\.json/);
    teardown();
  });

  it('light.json 范围含 ** 时禁止进入 fast(hard block)', () => {
    setup();
    writeLightJson(['src/**']);
    const r = checkGate('fast', TMP, { pipeline: 'light' });
    assert.equal(r.passed, false);
    assert.equal(r.hard, true);
    assert.match(r.reason, /intent-scope-invalid/);
    assert.match(r.reason, /full/);
    teardown();
  });

  it('full pipeline 进入 task 需要 DESIGN.md', () => {
    setup();
    writeFileSync(join(TMP, 'PROPOSAL.md'), '#');
    writeFileSync(join(TMP, 'SPEC.md'), '#');
    const r = checkGate('task', TMP, { pipeline: 'full' });
    assert.equal(r.passed, false);
    assert.match(r.reason, /DESIGN\.md/);
    teardown();
  });

  it('full pipeline 进入 dev 需要 TASKS.md（原 phases-micro.test.mjs 回归用例迁移）', () => {
    setup();
    writeFileSync(join(TMP, 'PROPOSAL.md'), '# PROPOSAL\n');
    assert.equal(checkGate('dev', TMP, { pipeline: 'full' }).passed, false);
    writeFileSync(join(TMP, 'TASKS.md'), '<task id="T01" status="done">x</task>');
    assert.equal(checkGate('dev', TMP, { pipeline: 'full' }).passed, true);
    teardown();
  });

  it('checkAllTasksDone 检测到未完成任务', () => {
    setup();
    writeFileSync(join(TMP, 'TASKS.md'), '<task id="T01" status="pending">x</task>');
    const r = checkGate('test', TMP, { pipeline: 'full' });
    assert.equal(r.passed, false);
    assert.match(r.reason, /T01/);
    teardown();
  });

  it('checkReviewPassed 识别 BLOCKED 标记', () => {
    setup();
    writeFileSync(join(TMP, 'REVIEW.md'), '# Review\n\nBLOCKED on issue X');
    const r = checkGate('integration', TMP, { pipeline: 'full' });
    assert.equal(r.passed, false);
    assert.match(r.reason, /阻塞/);
    teardown();
  });

  it('禁用阶段被跳过', () => {
    const r = checkGate('review', TMP, {
      pipeline: 'full',
      stages: { review: { enabled: false } },
    });
    assert.equal(r.passed, true);
  });

  it('PROPOSAL 含未决问题时阻断进入 requirement', () => {
    setup();
    writeFileSync(join(TMP, 'PROPOSAL.md'),
      '# PROPOSAL\n\n## 待澄清问题\n\n- [ ] 深色模式跟随系统还是手动开关？\n\n---\n');
    const r = checkGate('requirement', TMP, { pipeline: 'full' });
    assert.equal(r.passed, false);
    assert.match(r.reason, /unresolved question/);
    teardown();
  });

  it('PROPOSAL 待澄清问题清空后通过', () => {
    setup();
    writeFileSync(join(TMP, 'PROPOSAL.md'),
      '# PROPOSAL\n\n## 待澄清问题\n\n无\n\n---\n');
    const r = checkGate('requirement', TMP, { pipeline: 'full' });
    assert.equal(r.passed, true);
    teardown();
  });

  it('未决问题门禁不误伤「影响面」等其他 checkbox 段', () => {
    setup();
    writeFileSync(join(TMP, 'PROPOSAL.md'),
      '# PROPOSAL\n\n## 影响面\n\n- [ ] 影响 SPEC.md\n- [ ] 影响 DESIGN.md\n\n## 待澄清问题\n\n无\n\n---\n');
    const r = checkGate('requirement', TMP, { pipeline: 'full' });
    assert.equal(r.passed, true, '其他段的未勾选 checkbox 不应触发阻断');
    teardown();
  });

  it('light pipeline 进入 fast 不读 PROPOSAL(light 无 PROPOSAL)', () => {
    setup();
    // 放一份带未决问题的 PROPOSAL：新 light 不生成也不读它，门禁只看 light.json
    writeFileSync(join(TMP, 'PROPOSAL.md'),
      '# PROPOSAL\n\n## 待澄清问题\n\n- [ ] 还没问清\n\n---\n');
    writeLightJson(['src/lib/foo.mjs']);
    const r = checkGate('fast', TMP, { pipeline: 'light' });
    assert.equal(r.passed, true, `light 门禁不应受 PROPOSAL 影响, 实际: ${r.reason}`);
    teardown();
  });
});

describe('state · 解析 "N / M" 双值', () => {
  it('readState 正确解析 maxRetries 双值', () => {
    setup();
    writeState(TMP, {
      pipeline: 'full',
      activeChange: 'demo',
      currentStage: 'dev',
      retries: 2,
      maxRetries: 5,
      contextUsage: { tokens: null, windowPercent: null },
    });
    const s = readState(TMP);
    assert.equal(s.retries, 2);
    assert.equal(s.maxRetries, 5);
    teardown();
  });

  it('transitionStage 清 pauseReason', () => {
    setup();
    writeState(TMP, {
      pipeline: 'full',
      activeChange: 'x',
      currentStage: 'change',
      pauseReason: 'old failure',
      retries: 2,
      contextUsage: { tokens: null, windowPercent: null },
    });
    // 直接调用 transitionStage 验证清理
    import('../src/lib/state.mjs').then(({ transitionStage }) => {
      transitionStage(TMP, 'change', 'requirement');
      const s = readState(TMP);
      assert.equal(s.pauseReason, null);
      assert.equal(s.retries, 0);
      teardown();
    });
  });

  it('旧 light 停在旧阶段时读取为 full', () => {
    setup();
    writeState(TMP, {
      pipeline: 'light',
      activeChange: 'legacy',
      currentStage: 'dev',
    });
    assert.equal(readState(TMP).pipeline, 'full');
    teardown();
  });
});

describe('PIPELINES · 数据结构', () => {
  it('full 从 change 开始、以 integration 结束', () => {
    assert.equal(PIPELINES.full[0], 'change');
    assert.equal(PIPELINES.full[PIPELINES.full.length - 1], 'integration');
  });

  it('light 只有 fast 阶段(无 change / integration)', () => {
    assert.deepEqual(PIPELINES.light, ['fast']);
  });
});
