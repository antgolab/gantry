import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../src/lib/learnings/migrator.mjs';
import { createStore } from '../src/lib/learnings/store.mjs';

const LESSONS = `# LESSONS

## 标签索引

- \`arch\` 架构决策类

---

## L-001 · [arch] 主题切换不要用 useEffect

- **首发**: add-dark-mode · T03 · 2026-04-30
- **状态**: active

问题场景
深色模式恢复主题。

## L-002 · [data] 迁移要幂等

- **首发**: small-team-mode · T11 · 2026-09-14

问题场景
知识库归并。
`;

describe('learnings migrator 幂等一次性迁移', () => {
  const roots = [];
  after(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  });

  const makeSpecs = async () => {
    const root = await mkdtemp(join(tmpdir(), 'knowledge-migrate-'));
    roots.push(root);
    const specsDir = join(root, 'specs');
    await mkdir(specsDir, { recursive: true });
    return { root, specsDir, learnings: join(root, 'learnings') };
  };

  it('首次迁移：LESSONS 分块 + knowledge/*.md → team/，frontmatter 完整', async () => {
    const { specsDir, learnings } = await makeSpecs();
    await writeFile(join(specsDir, 'LESSONS.md'), LESSONS, 'utf8');
    await mkdir(join(specsDir, 'knowledge'), { recursive: true });
    await writeFile(join(specsDir, 'knowledge', 'deploy-checklist.md'), '# 部署清单\n\n- 检查回滚脚本\n', 'utf8');
    await writeFile(join(specsDir, 'knowledge', 'review-rubric.md'), '# 评审标准\n', 'utf8');

    const res = await migrate({ baseDir: specsDir });

    assert.equal(res.code, 'migration_completed');
    assert.ok(res.written.includes('team/L-001.md'));
    assert.ok(res.written.includes('team/L-002.md'));
    assert.ok(res.written.includes('team/deploy-checklist.md'));
    assert.ok(res.written.includes('team/review-rubric.md'));

    const store = createStore(learnings);

    const l1 = await store.read('team', 'L-001');
    assert.ok(l1, 'L-001 应已生成');
    assert.equal(l1.frontmatter.id, 'L-001');
    assert.deepEqual(l1.frontmatter.tags, ['lesson']);
    assert.equal(l1.frontmatter.source, '.gantry/specs/LESSONS.md');
    assert.equal(l1.frontmatter.scope, 'team');
    assert.ok(l1.body.includes('问题场景'));
    assert.ok(l1.body.includes('深色模式恢复主题。'));

    const l2 = await store.read('team', 'L-002');
    assert.equal(l2.frontmatter.id, 'L-002');
    assert.deepEqual(l2.frontmatter.tags, ['lesson']);

    const k1 = await store.read('team', 'deploy-checklist');
    assert.deepEqual(k1.frontmatter.tags, ['knowledge']);
    assert.equal(k1.frontmatter.source, '.gantry/specs/knowledge/deploy-checklist.md');
    assert.ok(k1.body.includes('部署清单'));

    const lessonsRaw = await readFile(join(specsDir, 'LESSONS.md'), 'utf8');
    assert.ok(lessonsRaw.includes('> MIGRATED to .gantry/learnings/'));
  });

  it('二次调用幂等：migration_idempotent、无重复写、提示不重复', async () => {
    const { specsDir, learnings } = await makeSpecs();
    await writeFile(join(specsDir, 'LESSONS.md'), LESSONS, 'utf8');

    await migrate({ baseDir: specsDir });
    const res2 = await migrate({ baseDir: specsDir });

    assert.equal(res2.code, 'migration_idempotent');
    assert.equal(res2.written.length, 0);
    assert.equal(res2.skipped.length, 2);

    const entries = (await readdir(join(learnings, 'team'))).filter((n) => n.endsWith('.md'));
    assert.deepEqual(entries.sort(), ['L-001.md', 'L-002.md']);

    const lessonsRaw = await readFile(join(specsDir, 'LESSONS.md'), 'utf8');
    assert.equal(lessonsRaw.split('> MIGRATED to .gantry/learnings/').length - 1, 1);
  });

  it('dryRun=true：不落盘、written 非空、不改老文件提示', async () => {
    const { specsDir, learnings } = await makeSpecs();
    await writeFile(join(specsDir, 'LESSONS.md'), LESSONS, 'utf8');

    const res = await migrate({ baseDir: specsDir, dryRun: true });

    assert.equal(res.code, 'migration_completed');
    assert.ok(res.written.includes('team/L-001.md'));
    assert.ok(res.written.includes('team/L-002.md'));

    const store = createStore(learnings);
    assert.equal(await store.read('team', 'L-001'), null);

    const lessonsRaw = await readFile(join(specsDir, 'LESSONS.md'), 'utf8');
    assert.ok(!lessonsRaw.includes('MIGRATED to .gantry/learnings/'));
  });

  it('knowledge/ 不存在：仅处理 LESSONS.md，不报错', async () => {
    const { specsDir, learnings } = await makeSpecs();
    await writeFile(join(specsDir, 'LESSONS.md'), LESSONS, 'utf8');

    const res = await migrate({ baseDir: specsDir });

    assert.equal(res.code, 'migration_completed');
    assert.deepEqual(res.written.sort(), ['team/L-001.md', 'team/L-002.md']);

    const store = createStore(learnings);
    assert.ok(await store.read('team', 'L-001'));
    assert.ok(await store.read('team', 'L-002'));
  });

  it('LESSONS.md 与 knowledge/ 均不存在：返回 migration_idempotent', async () => {
    const { specsDir } = await makeSpecs();
    const res = await migrate({ baseDir: specsDir });
    assert.equal(res.code, 'migration_idempotent');
    assert.deepEqual(res.written, []);
    assert.deepEqual(res.skipped, []);
  });
});
