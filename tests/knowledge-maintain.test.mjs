import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/lib/learnings/store.mjs';
import { maintain } from '../src/lib/learnings/maintainer.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgoISO = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

const mkRoot = () => mkdtemp(join(tmpdir(), 'maintain-'));

describe('learnings maintainer', () => {
  it('hitCount >= promoteThreshold 的条目列入 promoted 候选', async () => {
    const root = await mkRoot();
    try {
      const store = createStore(root);
      await store.write('team', { id: 'hot', body: 'x', hitCount: 5, lastHitAt: daysAgoISO(1) });
      await store.write('team', { id: 'cold', body: 'y', hitCount: 1, lastHitAt: daysAgoISO(1) });

      const res = await maintain({ promoteThreshold: 3, baseDir: root });

      const ids = res.promoted.map((e) => e.id);
      assert.ok(ids.includes('hot'), 'hitCount=5 应列入 promoted');
      assert.ok(!ids.includes('cold'), 'hitCount=1 不应列入 promoted');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lastHitAt 早于 archiveDays 的条目列入 archived 候选', async () => {
    const root = await mkRoot();
    try {
      const store = createStore(root);
      await store.write('team', { id: 'stale', body: 'x', lastHitAt: daysAgoISO(100) });
      await store.write('team', { id: 'fresh', body: 'y', lastHitAt: daysAgoISO(1) });

      const res = await maintain({ archiveDays: 90, baseDir: root });

      const ids = res.archived.map((e) => e.id);
      assert.ok(ids.includes('stale'), '100 天前命中应列入 archived');
      assert.ok(!ids.includes('fresh'), '1 天前命中不应列入 archived');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('autoConfirm=true 时 archive 目标从 team/ 移到 _archive/', async () => {
    const root = await mkRoot();
    try {
      const store = createStore(root);
      await store.write('team', { id: 'stale', body: 'old body', hitCount: 2, lastHitAt: daysAgoISO(100) });

      const res = await maintain({ autoConfirm: true, archiveDays: 90, baseDir: root });

      assert.equal(res.code, 'maintenance_archived');
      assert.deepEqual(res.archived.map((e) => e.id), ['stale']);
      assert.equal(await store.read('team', 'stale'), null, 'team/ 应移除');
      const archived = await store.read('_archive', 'stale');
      assert.ok(archived, '_archive/ 应有副本');
      assert.equal(archived.body, 'old body', '正文保留');
      assert.equal(archived.frontmatter.scope, '_archive', 'scope 应为 _archive');
      assert.equal(archived.frontmatter.hitCount, 2, 'hitCount 保留');
      assert.equal(typeof archived.frontmatter.archivedAt, 'string', '应补 archivedAt 时间戳');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('autoConfirm=false 时不写盘, 返回候选清单', async () => {
    const root = await mkRoot();
    try {
      const store = createStore(root);
      await store.write('team', { id: 'stale', body: 'x', lastHitAt: daysAgoISO(100) });

      const res = await maintain({ autoConfirm: false, archiveDays: 90, baseDir: root });

      assert.equal(res.code, 'maintenance_no_op');
      assert.deepEqual(res.archived.map((e) => e.id), ['stale'], '返回候选但不执行');
      assert.ok(await store.read('team', 'stale'), 'team/ 原文件应保留');
      assert.equal(await store.read('_archive', 'stale'), null, '_archive/ 不应有副本');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rebuildIndex=true 触发 bm25 全量重建并落盘 bm25.json', async () => {
    const root = await mkRoot();
    try {
      const store = createStore(root);
      await store.write('team', { id: 'a', body: 'bm25 rebuild recall', tags: ['lesson'] });

      const res = await maintain({ autoConfirm: true, rebuildIndex: true, baseDir: root });

      assert.equal(res.indexRebuilt, true);
      const indexPath = join(root, 'team', '.index', 'bm25.json');
      const raw = await readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.version, 1, 'bm25.json 应为有效索引');
      const ids = (parsed.docs ?? []).map((d) => d.id);
      assert.ok(ids.includes('a'), '索引应包含 team 文档');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('无候选时返回 maintenance_no_op', async () => {
    const root = await mkRoot();
    try {
      const store = createStore(root);
      await store.write('team', { id: 'ok', body: 'x', hitCount: 0, lastHitAt: daysAgoISO(1) });

      const res = await maintain({ autoConfirm: true, baseDir: root });

      assert.equal(res.code, 'maintenance_no_op');
      assert.equal(res.promoted.length, 0);
      assert.equal(res.archived.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
