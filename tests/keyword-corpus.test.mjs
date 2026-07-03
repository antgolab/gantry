/**
 * keyword-corpus.test.mjs — 关键词判定语料回归网
 *
 * 定位（务实,非刷分）：锁定「典型正例必中 + 已知误报不复发」,
 * 防止 UI/schema/breaking 关键词表被后续改动悄悄退化。
 * 不追求召回率 100%（自然语言无穷,固定词表必漏——漏判由 schema v2
 * 非对称信任的 confidence=low + AI 复核兜底,不在此测）。
 *
 * 加语料只需往下面数组加一行。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction } from '../src/lib/context-pack.mjs';

// 典型正例：这些描述必须命中对应类别（词表退化会在此报警）
const POSITIVES = [
  ['把主色调改成深色主题', 'ui'],
  ['调整卡片圆角和阴影', 'ui'],
  ['add a modal dialog for confirmation', 'ui'],
  ['change the button font', 'ui'],
  ['给 users 表新增表结构里的 email', 'schema'],  // 含"新增表"
  ['add column phone to accounts', 'schema'],
  ['create a prisma migration', 'schema'],
  ['删除废弃的 formatDate 函数', 'breaking'],
  ['remove the legacy export', 'breaking'],
  ['rename the public api endpoint', 'breaking'],
];

// 已知误报：这些描述不得命中对应类别（缺陷一子串误判的回归防线）
const NEGATIVES = [
  ['confront the performance issue', 'ui'],       // confront ⊃ font
  ['refactor the iconic legacy module', 'ui'],    // iconic ⊃ icon
  ['delegate the task to worker', 'breaking'],    // delegate ⊃ dele…（非 delete 词）
  ['implement pagination logic', 'schema'],       // 无 schema 词
  ['optimize query performance', 'schema'],       // query 不是 schema 关键词
  ['add retry to the http client', 'breaking'],   // 无破坏性词
];

test('关键词语料：典型正例必中', () => {
  for (const [action, cat] of POSITIVES) {
    const r = classifyAction(action);
    assert.equal(r[cat], true, `正例应命中 ${cat}: "${action}"`);
  }
});

test('关键词语料：已知误报不复发', () => {
  for (const [action, cat] of NEGATIVES) {
    const r = classifyAction(action);
    assert.equal(r[cat], false, `不应误报 ${cat}: "${action}"`);
  }
});
