// 纯 JS BM25 索引与检索门面（封装 wink-bm25-text-search，MIT，无原生 binding）。
//
// score 归一化策略：wink 的 search() 返回的 BM25 分是绝对值，会随语料规模与
// 查询长度漂移，无法直接与 relevanceMin=0.3 比较。因此每次 query 内以该次查询
// 的 top-1 原始分作 1.0，对所有命中做线性归一化（norm = raw / top1），再过滤
// norm < relevanceMin。好处：relevanceMin 语义稳定为「相对最强命中的比例阈值」，
// 跨查询、跨语料可比较（ADR-005 的 keyword-overlap 阈值 0.3 即基于此语义）。
//
// removeDoc 策略：wink-bm25-text-search 原生不支持删除（consolidate 后 addDoc
// 也会抛错）。因此本门面把 docs 注册表（Map<id, {id, text, tags}>）作为唯一事实源，
// addDoc / removeDoc 均先改注册表、再整体重建引擎（≤500 条规模 <300ms，DESIGN § D7
// 性能预算内）。持久化同时写 wink 模型（engine.exportJSON()）与 docs 注册表，
// load 时二者还原，故加载后仍可继续 addDoc / removeDoc。

import bm25 from 'wink-bm25-text-search';
import fs from 'node:fs';
import path from 'node:path';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'in',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were', 'will',
  'with', 'before', 'after', 'each', 'every', 'this', 'these', 'those',
]);

// 标准化 token 管道：小写 → 按非字母数字切分 → 过滤单字符与停用词。
// 同时用于 wink 的 prep task（索引/查询）与 matched 交集计算，保证两端词元一致。
const tokenize = (text) =>
  String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

// 文档的可检索文本 = 正文 + tags 拼接，tags 也参与检索（ADR-003 tags 区分类别不缩小检索面）。
const searchText = (doc) => [doc.text, ...(doc.tags || [])].filter(Boolean).join(' ');

const normalizeDoc = (doc) => ({
  id: doc.id,
  text: String(doc.text ?? ''),
  tags: Array.isArray(doc.tags) ? doc.tags : [],
});

const freshEngine = () => {
  const engine = bm25();
  engine.defineConfig({ fldWeights: { text: 1 } });
  engine.definePrepTasks([tokenize]);
  return engine;
};

// 从 docs 注册表全量重建引擎（配置 → 挂 token 管道 → 逐条 addDoc → consolidate）。
// wink 要求 totalDocs ≥ 3 才允许 consolidate，故 <3 条时不 consolidate，交由
// query() 走词元重叠退化打分路径（见下）。
const buildEngine = (docs) => {
  const engine = freshEngine();
  for (const doc of docs.values()) engine.addDoc({ text: searchText(doc) }, doc.id);
  if (docs.size >= 3) engine.consolidate();
  return engine;
};

// 返回按 raw 分降序的 [{id, raw}]。≥3 条走 wink BM25 绝对分；<3 条退化用词元重叠数。
const rank = (indexInstance, text) => {
  const docs = [...indexInstance.docs.values()];
  if (docs.length >= 3) {
    return indexInstance.engine.search(text, docs.length).map(([id, raw]) => ({ id, raw }));
  }
  const queryTokens = new Set(tokenize(text));
  return docs
    .map((doc) => {
      const docTokens = new Set(tokenize(searchText(doc)));
      const overlap = [...queryTokens].filter((t) => docTokens.has(t)).length;
      return { id: doc.id, raw: overlap };
    })
    .filter((r) => r.raw > 0)
    .sort((a, b) => b.raw - a.raw);
};

class IndexInstance {
  constructor(docs = new Map(), engine = null) {
    this.docs = docs; // Map<id, {id, text, tags}> —— 唯一事实源
    this.engine = engine; // wink 引擎（已 consolidate，可直接 search）
  }

  // 输出字符串：wink 模型（engine.exportJSON()）+ docs 注册表，一并持久化。
  exportJSON() {
    return JSON.stringify({
      version: 1,
      model: this.engine ? this.engine.exportJSON() : null,
      docs: [...this.docs.values()],
    });
  }

  // 从持久化 JSON 还原：wink 模型经 importJSON 恢复，docs 注册表还原。
  static importJSON(json) {
    const parsed = JSON.parse(json);
    const docs = new Map();
    for (const doc of parsed.docs || []) docs.set(doc.id, doc);
    let engine;
    if (typeof parsed.model === 'string') {
      engine = bm25();
      engine.importJSON(parsed.model);
      engine.definePrepTasks([tokenize]); // importJSON 后需重挂 prep 管道才能 search
    } else {
      engine = buildEngine(docs); // 无 model 的兜底（空/旧格式索引）
    }
    return new IndexInstance(docs, engine);
  }
}

export function buildIndex(docs = []) {
  const map = new Map();
  for (const doc of docs) map.set(doc.id, normalizeDoc(doc));
  return new IndexInstance(map, buildEngine(map));
}

export function saveIndex(indexInstance, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, indexInstance.exportJSON());
  return filePath;
}

export function loadIndex(filePath) {
  return IndexInstance.importJSON(fs.readFileSync(filePath, 'utf8'));
}

export function addDoc(indexInstance, doc) {
  indexInstance.docs.set(doc.id, normalizeDoc(doc));
  indexInstance.engine = buildEngine(indexInstance.docs);
  return indexInstance;
}

export function removeDoc(indexInstance, id) {
  indexInstance.docs.delete(id);
  indexInstance.engine = buildEngine(indexInstance.docs);
  return indexInstance;
}

export function query(indexInstance, text, { relevanceMin = 0.3, topK = 5 } = {}) {
  if (!indexInstance.docs.size) return [];
  const ranked = rank(indexInstance, text);
  const top = ranked.length > 0 ? ranked[0].raw : 0;
  const queryTokens = new Set(tokenize(text));
  const results = [];
  for (const { id, raw } of ranked) {
    const norm = top > 0 ? raw / top : 0;
    if (norm < relevanceMin) continue;
    const doc = indexInstance.docs.get(id);
    const docTokens = new Set(tokenize(searchText(doc)));
    results.push({
      id,
      score: norm,
      matched: [...queryTokens].filter((t) => docTokens.has(t)),
    });
    if (results.length >= topK) break;
  }
  return results;
}
