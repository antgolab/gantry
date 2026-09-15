import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildIndex,
  saveIndex,
  loadIndex,
  addDoc,
  removeDoc,
  query,
} from '../src/lib/learnings/bm25.mjs';

const SEED = [
  {
    id: 'L-001',
    text: 'bm25 recall injection normalizes scores and filters unrelated learnings before context packing',
    tags: ['lesson', 'search'],
  },
  {
    id: 'L-002',
    text: 'gantry dev tasks require atomic commits for every change',
    tags: ['lesson', 'git'],
  },
  {
    id: 'L-003',
    text: 'bm25 is a probabilistic ranking algorithm for document retrieval',
    tags: ['knowledge', 'search'],
  },
];

const tmpIndexPath = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-')), 'bm25.json');

test('buildIndex 后 query 命中相关条目并附 score/matched 结构', () => {
  const idx = buildIndex(SEED);
  const results = query(idx, 'bm25 recall injection filters learnings packing');

  assert.ok(results.length > 0, '应至少命中一条');
  assert.equal(results[0].id, 'L-001', '最相关条目应为 L-001');
  assert.ok(results[0].score >= 0.3 && results[0].score <= 1, 'score 应归一化到 [0,1]');

  for (const r of results) {
    assert.equal(typeof r.id, 'string');
    assert.equal(typeof r.score, 'number');
    assert.ok(Array.isArray(r.matched), 'matched 应为数组');
    assert.ok(r.matched.every((w) => typeof w === 'string'));
  }
});

test('matched 是 query 与 doc 的标准化交集词', () => {
  const idx = buildIndex(SEED);
  const q = 'bm25 recall injection filters learnings packing';
  const [top] = query(idx, q);

  assert.ok(top.matched.length > 0, 'matched 非空');
  assert.ok(top.matched.includes('bm25'), 'matched 含 query 与 doc 共有词 bm25');
  assert.ok(top.matched.includes('recall'), 'matched 含 query 与 doc 共有词 recall');

  // 每个 matched 词都应同时出现在 query 与 L-001 正文（大小写不敏感子串校验）。
  const docText = (SEED[0].text + ' ' + SEED[0].tags.join(' ')).toLowerCase();
  const qLower = q.toLowerCase();
  for (const w of top.matched) {
    assert.ok(qLower.includes(w), `matched 词 '${w}' 应来自 query`);
    assert.ok(docText.includes(w), `matched 词 '${w}' 应来自 doc`);
  }
});

test('relevanceMin=0.3 下不相关条目被过滤', () => {
  const idx = buildIndex(SEED);
  const q = 'bm25 recall injection filters learnings packing';
  const results = query(idx, q, { relevanceMin: 0.3, topK: 5 });
  const ids = results.map((r) => r.id);

  assert.ok(ids.includes('L-001'), '相关条目保留');
  assert.ok(!ids.includes('L-003'), '仅共享 bm25 一词的 L-003 被过滤');
  assert.ok(!ids.includes('L-002'), '无词元重叠的 L-002 不出现');
});

test('saveIndex → loadIndex 往返后可查询', () => {
  const idx = buildIndex(SEED);
  const p = tmpIndexPath();
  saveIndex(idx, p);

  const loaded = loadIndex(p);
  const results = query(loaded, 'bm25 recall injection filters learnings packing');
  assert.equal(results[0].id, 'L-001', '往返后查询命中一致');
  assert.ok(results[0].matched.includes('bm25'));
});

test('addDoc 后新文档可命中', () => {
  const idx = buildIndex(SEED);
  addDoc(idx, { id: 'L-004', text: 'review lane isolation uses loadorder whitelist', tags: ['lesson', 'review'] });

  const results = query(idx, 'review lane isolation whitelist');
  assert.equal(results[0].id, 'L-004', '新文档命中');
});

test('removeDoc 后老文档不再命中', () => {
  const idx = buildIndex(SEED);
  removeDoc(idx, 'L-002');

  const results = query(idx, 'atomic commits change');
  assert.ok(!results.some((r) => r.id === 'L-002'), 'L-002 被移除后不再命中');
});
