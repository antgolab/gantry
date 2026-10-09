/**
 * archive-changelog.test.mjs — archive 自动写 CHANGELOG 端到端契约 (SPEC AC-4..AC-8)
 *
 * 起真实 `node src/cli.mjs`,在临时项目根验证:
 *   - AC-4 正常归档 → CHANGELOG 末尾新增一行, 格式正确, change 目录 rename 到 _archive/
 *   - AC-5 PROPOSAL 首行不规范 → 摘要 fallback 到 change-id + stderr 告警
 *   - AC-6 --summary 覆写自动提取的摘要
 *   - AC-7 CHANGELOG 父目录只读 → 退出非零 + change 目录仍在原位
 *   - AC-8 learnings/team 中 changeId 匹配的条目 → LESSONS 列列出 ids
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');

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

let tmpRoot;

function cli(args) {
  return spawnSync('node', [CLI, ...args], { cwd: tmpRoot, encoding: 'utf-8', timeout: 20000 });
}

function initProject() {
  tmpRoot = mkdtempSync(join(tmpdir(), 'archive-changelog-'));
  const r = cli(['install', '--tool', 'claude']);
  assert.equal(r.status, 0, `install failed: stderr=${r.stderr}\nstdout=${r.stdout}`);
}

function setupProject(changeId, { proposal = '# PROPOSAL: 做 foo 对接 bar\n', lessons = [] } = {}) {
  initProject();
  const c = cli(['change', changeId]);
  assert.equal(c.status, 0, `change failed: stderr=${c.stderr}\nstdout=${c.stdout}`);

  const specsDir = join(tmpRoot, '.gantry/specs');
  writeFileSync(join(specsDir, 'CHANGELOG.md'), CHANGELOG_HEADER, 'utf8');
  writeFileSync(join(specsDir, changeId, 'PROPOSAL.md'), proposal, 'utf8');

  if (lessons.length) {
    const teamDir = join(tmpRoot, '.gantry/learnings/team');
    mkdirSync(teamDir, { recursive: true });
    for (const id of lessons) writeFileSync(join(teamDir, `${id}.md`), lessonDoc(id, changeId), 'utf8');
  }
}

function readChangelog() {
  return readFileSync(join(tmpRoot, '.gantry/specs', 'CHANGELOG.md'), 'utf8');
}

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

describe('archive 自动写 CHANGELOG (AC-4..AC-8)', () => {
  it('AC-4: 正常归档 → CHANGELOG 新增一行格式正确, change 目录 rename 到 _archive/', () => {
    setupProject('foo-bar', { proposal: '# PROPOSAL: 做 foo 对接 bar\n\n## Why\n...\n' });

    const r = cli(['archive', '--force', '--skip-learning']);
    assert.equal(r.status, 0, `archive failed: stderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.ok(r.stdout.includes('已写入 CHANGELOG.md'), `stdout 应含 已写入 CHANGELOG.md: ${r.stdout}`);

    const content = readChangelog();
    assert.ok(content.startsWith(CHANGELOG_HEADER), '原有内容一字不动');
    assert.match(content, /\| \d{4}-\d{2}-\d{2} \| foo-bar \| 做 foo 对接 bar \| — \| 无 \|\n$/);
    assert.equal(existsSync(join(tmpRoot, '.gantry/specs', 'foo-bar')), false, 'change 目录已移出原位');
    assert.ok(existsSync(join(tmpRoot, '.gantry/specs', '_archive', 'foo-bar')), '已归档到 _archive/foo-bar/');
  });

  it('AC-5: PROPOSAL 首行不规范 → 摘要 fallback 到 change-id + stderr 告警', () => {
    setupProject('foo-bar', { proposal: '---\ntitle: x\n---\n\n# 正文\n' });

    const r = cli(['archive', '--force', '--skip-learning']);
    assert.equal(r.status, 0, `archive failed: stderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.ok(r.stderr.includes('--summary 覆写'), `stderr 应含 --summary 覆写: ${r.stderr}`);

    const content = readChangelog();
    assert.match(content, /\| \d{4}-\d{2}-\d{2} \| foo-bar \| foo-bar \| — \| 无 \|\n$/);
    assert.equal(existsSync(join(tmpRoot, '.gantry/specs', 'foo-bar')), false, '归档流程仍成功完成');
  });

  it('AC-6: --summary 覆写自动提取的摘要', () => {
    setupProject('foo-bar', { proposal: '# PROPOSAL: 自动提取的摘要\n' });

    const r = cli(['archive', '--force', '--skip-learning', '--summary', '手工指定摘要']);
    assert.equal(r.status, 0, `archive failed: stderr=${r.stderr}\nstdout=${r.stdout}`);

    const content = readChangelog();
    assert.match(content, /\| \d{4}-\d{2}-\d{2} \| foo-bar \| 手工指定摘要 \| — \| 无 \|\n$/);
  });

  it('AC-7: CHANGELOG 父目录只读 → 退出非零 + change 目录仍在原位', () => {
    setupProject('foo-bar', { proposal: '# PROPOSAL: 做 foo 对接 bar\n' });
    const specsDir = join(tmpRoot, '.gantry/specs');
    chmodSync(specsDir, 0o444);

    let r;
    try {
      r = cli(['archive', '--force', '--skip-learning']);
      assert.notEqual(r.status, 0, 'archive 应退出非零');
      assert.ok(r.stderr.length > 0, `stderr 应报错: ${r.stderr}`);
    } finally {
      chmodSync(specsDir, 0o755);
    }

    assert.ok(existsSync(join(specsDir, 'foo-bar')), 'change 目录仍在原位, 未被 rename 到 _archive/');
  });

  it('AC-8: LESSONS 列反映 learnings/team 中 changeId 匹配的条目', () => {
    setupProject('foo-bar', {
      proposal: '# PROPOSAL: 做 foo 对接 bar\n',
      lessons: ['L-100', 'L-101'],
    });

    const r = cli(['archive', '--force', '--skip-learning']);
    assert.equal(r.status, 0, `archive failed: stderr=${r.stderr}\nstdout=${r.stdout}`);

    const content = readChangelog();
    assert.match(content, /\| \d{4}-\d{2}-\d{2} \| foo-bar \| 做 foo 对接 bar \| — \| L-100, L-101 \|\n$/);
  });
});
