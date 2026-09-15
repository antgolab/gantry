// learnings 维护器：扫描 team 作用域，识别高价值（promotion）与过期（archive）条目。
//
// maintain({promoteThreshold, archiveDays, rebuildIndex, autoConfirm, baseDir})
//   - 扫描 team/*.md 收集 {id, hitCount, lastHitAt}
//   - promotion：hitCount >= promoteThreshold（仅返回候选，不写盘）
//   - archive：lastHitAt 早于 now - archiveDays 天（autoConfirm=true 时执行 move）
//   - autoConfirm=false：只返回候选清单，code='maintenance_no_op'，交 CLI 层处理交互
//   - rebuildIndex=true（且 autoConfirm=true）：用 team 全文重建 bm25 索引
//   - baseDir 默认 .gantry/learnings/，允许测试注入 tmpdir
import { join } from 'node:path';
import { createStore } from './store.mjs';
import { buildIndex, saveIndex } from './bm25.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

// 从 team 列表读取正文 + tags，组装为 bm25 buildIndex 需要的 {id, text, tags}。
async function collectSearchDocs(store) {
  const entries = await store.list('team');
  const docs = [];
  for (const { id, frontmatter } of entries) {
    const full = await store.read('team', id);
    docs.push({
      id,
      text: full ? full.body : '',
      tags: Array.isArray(frontmatter?.tags) ? frontmatter.tags : [],
    });
  }
  return docs;
}

export async function maintain({
  promoteThreshold = 3,
  archiveDays = 90,
  rebuildIndex = false,
  autoConfirm = false,
  baseDir,
} = {}) {
  const root = baseDir ?? join(process.cwd(), '.gantry', 'learnings');
  const store = createStore(root);

  // (a) 扫描 team/*.md 收集 {id, hitCount, lastHitAt}
  const now = Date.now();
  const archiveCutoff = now - archiveDays * DAY_MS;
  const promoted = [];
  const archived = [];

  for (const { id, frontmatter } of await store.list('team')) {
    const hitCount = Number(frontmatter?.hitCount ?? 0);
    const lastHitAt = frontmatter?.lastHitAt ?? null;
    const entry = { id, hitCount, lastHitAt };

    // (b) 分类
    if (hitCount >= promoteThreshold) promoted.push(entry);
    if (lastHitAt != null && Date.parse(lastHitAt) < archiveCutoff) archived.push(entry);
  }

  // autoConfirm=false：不写盘，返回候选清单交 CLI 层处理交互。
  if (!autoConfirm) {
    return { code: 'maintenance_no_op', promoted, archived, indexRebuilt: false };
  }

  let indexRebuilt = false;

  // (d) archive：remove('team') + write('_archive')，保留 frontmatter 并补 archivedAt。
  for (const { id } of archived) {
    const full = await store.read('team', id);
    if (!full) continue;
    await store.remove('team', id);
    await store.write('_archive', {
      ...full.frontmatter,
      body: full.body,
      archivedAt: new Date().toISOString(),
    });
  }

  // (e) rebuildIndex：team 全量重建 bm25 索引并落盘。
  if (rebuildIndex) {
    const index = buildIndex(await collectSearchDocs(store));
    saveIndex(index, join(root, 'team', '.index', 'bm25.json'));
    indexRebuilt = true;
  }

  const code =
    archived.length > 0
      ? 'maintenance_archived'
      : promoted.length > 0
        ? 'maintenance_promoted'
        : 'maintenance_no_op';

  return { code, promoted, archived, indexRebuilt };
}
