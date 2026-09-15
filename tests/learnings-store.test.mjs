import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/lib/learnings/store.mjs';

let root;
let store;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'learnings-store-'));
  store = createStore(root);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('learnings store 双作用域', () => {
  it('write → read 往返（team）', async () => {
    await store.write('team', { id: 't-1', body: 'team body', tags: ['a', 'b'], source: 'LESSONS.md' });
    const r = await store.read('team', 't-1');
    assert.ok(r);
    assert.equal(r.body, 'team body');
    assert.equal(r.frontmatter.id, 't-1');
    assert.equal(r.frontmatter.scope, 'team');
    assert.equal(r.frontmatter.source, 'LESSONS.md');
    assert.deepEqual(r.frontmatter.tags, ['a', 'b']);
  });

  it('write → read 往返（private）', async () => {
    await store.write('private', { id: 'p-1', body: 'private body', tags: ['secret'] });
    const r = await store.read('private', 'p-1');
    assert.ok(r);
    assert.equal(r.body, 'private body');
    assert.equal(r.frontmatter.scope, 'private');
    assert.deepEqual(r.frontmatter.tags, ['secret']);
  });

  it('write 自动补齐 createdAt/hitCount/lastHitAt/scope', async () => {
    await store.write('team', { id: 'auto', body: 'x' });
    const r = await store.read('team', 'auto');
    assert.ok(r);
    assert.equal(typeof r.frontmatter.createdAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(r.frontmatter.createdAt)), 'createdAt 应为合法 ISO 时间');
    assert.equal(r.frontmatter.hitCount, 0);
    assert.equal(r.frontmatter.lastHitAt, null);
    assert.equal(r.frontmatter.scope, 'team');
  });

  it('write 保留已有 createdAt', async () => {
    await store.write('team', { id: 'keep', body: 'x', createdAt: '2026-09-14T10:00:00Z' });
    const r = await store.read('team', 'keep');
    assert.equal(r.frontmatter.createdAt, '2026-09-14T10:00:00Z');
  });

  it('list 返回 [{id, frontmatter}] 并支持 tag filter', async () => {
    await store.write('team', { id: 'l-1', body: '1', tags: ['x'] });
    await store.write('team', { id: 'l-2', body: '2', tags: ['y'] });

    const all = await store.list('team');
    const ids = all.map((e) => e.id).sort();
    assert.ok(ids.includes('l-1') && ids.includes('l-2'), '应包含写入的两条记录');
    assert.ok(all.every((e) => typeof e.id === 'string' && e.frontmatter), '每项含 id 与 frontmatter');

    const filtered = await store.list('team', { tag: 'x' });
    assert.deepEqual(filtered.map((e) => e.id), ['l-1']);
  });

  it('remove 存在返回 true, 不存在返回 false', async () => {
    await store.write('team', { id: 'r-1', body: 'x' });
    assert.equal(await store.remove('team', 'r-1'), true);
    assert.equal(await store.read('team', 'r-1'), null);
    assert.equal(await store.remove('team', 'r-1'), false);
  });

  it('read 不存在返回 null', async () => {
    assert.equal(await store.read('private', 'nope'), null);
  });

  it('原子写:中途异常不留 .tmp 半成品', async () => {
    const dir = join(root, 'team');
    // 用同名目录占位, 使 rename 落盘失败, 触发异常分支
    await mkdir(join(dir, 'conflict.md'), { recursive: true });
    await assert.rejects(() => store.write('team', { id: 'conflict', body: 'x' }));
    const entries = await readdir(dir);
    assert.ok(!entries.some((n) => n.startsWith('.tmp-')), '不应遗留 .tmp 半成品');
    await rm(join(dir, 'conflict.md'), { recursive: true, force: true });
  });

  it('bm25.mjs 不存在时 write 不抛异常', async () => {
    await assert.doesNotReject(() => store.write('team', { id: 'no-bm25', body: 'x' }));
  });
});
