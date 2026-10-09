import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractProposalSummary,
  collectLessonsIds,
  appendChangelogLine,
} from '../src/lib/archive-helpers.mjs';

let root;
let changelogPath;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'archive-helpers-'));
  changelogPath = join(root, 'CHANGELOG.md');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const CHANGELOG_HEADER = [
  '# CHANGELOG',
  '',
  '| 日期 | Change ID | 摘要 | PR | LESSONS |',
  '|---|---|---|---|---|',
  '| 2026-08-03 | a-old | 旧行 | — | 无 |',
  '',
].join('\n');

const lessonDoc = (id, changeId) =>
  `---\nid: ${id}\ntags: []\nchangeId: ${changeId}\ncreatedAt: 2026-10-09T00:00:00.000Z\nscope: team\n---\n\nbody\n`;

describe('extractProposalSummary', () => {
  it('AC-18: 命中 # PROPOSAL: 返回 trim 后的摘要', () => {
    assert.equal(extractProposalSummary('# PROPOSAL: 做 foo\n\n## Why\n...'), '做 foo');
  });

  it('取首个命中, 多余空白被 trim', () => {
    const content = '前言\n# PROPOSAL:   做 foo 对接 bar   \n# PROPOSAL: 第二条\n';
    assert.equal(extractProposalSummary(content), '做 foo 对接 bar');
  });

  it('未命中返回空字符串', () => {
    assert.equal(extractProposalSummary('没有 proposal 前缀的内容'), '');
    assert.equal(extractProposalSummary('# PROPOSAL 冒号缺失'), '');
    assert.equal(extractProposalSummary('# PROPOSAL:   '), '');
    assert.equal(extractProposalSummary(''), '');
  });
});

describe('collectLessonsIds', () => {
  it('返回 changeId 匹配的 id, 按文件名字母序', async () => {
    const dir = join(root, 'team-1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'L-102.md'), lessonDoc('L-102', 'foo-bar'), 'utf8');
    await writeFile(join(dir, 'L-100.md'), lessonDoc('L-100', 'foo-bar'), 'utf8');
    await writeFile(join(dir, 'L-101.md'), lessonDoc('L-101', 'foo-bar'), 'utf8');
    await writeFile(join(dir, 'L-999.md'), lessonDoc('L-999', 'other-change'), 'utf8');

    assert.deepEqual(await collectLessonsIds(dir, 'foo-bar'), ['L-100', 'L-101', 'L-102']);
  });

  it('无匹配返回空数组', async () => {
    const dir = join(root, 'team-2');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'L-100.md'), lessonDoc('L-100', 'other-change'), 'utf8');
    assert.deepEqual(await collectLessonsIds(dir, 'nope'), []);
  });

  it('learningsDir 不存在返回空数组', async () => {
    assert.deepEqual(await collectLessonsIds(join(root, 'missing'), 'foo-bar'), []);
  });
});

describe('appendChangelogLine', () => {
  it('AC-18: 保留原内容并追加一行, 无 .tmp 残留', async () => {
    await writeFile(changelogPath, CHANGELOG_HEADER, 'utf8');
    await appendChangelogLine(changelogPath, {
      date: '2026-10-09',
      id: 'foo-bar',
      summary: '做 foo 对接 bar',
      pr: '—',
      lessons: '无',
    });

    const content = await readFile(changelogPath, 'utf8');
    assert.ok(content.startsWith(CHANGELOG_HEADER), '原有内容一字不动');
    assert.ok(
      content.endsWith('| 2026-10-09 | foo-bar | 做 foo 对接 bar | — | 无 |\n'),
      '末尾追加格式正确的行',
    );
    const entries = await readdir(root);
    assert.ok(!entries.some((n) => n.startsWith('.tmp-')), '无 .tmp 残留');
  });

  it('changelogPath 不存在时抛错', async () => {
    const missing = join(root, 'nope', 'CHANGELOG.md');
    await assert.rejects(
      () => appendChangelogLine(missing, { date: 'd', id: 'i', summary: 's', pr: '—', lessons: '无' }),
      (err) => err.message === `CHANGELOG not found: ${missing}`,
    );
  });

  it('不去重: 追加两次产生两行', async () => {
    await writeFile(changelogPath, CHANGELOG_HEADER, 'utf8');
    const row = { date: '2026-10-09', id: 'dup', summary: 's', pr: '—', lessons: '无' };
    await appendChangelogLine(changelogPath, row);
    await appendChangelogLine(changelogPath, row);

    const content = await readFile(changelogPath, 'utf8');
    const dupLines = content.split('\n').filter((l) => l === '| 2026-10-09 | dup | s | — | 无 |');
    assert.equal(dupLines.length, 2, '不去重, 同一 changeId 追加两次产生两行');
  });
});
