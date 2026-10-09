/**
 * review-backlog-sweep-ac-integration.test.mjs — T10 端到端 AC-1..AC-19 集成回归
 *
 * 覆盖 SPEC 全部 19 条 AC 的 Given/When/Then。对已被 Wave 1/2 单测覆盖的 AC,
 * 这里只做黑盒 smoke 验证 (不重复实现细节断言), 关注三类集成场景:
 *   1. config fail-closed (AC-1/AC-2): 库层校验 + 进程级非零退出黑盒
 *   2. archive + 真 PROPOSAL + 真 learnings 条目组合 (AC-4..AC-8 一条链)
 *   3. review-guard 在真 context-pack 消费链路里不误伤任何既有 kind (AC-9..AC-12)
 *
 * 说明 (AC-1): T03 的 write_files 不含 cli.mjs, 顶层 catch 未接入 — 本文件不改 src,
 * 用两条机器可验证路径覆盖 AC-1 Then: 库层 ConfigError 携带 errors (路径 B) +
 * 未捕获 ConfigError 的进程非零退出 + stderr 含具体 key 路径 (路径 A 等价黑盒)。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync,
} from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateLearningsConfig, ConfigError } from '../src/lib/config-schema.mjs';
import { checkPack, ALLOWED_REVIEW_KINDS } from '../src/lib/review-lane-guard.mjs';
import { globToRegExp } from '../src/lib/hard-rules.mjs';
import { buildManagedEntries } from '../src/lib/install-helpers.mjs';
import { extractProposalSummary, appendChangelogLine } from '../src/lib/archive-helpers.mjs';
import { SECTION_HEADER_RE } from '../src/lib/friction.mjs';
import { createStore } from '../src/lib/learnings/store.mjs';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
const SCHEMA_URL = new URL('../src/lib/config-schema.mjs', import.meta.url).href;
const BM25_URL = new URL('../src/lib/learnings/bm25.mjs', import.meta.url).href;

// AC-3 故障注入: 拦截 store.mjs 内部动态 import('./bm25.mjs'), 把 addDoc 替换为 throw。
// 仅在 store.write 的动态 import 时生效, 不触碰真实 bm25 源码。
registerHooks({
  load(url, context, nextLoad) {
    if (url === BM25_URL) {
      return {
        format: 'module',
        source: 'export function addDoc() { throw new Error("bm25 boom"); }',
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

// --- archive CLI 黑盒 helper (AC-4..AC-8) ---

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

let tmpRoot = null;

function cli(args) {
  return spawnSync('node', [CLI, ...args], { cwd: tmpRoot, encoding: 'utf-8', timeout: 20000 });
}

function initProject() {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ac-integration-'));
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

function cleanupTmp() {
  if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
}

// === A 组 · 信任侵蚀修复 ===

test('AC-01 config 未知 key fail-closed (库层校验 + CLI 真跑非零退出)', () => {
  // 路径 B (保留 · 库层): fail-closed — errors 携带具体 key 路径, ConfigError 承载 errors
  const r = validateLearningsConfig({ friction: { weights: { newfile: 10 } } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('learnings.friction.weights.newfile 不是已知配置项'));
  const err = new ConfigError(r.errors);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ConfigError');
  assert.ok(err.errors.includes('learnings.friction.weights.newfile 不是已知配置项'));

  // 路径 A (真 CLI 层 · T-FIX-20): `node src/cli.mjs status` + 坏 config 真跑
  // 应 exit !== 0 + stderr 含具体 key 路径 + 修正提示
  const proj = mkdtempSync(join(tmpdir(), 'gantry-ac1-'));
  try {
    mkdirSync(join(proj, '.gantry', 'planning'), { recursive: true });
    writeFileSync(
      join(proj, '.gantry', 'planning', 'config.json'),
      JSON.stringify({ learnings: { friction: { weights: { newfile: 10 } } } }),
    );
    const child = spawnSync(process.execPath, [CLI, 'status'], {
      cwd: proj,
      encoding: 'utf-8',
      env: { ...process.env, HOME: proj }, // 隔离用户全局 config
    });
    assert.notEqual(child.status, 0, `CLI 应非零退出, stdout=${child.stdout} stderr=${child.stderr}`);
    assert.ok(
      child.stderr.includes('learnings.friction.weights.newfile 不是已知配置项'),
      `stderr 应含具体 key 路径, 实际: ${child.stderr}`,
    );
    assert.ok(
      child.stderr.includes('修正后重试或删除该键'),
      `stderr 应含修正提示, 实际: ${child.stderr}`,
    );
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test('AC-02 多层嵌套 unknown key 均被检出', () => {
  const r = validateLearningsConfig({
    unknownTop: 'x',
    friction: { weights: { wrongKey: 1 } },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('learnings.unknownTop 不是已知配置项'));
  assert.ok(r.errors.includes('learnings.friction.weights.wrongKey 不是已知配置项'));

  // 已知合法 key (newFile / refactor) 仍可通过
  const ok = validateLearningsConfig({ friction: { weights: { newFile: 1, refactor: 2 } } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);
});

test('AC-03 bm25 索引失败 → md 落盘 + stderr 告警 + drift event + 不抛', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-bm25-'));
  try {
    const store = createStore(root);

    let stderr = '';
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderr += String(chunk);
      return origWrite(chunk, ...rest);
    };

    let result;
    try {
      result = await store.write('team', { id: 'L-TEST', body: 'hello' });
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(result.id, 'L-TEST');
    const md = await readFile(join(root, 'team', 'L-TEST.md'), 'utf8');
    assert.ok(md.includes('hello'), 'md 应已落盘');
    assert.ok(
      stderr.includes('[learnings] bm25 index update failed for team/L-TEST: bm25 boom'),
      `stderr 应含告警, 实际: ${stderr}`,
    );
    const eventsRaw = await readFile(join(root, 'team', '.friction', 'events.jsonl'), 'utf8');
    const events = eventsRaw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const drift = events.find((e) => e.kind === 'learnings-index-drift');
    assert.ok(drift, '应存在 learnings-index-drift 事件');
    assert.equal(drift.scope, 'team');
    assert.equal(drift.id, 'L-TEST');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('AC-04 archive 自动写 CHANGELOG', () => {
  setupProject('foo-bar', { proposal: '# PROPOSAL: 做 foo 对接 bar\n\n## Why\n...\n' });
  try {
    const r = cli(['archive', '--force', '--skip-learning']);
    assert.equal(r.status, 0, `archive failed: stderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.ok(r.stdout.includes('已写入 CHANGELOG.md'));

    const content = readChangelog();
    assert.ok(content.startsWith(CHANGELOG_HEADER), '原有行一字不动');
    assert.match(content, /\| \d{4}-\d{2}-\d{2} \| foo-bar \| 做 foo 对接 bar \| — \| 无 \|\n$/);
    assert.equal(existsSync(join(tmpRoot, '.gantry/specs', 'foo-bar')), false, 'change 目录已移出原位');
    assert.ok(existsSync(join(tmpRoot, '.gantry/specs', '_archive', 'foo-bar')), '已归档到 _archive/foo-bar/');
  } finally {
    cleanupTmp();
  }
});

test('AC-05 archive 摘要提取 fallback', () => {
  setupProject('foo-bar', { proposal: '---\ntitle: x\n---\n\n# 正文\n' });
  try {
    const r = cli(['archive', '--force', '--skip-learning']);
    assert.equal(r.status, 0, `archive failed: stderr=${r.stderr}\nstdout=${r.stdout}`);
    assert.ok(r.stderr.includes('--summary 覆写'), `stderr 应含 --summary 覆写: ${r.stderr}`);

    const content = readChangelog();
    assert.match(content, /\| \d{4}-\d{2}-\d{2} \| foo-bar \| foo-bar \| — \| 无 \|\n$/);
    assert.equal(existsSync(join(tmpRoot, '.gantry/specs', 'foo-bar')), false, '归档流程仍成功完成');
  } finally {
    cleanupTmp();
  }
});

test('AC-06 archive --summary 覆写', () => {
  setupProject('foo-bar', { proposal: '# PROPOSAL: 自动提取的摘要\n' });
  try {
    const r = cli(['archive', '--force', '--skip-learning', '--summary', '手工指定摘要']);
    assert.equal(r.status, 0, `archive failed: stderr=${r.stderr}\nstdout=${r.stdout}`);

    const content = readChangelog();
    assert.match(content, /\| \d{4}-\d{2}-\d{2} \| foo-bar \| 手工指定摘要 \| — \| 无 \|\n$/);
  } finally {
    cleanupTmp();
  }
});

test('AC-07 archive CHANGELOG 写失败不执行 rename', () => {
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
    assert.ok(existsSync(join(specsDir, 'foo-bar')), 'change 目录仍在原位, 未被 rename 到 _archive/');
    cleanupTmp();
  }
});

test('AC-08 archive LESSONS 列反映本次新增', () => {
  setupProject('foo-bar', {
    proposal: '# PROPOSAL: 做 foo 对接 bar\n',
    lessons: ['L-100', 'L-101'],
  });
  try {
    const r = cli(['archive', '--force', '--skip-learning']);
    assert.equal(r.status, 0, `archive failed: stderr=${r.stderr}\nstdout=${r.stdout}`);

    const content = readChangelog();
    assert.match(content, /\| \d{4}-\d{2}-\d{2} \| foo-bar \| 做 foo 对接 bar \| — \| L-100, L-101 \|\n$/);
  } finally {
    cleanupTmp();
  }
});

// === B 组 · 边界显式化 ===

test('AC-09 review-guard 白名单放行 + 真 context-pack 消费链路不误伤既有 kind', async () => {
  // SPEC Given: spec-doc entry 应通过
  const single = checkPack(
    { loadOrder: [{ path: '.gantry/specs/c/SPEC.md', kind: 'spec-doc', required: true }] },
    { lane: 'review' },
  );
  assert.equal(single.blocked.length, 0);
  assert.equal(single.allowed.length, 1);

  // 真消费链路: 用 writeContextPack 在临时项目 review 阶段生成真实 pack, 再走 checkPack
  const root = mkdtempSync(join(tmpdir(), 'ac-pack-'));
  try {
    const changeDir = join(root, '.gantry', 'specs', 'foo-bar');
    mkdirSync(changeDir, { recursive: true });
    writeFileSync(join(changeDir, 'PROPOSAL.md'), '# PROPOSAL: 做 foo 对接 bar\n', 'utf8');
    writeFileSync(join(changeDir, 'SPEC.md'), '# SPEC\n', 'utf8');

    const { writeContextPack } = await import('../src/lib/context-pack.mjs');
    const pack = writeContextPack(root, { stage: 'review', changeId: 'foo-bar' });
    assert.ok(pack.loadOrder.length > 0, '真 pack 应含 loadOrder');

    const res = checkPack(pack, { lane: 'review' });
    assert.equal(res.blocked.length, 0, `不应误伤既有 kind: ${JSON.stringify(res.blocked)}`);
    assert.equal(res.allowed.length, pack.loadOrder.length);
    // 白名单必须覆盖真 pack 用到的所有 kind
    for (const entry of pack.loadOrder) {
      assert.ok(ALLOWED_REVIEW_KINDS.includes(entry.kind), `kind ${entry.kind} 应在白名单`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC-10 review-guard 对未知 kind 拦截 + reason 格式', () => {
  const res = checkPack(
    {
      loadOrder: [
        { path: '.gantry/specs/c/SPEC.md', kind: 'spec-doc', required: true },
        { path: '.gantry/dev/execution.log', kind: 'execution-log', required: false },
      ],
    },
    { lane: 'review' },
  );
  assert.equal(res.allowed.length, 1);
  assert.equal(res.blocked.length, 1);
  assert.equal(res.blocked[0].kind, 'execution-log');
  assert.equal(
    res.blocked[0].reason,
    'kind "execution-log" 不在 ALLOWED_REVIEW_KINDS 白名单',
  );
});

test('AC-11 review-guard EXECUTION.md 自动被挡', () => {
  const res = checkPack(
    {
      loadOrder: [
        { path: '.gantry/specs/c/EXECUTION.md', kind: 'execution-doc', required: false },
        { path: '.gantry/specs/c/EXECUTION.md', kind: 'execution-log', required: false },
      ],
    },
    { lane: 'review' },
  );
  assert.equal(res.allowed.length, 0);
  assert.equal(res.blocked.length, 2);
  assert.deepEqual(res.blocked.map((b) => b.kind), ['execution-doc', 'execution-log']);
});

test('AC-12 review-guard --allow-kind escape hatch', () => {
  const res = checkPack(
    { loadOrder: [{ path: '.gantry/dev/execution.log', kind: 'execution-log', required: false }] },
    { lane: 'review', allowKind: ['execution-log'] },
  );
  assert.equal(res.blocked.length, 0);
  assert.equal(res.allowed.length, 1);
  assert.equal(res.allowed[0].kind, 'execution-log');
  // escape hatch 不改白名单常量
  assert.equal(ALLOWED_REVIEW_KINDS.includes('execution-log'), false);
});

test('AC-13 hard-rules glob 单星不跨斜杠', () => {
  assert.equal(globToRegExp('src/*.mjs').test('src/lib/foo.mjs'), false);
  assert.equal(globToRegExp('src/*.mjs').test('src/foo.mjs'), true);
});

test('AC-14 hard-rules glob 双星跨斜杠', () => {
  const re = globToRegExp('src/**/*.mjs');
  assert.equal(re.test('src/foo.mjs'), true);
  assert.equal(re.test('src/lib/foo.mjs'), true);
  assert.equal(re.test('src/lib/nested/deep/foo.mjs'), true);
  assert.equal(re.test('tests/foo.mjs'), false);
});

test('AC-15 hard-rules glob 其他元字符保持转义', () => {
  assert.equal(globToRegExp('src/file.v1.mjs').test('src/fileAv1.mjs'), false);
  assert.equal(globToRegExp('src/file.v1.mjs').test('src/file.v1.mjs'), true);
});

test('AC-16 friction 段头正则共享', () => {
  const source = readFileSync(new URL('../src/lib/friction.mjs', import.meta.url), 'utf8');
  const lines = source.split('\n');

  assert.equal(source.includes('/^## friction-events'), false, '不应残留 /^## friction-events 正则字面量');
  assert.equal(lines.filter((l) => /const SECTION_HEADER_RE\s*=/.test(l)).length, 1);
  assert.equal(source.includes('const headerRe'), false, 'headerRe 局部变量应已删除');
  assert.ok(source.includes('SECTION_HEADER_RE.exec(content)'), 'appendToContent 应引用 SECTION_HEADER_RE');
  assert.ok(source.includes('const NEXT_SECTION_RE = /^##[ \\t]/m'), 'NEXT_SECTION_RE 保持独立');

  assert.equal(SECTION_HEADER_RE.test('## friction-events'), true);
  assert.equal(SECTION_HEADER_RE.test('## other'), false);
});

// === C 组 · clarity 债 ===

test('AC-17 install helpers 独立单测可运行', () => {
  assert.deepEqual(
    buildManagedEntries({ addToAllow: ['x'], legacyAliases: ['y'] }),
    { 'permissions.allow': ['x', 'y'] },
  );
  // 不触碰文件系统 / 不依赖 CLI 全局状态: 纯函数只依赖入参
  assert.deepEqual(buildManagedEntries({ addToAllow: [] }), { 'permissions.allow': [] });
});

test('AC-18 archive helpers 独立单测可运行', async () => {
  assert.equal(extractProposalSummary('# PROPOSAL: 做 foo\n'), '做 foo');
  assert.equal(extractProposalSummary('没有 proposal 前缀的内容'), '');

  const root = await mkdtemp(join(tmpdir(), 'ac-ach-'));
  try {
    const path = join(root, 'CHANGELOG.md');
    await writeFile(path, CHANGELOG_HEADER, 'utf8');
    await appendChangelogLine(path, {
      date: '2026-10-09', id: 'foo-bar', summary: '做 foo 对接 bar', pr: '—', lessons: '无',
    });
    const content = await readFile(path, 'utf8');
    assert.ok(content.startsWith(CHANGELOG_HEADER), '原有内容保留');
    assert.ok(content.endsWith('| 2026-10-09 | foo-bar | 做 foo 对接 bar | — | 无 |\n'), '只追加新行');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('AC-19 cli.mjs installToolsToTarget 行数 ≤ 45', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.mjs'), 'utf8');
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^async function installToolsToTarget/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^function installCorePhases/.test(l));
  assert.ok(start >= 0, 'installToolsToTarget 应存在');
  assert.ok(end > start, 'installCorePhases 应在 installToolsToTarget 之后');
  const span = end - start;
  assert.ok(span <= 45, `installToolsToTarget 行数应 ≤ 45, 实际 ${span}`);
});
