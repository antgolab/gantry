/**
 * knowledge-execution-contract.test.mjs
 *
 * 这里测的不是 context-pack 加载路径,而是 DEV 阶段提示词对执行结果的约束:
 * 给定真实 4-dev.md prompt + 知识库输入 + agent 产出的执行结果,结果必须留下可审计证据。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DEV_PROMPT = readFileSync(join(ROOT, 'phases/4-dev.md'), 'utf-8');

function activeLessonIds(lessonsText, taskKeywords) {
  return lessonsText
    .split(/(?=^##\s+L-\d+)/m)
    .filter(block => /^##\s+L-\d+/m.test(block))
    .filter(block => /状态[::]\s*active/.test(block))
    .filter(block => taskKeywords.some(keyword => block.includes(keyword)))
    .map(block => block.match(/^##\s+(L-\d+)/m)?.[1])
    .filter(Boolean);
}

function validateDevKnowledgeResult({ prompt, taskKeywords = [], context = '', manifest = '', lessons = '', knowledge = '', result }) {
  assert.match(prompt, /1\.5 消费团队知识 \+ 扫 LESSONS/, 'DEV prompt 必须包含知识消费段');
  assert.match(prompt, /已查阅 L-NNN，本次方案与之差异是 X/, 'DEV prompt 必须要求 LESSONS 差异说明');
  assert.match(prompt, /声明「本任务走 <正确路径>」/, 'DEV prompt 必须要求 MANIFEST 兜底路由声明');

  for (const id of activeLessonIds(lessons, taskKeywords)) {
    const line = new RegExp(`已查阅\\s+${id}[^\\n]*(本次方案与之差异是|本次确认仍适用)`);
    assert.match(result, line, `执行结果缺少 ${id} 的查阅/差异说明`);
  }

  if (manifest.includes('[必须]') && !taskKeywords.some(k => /走|生成|按/.test(k))) {
    assert.match(result, /本任务走\s+\S+/, 'MANIFEST 兜底命中时,执行结果必须声明本任务走哪条正确路径');
  }

  if (/不直接\s*fetch|禁用\s*fetch/.test(context)) {
    assert.doesNotMatch(result, /\bfetch\s*\(/, 'CONTEXT 禁动清单禁止直接 fetch');
  }

  if (knowledge.trim()) {
    const knowledgeTitle = knowledge.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (knowledgeTitle) {
      assert.ok(true, 'knowledge/*.md 只是调研资料,未提升进 CONTEXT/LESSONS/TASK 时不强制执行结果引用');
    }
  }
}

test('prompt-result: 命中 active LESSONS 时,执行结果必须写明已查阅和方案差异', () => {
  const lessons = `# LESSONS

## L-001 T01 支付回调不要重复消费
- 状态: active
- 关键词: T01 payment callback
- 为什么不行: 直接按回调次数加账会重复入账
- 当前推荐做法: 使用幂等键
`;

  const goodResult = `## 执行计划

- 已查阅 L-001,本次方案与之差异是: 使用 order_id 幂等键,先查 callback_log 再入账。
- 实现 payment callback handler。
`;

  const badResult = `## 执行计划

- 实现 payment callback handler。
`;

  assert.doesNotThrow(() => validateDevKnowledgeResult({
    prompt: DEV_PROMPT,
    taskKeywords: ['T01', 'payment'],
    lessons,
    result: goodResult,
  }));
  assert.throws(() => validateDevKnowledgeResult({
    prompt: DEV_PROMPT,
    taskKeywords: ['T01', 'payment'],
    lessons,
    result: badResult,
  }), /缺少 L-001/);
});

test('prompt-result: .context/MANIFEST 兜底命中时,执行结果必须声明正确路径', () => {
  const manifest = `# MANIFEST

## 缓存回源

[必须] 缓存回源走 btsgen 生成链路
`;

  const goodResult = `## 执行计划

- 本任务走 btsgen 生成缓存回源链路。
- 按生成产物补齐调用方。
`;

  const badResult = `## 执行计划

- 自行新增 cache client。
`;

  assert.doesNotThrow(() => validateDevKnowledgeResult({
    prompt: DEV_PROMPT,
    taskKeywords: ['缓存回源'],
    manifest,
    result: goodResult,
  }));
  assert.throws(() => validateDevKnowledgeResult({
    prompt: DEV_PROMPT,
    taskKeywords: ['缓存回源'],
    manifest,
    result: badResult,
  }), /必须声明本任务走/);
});

test('prompt-result: CONTEXT 禁动清单必须约束最终实现结果', () => {
  const context = `# CONTEXT

## 禁动清单

- 不直接 fetch,统一使用 src/lib/httpClient.ts
`;

  const goodResult = `## 实现摘要

- 沿用 src/lib/httpClient.ts。

\`\`\`ts
return httpClient.get('/api/user');
\`\`\`
`;

  const badResult = `## 实现摘要

\`\`\`ts
return fetch('/api/user');
\`\`\`
`;

  assert.doesNotThrow(() => validateDevKnowledgeResult({
    prompt: DEV_PROMPT,
    context,
    result: goodResult,
  }));
  assert.throws(() => validateDevKnowledgeResult({
    prompt: DEV_PROMPT,
    context,
    result: badResult,
  }), /禁止直接 fetch/);
});

test('prompt-result: knowledge 条目未提升时,执行结果不需要引用它', () => {
  const knowledge = `# Redis 缓存方案调研

status: captured

结论: 可作为后续方案输入,但尚未提升为项目规则。
`;

  const result = `## 执行计划

- 按 TASKS.md 当前 action 实现本任务。
`;

  assert.doesNotThrow(() => validateDevKnowledgeResult({
    prompt: DEV_PROMPT,
    knowledge,
    result,
  }));
});
