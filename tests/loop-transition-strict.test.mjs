/**
 * loop-transition-strict.test.mjs — transitionStage state-must-advance 断言
 *
 * 对齐 gantry-loop-pdlc-gantry-patch AC-6。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeState, transitionStage, readState, writeFence } from '../src/lib/state.mjs';

function makeTempRoot(state) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-transition-'));
  mkdirSync(join(root, '.gantry', 'planning'), { recursive: true });
  if (state) writeState(root, state);
  return root;
}

test('AC-6 · 同 stage 非 dev throw', () => {
  const root = makeTempRoot({
    pipeline: 'full', activeChange: 't', currentStage: 'design',
    currentWave: null, currentTask: null, activeAgent: 'architect',
    autonomous: true, stagesRun: 1, maxStages: 10, retries: 0, maxRetries: 3,
    verifyFailCount: 0, contextUsage: {},
  });
  assert.throws(
    () => transitionStage(root, 'design', 'design'),
    /state-must-advance/,
    '同 stage 非 dev 必须 throw',
  );
});

test('AC-6 · 同 stage 是 dev 但 wave 未变 也 throw', () => {
  const root = makeTempRoot({
    pipeline: 'full', activeChange: 't', currentStage: 'dev',
    currentWave: 1, currentTask: null, activeAgent: 'executor',
    autonomous: true, stagesRun: 3, maxStages: 10, retries: 0, maxRetries: 3,
    verifyFailCount: 0, contextUsage: {},
  });
  // fence 未写,previousWave 为 null,即使 currentWave=1 也没有真实推进
  writeFence(root, { nextStep: null, lastStageResult: null, currentWave: 1, previousWave: 1 });
  assert.throws(
    () => transitionStage(root, 'dev', 'dev'),
    /state-must-advance/,
    'dev wave 未变必须 throw',
  );
});

test('AC-6 · 同 stage 是 dev 且 wave 推进 pass', () => {
  const root = makeTempRoot({
    pipeline: 'full', activeChange: 't', currentStage: 'dev',
    currentWave: 2, currentTask: null, activeAgent: 'executor',
    autonomous: true, stagesRun: 3, maxStages: 10, retries: 0, maxRetries: 3,
    verifyFailCount: 0, contextUsage: {},
  });
  // 关键:state.mjs 散文区没有 previousWave 字段,断言从 state.previousWave(默认 undefined)+
  // fence 之外的字段读取。本 assert 让 previousWave=1 生效,证明"wave 推进"能被识别。
  writeFence(root, { nextStep: null, lastStageResult: null, currentWave: 2, previousWave: 1 });
  // 断言不 throw
  assert.doesNotThrow(() => {
    // 注意:transitionStage 内部 readState(root) 不读 fence,故 previousWave 仍为 undefined。
    // 这条测试暴露:当前实现只在散文区读 previousWave,而散文区未持久化该字段。
    // 需要在 state.mjs 补齐:让 readState 合并 fence 里的 previousWave/currentWave 覆写。
    transitionStage(root, 'dev', 'dev');
  });
});

test('AC-6 · 跨 stage 正常推进不 throw', () => {
  const root = makeTempRoot({
    pipeline: 'full', activeChange: 't', currentStage: 'design',
    currentWave: null, currentTask: null, activeAgent: 'architect',
    autonomous: true, stagesRun: 1, maxStages: 10, retries: 0, maxRetries: 3,
    verifyFailCount: 0, contextUsage: {},
  });
  assert.doesNotThrow(() => transitionStage(root, 'design', 'task'));
  const after = readState(root);
  assert.equal(after.currentStage, 'task');
  assert.equal(after.activeAgent, 'planner'); // getAgentForStage('task') === 'planner'
});
