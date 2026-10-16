// archive CHANGELOG 操作的纯函数封装：PROPOSAL 摘要提取 / learnings 条目收集 / CHANGELOG 行追加。
// 供 cli.mjs::archiveChange (T09) 调用, 脱离 CLI 主流程独立单测。
import { readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse } from './learnings/frontmatter.mjs';

const PROPOSAL_RE = /^# PROPOSAL:\s*(.+)$/m;

// 与 learnings store 同款的临时文件名, 保证同目录 rename 原子落盘。
const tmpName = () => `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;

export function extractProposalSummary(content) {
  const m = String(content ?? '').match(PROPOSAL_RE);
  return m ? m[1].trim() : '';
}

export async function collectLessonsIds(learningsDir, changeId) {
  let entries;
  try {
    entries = await readdir(learningsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const ids = [];
  for (const e of mdFiles) {
    const { frontmatter } = parse(await readFile(join(learningsDir, e.name), 'utf8'));
    if (frontmatter.changeId === changeId) ids.push(frontmatter.id ?? e.name.slice(0, -3));
  }
  return ids;
}

export async function appendChangelogLine(changelogPath, row) {
  let existing;
  try {
    existing = await readFile(changelogPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`CHANGELOG not found: ${changelogPath}`);
    throw err;
  }

  const { date, id, summary, pr, lessons } = row;
  const line = `| ${date} | ${id} | ${summary} | ${pr} | ${lessons} |\n`;
  const content = existing.endsWith('\n') ? existing + line : `${existing}\n${line}`;

  const tmp = join(dirname(changelogPath), tmpName());
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, changelogPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
