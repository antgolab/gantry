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
  it('只保留 full 和 light 两条管线', () => {
    assert.deepEqual(Object.keys(PIPELINES).sort(), ['full', 'light']);
  });

  it('light pipeline: change → fast → integration', () => {
    assert.equal(getNextStage('change', { pipeline: 'light' }), 'fast');
    assert.equal(getNextStage('fast', { pipeline: 'light' }), 'integration');
  });

  it('full pipeline: UI 无影响时 design → task', () => {
    assert.equal(getNextStage('design', { pipeline: 'full', _uiImpact: false,
      stages: { 'ui-design': { enabled: 'auto', condition: 'ui-impact' } } }), 'task');
  });

  it('未指定 pipeline: 退回默认 STAGES.next', () => {
    assert.equal(getNextStage('change', {}), 'requirement');
  });

  it('integration 总是终态', () => {
    assert.equal(getNextStage('integration', { pipeline: 'light' }), null);
    assert.equal(getNextStage('integration', { pipeline: 'full' }), null);
  });
});

describe('checkGate · pipeline-aware', () => {
  it('light pipeline 进入 fast 需要低风险 PROPOSAL', () => {
    setup();
    writeFileSync(join(TMP, 'PROPOSAL.md'), '# PROPOSAL\n\n修复 README 拼写\n\n## 待澄清问题\n\n无\n');
    const r = checkGate('fast', TMP, { pipeline: 'light' });
    assert.equal(r.passed, true);
    teardown();
  });

  it('light pipeline 高风险 PROPOSAL 不能进入 fast', () => {
    setup();
    writeFileSync(join(TMP, 'PROPOSAL.md'), '# PROPOSAL\n\n新增数据库 migration\n\n## 待澄清问题\n\n无\n');
    const r = checkGate('fast', TMP, { pipeline: 'light' });
    assert.equal(r.passed, false);
    assert.match(r.reason, /full/);
    teardown();
  });

  it('full pipeline 进入 task 需要 DESIGN.md（不接受 CHANGE.md）', () => {
    setup();
    writeFileSync(join(TMP, 'CHANGE.md'), '#');
    writeFileSync(join(TMP, 'REQUIREMENT.md'), '#');
    const r = checkGate('task', TMP, { pipeline: 'full' });
    assert.equal(r.passed, false);
    assert.match(r.reason, /DESIGN\.md/);
    teardown();
  });

  it('light pipeline 进入 integration 需要 EXECUTION 证据', () => {
    setup();
    writeFileSync(join(TMP, 'EXECUTION.md'), '# EXECUTION\n\nverify: PASS\n');
    const r = checkGate('integration', TMP, { pipeline: 'light' });
    assert.equal(r.passed, true);
    teardown();
  });

  it('checkAllTasksDone 检测到未完成任务', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), '<task id="T01" status="pending">x</task>');
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
    const r = checkGate('ui-design', TMP, {
      pipeline: 'full',
      stages: { 'ui-design': { enabled: false } },
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

  it('light pipeline 进入 fast 同样受未决问题门禁约束', () => {
    setup();
    writeFileSync(join(TMP, 'PROPOSAL.md'),
      '# PROPOSAL\n\n## 待澄清问题\n\n- [ ] 还没问清\n\n---\n');
    const r = checkGate('fast', TMP, { pipeline: 'light' });
    assert.equal(r.passed, false);
    assert.match(r.reason, /unresolved question/);
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
  it('每个 pipeline 都从 change 开始、以 integration 结束', () => {
    for (const name of ['light', 'full']) {
      assert.equal(PIPELINES[name][0], 'change');
      assert.equal(PIPELINES[name][PIPELINES[name].length - 1], 'integration');
    }
  });
});
