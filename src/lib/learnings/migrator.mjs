// learnings 一次性迁移：将旧知识出口（.gantry/specs/LESSONS.md + .gantry/specs/knowledge/*.md）
// 归并到 .gantry/learnings/team/*.md（ADR-003）。
//
// migrate({dryRun, baseDir}) → {code, written[], skipped[]}
//   - code: 'migration_completed'（有写入/将有写入）| 'migration_idempotent'（全部跳过）
//   - baseDir 默认 .gantry/specs/，允许测试用 tmpdir 覆盖；learnings 根 = dirname(baseDir)/learnings
//   - 幂等：目标 team/<id>.md 已存在则跳过（source 相同/冲突均保守 skip），原文件保留并加 MIGRATED 提示
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createStore } from './store.mjs';

const MIGRATED_HINT = '> MIGRATED to .gantry/learnings/';
const LESSONS_SOURCE = '.gantry/specs/LESSONS.md';
const LESSON_HEADER_RE = /^#{2,6}\s+L-(\d{1,6})\b/;

// LESSONS.md 按 L-XXX 分块：每块以其 header（## L-001 / ### L-001 等）开始，
// 到下一个 L-XXX header 或文件末为止；body 去除 header 并 trim 首尾空行。
function splitLessons(content) {
  const lines = content.split('\n');
  const blocks = [];
  let current = null;
  const close = () => {
    if (current) {
      const body = current.lines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
      blocks.push({ id: current.id, body });
    }
  };
  for (const line of lines) {
    const m = LESSON_HEADER_RE.exec(line.trim());
    if (m) {
      close();
      current = { id: `L-${m[1].padStart(3, '0')}`, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  close();
  return blocks;
}

// 顶部插入 MIGRATED 提示（shebang / frontmatter 之后、body 之前）；已含则不改。
function addMigratedHint(content) {
  if (content.includes('MIGRATED to .gantry/learnings/')) return { content, changed: false };
  const lines = content.split('\n');
  let insertAt = 0;
  if (lines[0].startsWith('#!')) {
    insertAt = 1;
  } else if (lines[0].trim() === '---') {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { end = i; break; }
    }
    insertAt = end === -1 ? 0 : end + 1;
  }
  return {
    content: [...lines.slice(0, insertAt), MIGRATED_HINT, ...lines.slice(insertAt)].join('\n'),
    changed: true,
  };
}

const readIfExists = async (p) => {
  try { return await readFile(p, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
};

const readdirSafe = async (dir) => {
  try { return await readdir(dir); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
};

export async function migrate({ dryRun = false, baseDir } = {}) {
  const specsDir = baseDir ?? join(process.cwd(), '.gantry', 'specs');
  const store = createStore(join(dirname(specsDir), 'learnings'));

  const written = [];
  const skipped = [];

  // (a) LESSONS.md → team/L-XXX.md，tags:[lesson]
  const lessonsPath = join(specsDir, 'LESSONS.md');
  const lessonsContent = await readIfExists(lessonsPath);
  if (lessonsContent != null) {
    for (const { id, body } of splitLessons(lessonsContent)) {
      const target = `team/${id}.md`;
      if ((await store.read('team', id)) != null) {
        skipped.push(target);
      } else {
        written.push(target);
        if (!dryRun) await store.write('team', { id, tags: ['lesson'], source: LESSONS_SOURCE, body });
      }
    }
    if (!dryRun) {
      const { content, changed } = addMigratedHint(lessonsContent);
      if (changed) await writeFile(lessonsPath, content, 'utf8');
    }
  }

  // (b) knowledge/*.md → team/<原文件名>.md，tags:[knowledge]
  const knowledgeDir = join(specsDir, 'knowledge');
  const names = (await readdirSafe(knowledgeDir)).filter((n) => n.endsWith('.md')).sort();
  for (const name of names) {
    const id = name.slice(0, -3);
    const srcPath = join(knowledgeDir, name);
    const body = await readFile(srcPath, 'utf8');
    const target = `team/${id}.md`;
    if ((await store.read('team', id)) != null) {
      skipped.push(target);
    } else {
      written.push(target);
      if (!dryRun) {
        await store.write('team', { id, tags: ['knowledge'], source: `.gantry/specs/knowledge/${name}`, body });
      }
    }
    if (!dryRun) {
      const { content, changed } = addMigratedHint(body);
      if (changed) await writeFile(srcPath, content, 'utf8');
    }
  }

  const code = written.length > 0 ? 'migration_completed' : 'migration_idempotent';
  return { code, written, skipped };
}
