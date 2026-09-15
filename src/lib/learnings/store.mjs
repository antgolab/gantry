// learnings 双作用域存储 facade：team / private / _archive。
// 路径规则：.gantry/learnings/{scope}/{id}.md。
// write 原子落盘（临时文件 + rename），并 optional lazy 同步 bm25 索引（T06 就绪前静默跳过）。
import { mkdir, writeFile, readFile, rename, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse, stringify } from './frontmatter.mjs';

const VALID_SCOPES = new Set(['team', 'private', '_archive']);

const tmpName = () => `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;

export function createStore(root) {
  const dirFor = (scope) => join(root, scope);

  async function write(scope, doc) {
    if (!VALID_SCOPES.has(scope)) throw new Error(`unknown scope: ${scope}`);
    if (!doc || !doc.id) throw new Error('doc.id is required');

    const dir = dirFor(scope);
    await mkdir(dir, { recursive: true });

    const { id, body = '', tags = [], source, ...rest } = doc;
    const frontmatter = {
      ...rest,
      id,
      tags,
      ...(source != null ? { source } : {}),
      createdAt: rest.createdAt ?? new Date().toISOString(),
      hitCount: rest.hitCount ?? 0,
      lastHitAt: rest.lastHitAt ?? null,
      scope,
    };

    const content = stringify({ frontmatter, body });
    const target = join(dir, `${id}.md`);
    const tmp = join(dir, tmpName());
    try {
      await writeFile(tmp, content, 'utf8');
      await rename(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }

    // T06 bm25 索引：optional lazy import，未就绪则静默跳过。
    try {
      const bm25 = await import('./bm25.mjs');
      if (bm25?.addDoc) await bm25.addDoc({ scope, id, frontmatter, body });
    } catch {
      /* bm25 未就绪则静默跳过 */
    }

    return { id, frontmatter, body };
  }

  async function read(scope, id) {
    const target = join(dirFor(scope), `${id}.md`);
    let raw;
    try {
      raw = await readFile(target, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    return parse(raw);
  }

  async function list(scope, filter = {}) {
    const dir = dirFor(scope);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const id = e.name.slice(0, -3);
      const { frontmatter } = parse(await readFile(join(dir, e.name), 'utf8'));
      if (filter.tag != null && !(frontmatter.tags ?? []).includes(filter.tag)) continue;
      out.push({ id, frontmatter });
    }
    return out;
  }

  async function remove(scope, id) {
    const target = join(dirFor(scope), `${id}.md`);
    try {
      await unlink(target);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  return { write, read, list, remove };
}

const defaultStore = createStore(join(process.cwd(), '.gantry', 'learnings'));

export const write = (scope, doc) => defaultStore.write(scope, doc);
export const read = (scope, id) => defaultStore.read(scope, id);
export const list = (scope, filter) => defaultStore.list(scope, filter);
export const remove = (scope, id) => defaultStore.remove(scope, id);
