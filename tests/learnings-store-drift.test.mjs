/**
 * learnings-store-drift.test.mjs — T04 learnings store bm25 索引失败显式告警 (AC-3)
 *
 * 通过 registerHooks 的 load hook 拦截 store.mjs 内部动态 import('./bm25.mjs'),
 * 把 addDoc 替换为 throw, 制造索引更新失败路径。验证:
 *   - md 文件已落盘 (AC-3 Then #1)
 *   - stderr 捕获到 `[learnings] bm25 index update failed for team/L-TEST: <err.message>` (AC-3 Then #2)
 *   - .gantry/learnings/team/.friction/ 下有 kind=learnings-index-drift 事件 (AC-3 Then #3)
 *   - store.write 本身不抛错 (AC-3 Then #4)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/lib/learnings/store.mjs';

const bm25Url = new URL('../src/lib/learnings/bm25.mjs', import.meta.url).href;

// 拦截 store.mjs 的动态 import('./bm25.mjs'), 返回抛错的 mock addDoc。
registerHooks({
  load(url, context, nextLoad) {
    if (url === bm25Url) {
      return {
        format: 'module',
        source: 'export function addDoc() { throw new Error("bm25 boom"); }',
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

test('bm25.addDoc 抛错 → md 落盘 + stderr 告警 + drift event + 不抛', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learnings-drift-'));
  try {
    const store = createStore(root);

    // 捕获 stderr 以断言告警消息
    let stderr = '';
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderr += String(chunk);
      return origWrite(chunk, ...rest);
    };

    let result;
    try {
      result = await store.write('team', { id: 'L-TEST', body: 'hello' });
    } finally {
      process.stderr.write = origWrite;
    }

    // Then #4: store.write 不抛错, 返回语义不变
    assert.equal(result.id, 'L-TEST');
    assert.equal(result.body, 'hello');
    assert.equal(result.frontmatter.scope, 'team');

    // Then #1: md 文件已落盘
    const md = await readFile(join(root, 'team', 'L-TEST.md'), 'utf8');
    assert.ok(md.includes('hello'), 'md 应包含 body 内容');

    // Then #2: stderr 告警
    assert.ok(
      stderr.includes('[learnings] bm25 index update failed for team/L-TEST: bm25 boom'),
      `stderr 应包含告警, 实际: ${stderr}`,
    );

    // Then #3: drift event 已记录
    const eventsRaw = await readFile(join(root, 'team', '.friction', 'events.jsonl'), 'utf8');
    const events = eventsRaw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const drift = events.find((e) => e.kind === 'learnings-index-drift');
    assert.ok(drift, '应存在 kind=learnings-index-drift 事件');
    assert.equal(drift.scope, 'team');
    assert.equal(drift.id, 'L-TEST');
    assert.equal(drift.message, 'bm25 boom');
    assert.equal(typeof drift.timestamp, 'string');
    assert.ok(!Number.isNaN(Date.parse(drift.timestamp)), 'timestamp 应为合法 ISO 时间');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
