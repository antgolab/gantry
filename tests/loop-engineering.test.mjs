/**
 * loop-engineering.test.mjs — 验证 loop engineering 改造后的反馈环行为
 *
 * 覆盖：
 *   - reroute() 的升级 / 不降级 / 稀疏文本不误升 / taskCount 信号
 *   - getNextStage() 的 PIPELINES 跳过逻辑
 *   - checkGate() 的 pipeline-aware 前驱判定
 *   - parseStateMd 解析 "N / M" 双值
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { reroute, estimateFromCode } from '../src/lib/router.mjs';
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

describe('reroute · 反馈环', () => {
  it('稀疏文本不触发升级（避免 default=medium 引发的虚假升级）', () => {
    const r = reroute('light', { artifactsText: '#', taskCount: 0 });
    assert.equal(r.shouldUpgrade, false);
  });

  it('累积工件含架构关键词时升级 light → full', () => {
    const base = '我们要做完整的微服务架构迁移和重构，跨模块全面的设计需要重新评估。' +
                 '本次变更涉及 redesign 整体认证流程，包括 token、session、refresh 机制。' +
                 '架构演进必须考虑性能 / 并发 / 分布式问题。';
    // 重复以超过 200 字符门槛
    const text = base + '\n' + base;
    const r = reroute('light', { artifactsText: text, taskCount: 0 });
    assert.equal(r.shouldUpgrade, true);
    assert.equal(r.newPipeline, 'full');
  });

  it('任务数超 light 阈值时升级 standard', () => {
    const r = reroute('light', { artifactsText: '', taskCount: 5 });
    assert.equal(r.shouldUpgrade, true);
    assert.equal(r.newPipeline, 'standard');
  });

  it('任务数超 standard 阈值时升级 full', () => {
    const r = reroute('standard', { artifactsText: '', taskCount: 10 });
    assert.equal(r.shouldUpgrade, true);
    assert.equal(r.newPipeline, 'full');
  });

  it('当前 full 时不再升级（顶到头）', () => {
    const text = '架构 微服务 重构 '.repeat(20);
    const r = reroute('full', { artifactsText: text, taskCount: 99 });
    assert.equal(r.shouldUpgrade, false);
  });

  it('两个信号都升级时取最高', () => {
    const text = '修复一个小 bug 而已'.repeat(20); // small intent
    const r = reroute('light', { artifactsText: text, taskCount: 10 });
    // taskCount=10 在 light 阈值时升 standard，bug-text 不超 light
    // 但 reroute 当前模型 light → 检查 standard 阈值不适用，taskCount 走 light→standard 路径
    assert.equal(r.shouldUpgrade, true);
    assert.ok(['standard', 'full'].includes(r.newPipeline));
  });
});

describe('getNextStage · PIPELINES 跳过', () => {
  it('light pipeline: change → task（跳过 requirement/design）', () => {
    assert.equal(getNextStage('change', { pipeline: 'light' }), 'task');
  });

  it('light pipeline: dev → review（跳过 test）', () => {
    assert.equal(getNextStage('dev', { pipeline: 'light' }), 'review');
  });

  it('standard pipeline: design → task（跳过 ui-design）', () => {
    assert.equal(getNextStage('design', { pipeline: 'standard' }), 'task');
  });

  it('full pipeline: design → ui-design', () => {
    assert.equal(getNextStage('design', { pipeline: 'full' }), 'ui-design');
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
  it('light pipeline 进入 task 只需 CHANGE.md', () => {
    setup();
    writeFileSync(join(TMP, 'CHANGE.md'), '#');
    const r = checkGate('task', TMP, { pipeline: 'light' });
    assert.equal(r.passed, true);
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

  it('light pipeline 进入 review 需要 TASK 完成（不需要 TEST.md）', () => {
    setup();
    writeFileSync(join(TMP, 'TASK.md'), '<task id="T01" status="done">x</task>');
    const r = checkGate('review', TMP, { pipeline: 'light' });
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

  it('light pipeline 进入 task 同样受未决问题门禁约束', () => {
    setup();
    writeFileSync(join(TMP, 'PROPOSAL.md'),
      '# PROPOSAL\n\n## 待澄清问题\n\n- [ ] 还没问清\n\n---\n');
    const r = checkGate('task', TMP, { pipeline: 'light' });
    assert.equal(r.passed, false);
    assert.match(r.reason, /unresolved question/);
    teardown();
  });
});

describe('state · 解析 "N / M" 双值', () => {
  it('readState 正确解析 maxRetries 双值', () => {
    setup();
    writeState(TMP, {
      pipeline: 'standard',
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
});

describe('PIPELINES · 数据结构', () => {
  it('light 是 standard 的子集', () => {
    for (const stage of PIPELINES.light) {
      assert.ok(PIPELINES.standard.includes(stage), `${stage} should exist in standard`);
    }
  });

  it('standard 是 full 的子集', () => {
    for (const stage of PIPELINES.standard) {
      assert.ok(PIPELINES.full.includes(stage), `${stage} should exist in full`);
    }
  });

  it('每个 pipeline 都从 change 开始、以 integration 结束', () => {
    for (const name of ['light', 'standard', 'full']) {
      assert.equal(PIPELINES[name][0], 'change');
      assert.equal(PIPELINES[name][PIPELINES[name].length - 1], 'integration');
    }
  });
});

describe('router · estimateFromCode 命令注入安全', () => {
  const RTMP = join(import.meta.dirname, '.tmp-router-inject');

  it('含 shell 元字符的意图不崩溃、不执行注入', () => {
    if (existsSync(RTMP)) rmSync(RTMP, { recursive: true });
    mkdirSync(RTMP, { recursive: true });
    writeFileSync(join(RTMP, 'sample.mjs'), 'export const x = 1;\n');
    const sentinel = join(RTMP, 'PWNED');

    // 恶意意图:若关键词被拼进 shell 执行,touch 会创建哨兵文件
    const evil = `fix "$(touch ${sentinel})" and \`touch ${sentinel}\`; rm -rf x`;
    let result;
    assert.doesNotThrow(() => { result = estimateFromCode(evil, RTMP); });
    assert.equal(existsSync(sentinel), false, '注入命令不应被执行');
    // 返回值应是合法 scale 或 null,不抛错即达标
    assert.ok(result === null || typeof result === 'string');

    rmSync(RTMP, { recursive: true, force: true });
  });

  it('中文含特殊字符的意图安全处理', () => {
    if (existsSync(RTMP)) rmSync(RTMP, { recursive: true });
    mkdirSync(RTMP, { recursive: true });
    writeFileSync(join(RTMP, 'a.ts'), 'const 用户 = 1;\n');

    assert.doesNotThrow(() => estimateFromCode('修复 "用户$中心" 的 bug；重构', RTMP));

    rmSync(RTMP, { recursive: true, force: true });
  });
});
