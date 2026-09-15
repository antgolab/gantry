import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReplay } from '../tools/tier-router-replay.mjs';

const EMPTY = () => ({ modifiedFiles: [], newFiles: [], pkgJsonDepsDelta: [] });
const TOOL_PATH = fileURLToPath(new URL('../tools/tier-router-replay.mjs', import.meta.url));

// 20 条桩 case: 硬红线 6 + micro 5 + light 5 + full 4
// { id, description, snap, tier } — tier 为「全对」场景下的实际 pipeline
const CASES = [
  // 硬红线 (6)
  { id: 'H1', description: 'add schema to user model', snap: { modifiedFiles: ['src/a.mjs'] }, tier: 'full' },
  { id: 'H2', description: 'implement auth logic', snap: { modifiedFiles: ['src/a.mjs'] }, tier: 'full' },
  { id: 'H3', description: 'add dependency', snap: { modifiedFiles: ['src/a.mjs'], pkgJsonDepsDelta: ['foo'] }, tier: 'full' },
  { id: 'H4', description: 'update db', snap: { modifiedFiles: ['migrations/init.sql'] }, tier: 'full' },
  { id: 'H5', description: 'update openapi spec', snap: { modifiedFiles: ['openapi.yaml'] }, tier: 'full' },
  { id: 'H6', description: 'change proto', snap: { modifiedFiles: ['proto/order.proto'] }, tier: 'full' },
  // micro (5)
  { id: 'M1', description: 'fix typo in README', snap: { modifiedFiles: ['README.md'] }, tier: 'micro' },
  { id: 'M2', description: 'update docs', snap: { modifiedFiles: ['docs/guide.md'] }, tier: 'micro' },
  { id: 'M3', description: 'chore: bump version', snap: { modifiedFiles: ['README.md'] }, tier: 'micro' },
  { id: 'M4', description: 'update license', snap: { modifiedFiles: ['LICENSE'] }, tier: 'micro' },
  { id: 'M5', description: 'fix link', snap: { modifiedFiles: ['README.md'] }, tier: 'micro' },
  // light (5)
  { id: 'L1', description: 'refactor helper', snap: { modifiedFiles: ['src/a.mjs', 'src/b.mjs'] }, tier: 'light' },
  { id: 'L2', description: 'maybe fix this', snap: { modifiedFiles: ['src/a.mjs'] }, tier: 'light' },
  { id: 'L3', description: 'add config', snap: { modifiedFiles: ['config/app.json'] }, tier: 'light' },
  { id: 'L4', description: 'maybe refactor', snap: { modifiedFiles: ['src/a.mjs'] }, tier: 'light' },
  { id: 'L5', description: 'add helper', snap: { modifiedFiles: ['src/a.mjs'], newFiles: ['src/b.mjs'] }, tier: 'light' },
  // full (4)
  { id: 'F1', description: 'refactor helper', snap: { modifiedFiles: ['src/a.mjs', 'src/b.mjs'], newFiles: ['src/c.mjs'] }, tier: 'full' },
  { id: 'F2', description: 'refactor config', snap: { modifiedFiles: ['config/a.mjs', 'config/b.mjs'], newFiles: ['config/c.mjs'] }, tier: 'full' },
  { id: 'F3', description: 'refactor config maybe', snap: { modifiedFiles: ['config/a.mjs', 'config/b.mjs'], newFiles: ['config/c.mjs'] }, tier: 'full' },
  { id: 'F4', description: '重构工具模块', snap: { modifiedFiles: ['src/a.mjs', 'src/b.mjs'], newFiles: ['src/c.mjs'] }, tier: 'full' },
];

const tmpRoots = [];
after(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

function mkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tier-replay-'));
  tmpRoots.push(root);
  return root;
}

function writeArchives(cases) {
  const root = mkRoot();
  for (const c of cases) {
    const dir = join(root, c.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PROPOSAL.md'), proposal(c));
    writeFileSync(join(dir, 'EXECUTION.md'), execution(c));
    if (c.state) writeFileSync(join(dir, 'STATE.md'), c.state);
  }
  return root;
}

function proposal(c) {
  if (c.proposalRaw) return c.proposalRaw;
  return `# PROPOSAL: ${c.id}\n\n## 需求描述\n\n${c.description}\n`;
}

function execution(c) {
  const auto = c.autoTier ?? c.tier;
  const lines = [
    `# EXECUTION: ${c.id}`,
    '',
    '## tier-decision',
    `auto: ${auto}`,
    'hits: []',
    'score: 0',
  ];
  if (c.override) lines.push(`tier-override: user requested ${c.override} (auto-detected: ${auto})`);
  return lines.join('\n') + '\n';
}

function replay(cases, opts = {}) {
  const root = writeArchives(cases);
  const snapById = Object.fromEntries(cases.map((c) => [c.id, c.snap ?? EMPTY()]));
  return runReplay({
    archivesDir: root,
    fsSnapshot: ({ changeId }) => snapById[changeId] ?? EMPTY(),
    ...opts,
  });
}

describe('tier-router-replay · 归档回放质量门', () => {
  it('20 条桩数据全对 → accuracy=1.0, code=replay_pass, 分解均为 1.0', () => {
    const result = replay(CASES.map((c) => ({ ...c })));
    assert.equal(result.total, 20);
    assert.equal(result.correct, 20);
    assert.equal(result.accuracy, 1.0);
    assert.equal(result.code, 'replay_pass');
    assert.equal(result.hardRuleAccuracy, 1.0);
    assert.equal(result.softScoreAccuracy, 1.0);
    assert.equal(result.skipped.length, 0);
  });

  it('3 条错判 (accuracy=0.85) + minAccuracy=0.9 → code=replay_below_threshold, 分解正确', () => {
    const cases = CASES.map((c) => ({ ...c }));
    const flip = { H1: 'micro', M1: 'full', L1: 'full' }; // 硬红线 1 + 软打分 2 错判
    for (const c of cases) if (flip[c.id]) c.tier = flip[c.id];

    const result = replay(cases, { minAccuracy: 0.9 });
    assert.equal(result.total, 20);
    assert.equal(result.correct, 17);
    assert.equal(result.accuracy, 17 / 20);
    assert.equal(result.code, 'replay_below_threshold');
    assert.equal(result.hardRuleAccuracy, 5 / 6);
    assert.equal(result.softScoreAccuracy, 12 / 14);
  });

  it('tier-override 行优先于 auto 行', () => {
    const cases = [{
      id: 'override-1',
      description: 'add schema to user model',
      snap: { modifiedFiles: ['src/a.mjs'] },
      tier: 'full',
      autoTier: 'micro',
      override: 'full',
    }];
    const result = replay(cases);
    assert.equal(result.total, 1);
    assert.equal(result.cases[0].actualTier, 'full');
    assert.equal(result.cases[0].correct, true);
  });

  it('tuneSuggest=true 时返回非空 suggestions 数组', () => {
    const cases = CASES.map((c) => ({ ...c }));
    const flip = { H1: 'micro', M1: 'full', L1: 'full' };
    for (const c of cases) if (flip[c.id]) c.tier = flip[c.id];

    const result = replay(cases, { tuneSuggest: true });
    assert.ok(Array.isArray(result.suggestions));
    assert.ok(result.suggestions.length > 0);
  });

  it('tuneSuggest=false 时 suggestions 为空数组', () => {
    const result = replay(CASES.map((c) => ({ ...c })));
    assert.deepEqual(result.suggestions, []);
  });

  it('归档目录不存在 → {total:0, code: replay_no_data}', () => {
    const result = runReplay({ archivesDir: join(tmpdir(), `missing-${Date.now()}`) });
    assert.equal(result.code, 'replay_no_data');
    assert.equal(result.total, 0);
    assert.equal(result.correct, 0);
    assert.deepEqual(result.cases, []);
  });

  it('缺 tier-decision 且无 STATE → 计入 skipped', () => {
    const root = mkRoot();
    const dir = join(root, 'skip-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PROPOSAL.md'), '# PROPOSAL: skip-1\n\n## 需求描述\n\nrefactor helper\n');
    writeFileSync(join(dir, 'EXECUTION.md'), '# EXECUTION: skip-1\n\n## Entries\n\n### T01\n');

    const result = runReplay({ archivesDir: root });
    assert.equal(result.total, 0);
    assert.equal(result.code, 'replay_no_data');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].changeId, 'skip-1');
  });

  it('PROPOSAL 无 ## 需求描述 段时从标题 + 首段抽取描述', () => {
    const cases = [{
      id: 'fallback-1',
      snap: { modifiedFiles: ['src/a.mjs', 'src/b.mjs'], newFiles: ['src/c.mjs'] },
      tier: 'full',
      proposalRaw: '# PROPOSAL: 重构工具模块\n\n- **Change ID**: fallback-1\n- **Pipeline**: full\n\n---\n\n## Why（为什么做）\n\n重构工具模块以提升性能\n',
    }];
    const result = replay(cases);
    assert.equal(result.total, 1);
    assert.match(result.cases[0].description, /重构/);
    assert.equal(result.cases[0].correct, true);
  });
});

describe('tier-router-replay · --seed-fixture 固化样本回放', () => {
  function writeSeedFixture(lines) {
    const root = mkRoot();
    const path = join(root, 'seed-fixture.jsonl');
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return path;
  }

  it('--seed-fixture 加载 fixture 计算 accuracy (5 条 3 命中 2 miss → 0.6)', () => {
    const lines = [
      { description: 'fix typo in README', filesChanged: ['README.md'], expectedTier: 'micro' },
      { description: 'add auth logic', filesChanged: ['src/a.mjs'], expectedTier: 'full' },
      { description: 'refactor helper', filesChanged: ['src/a.mjs'], expectedTier: 'light' },
      { description: 'add schema', filesChanged: ['src/a.mjs'], expectedTier: 'micro' }, // miss → full
      { description: 'update docs', filesChanged: ['docs/a.md'], expectedTier: 'full' }, // miss → micro
    ];
    const result = runReplay({ seedFixture: writeSeedFixture(lines), minAccuracy: 0.5 });
    assert.equal(result.source, 'seed-fixture');
    assert.equal(result.total, 5);
    assert.equal(result.correct, 3);
    assert.equal(result.accuracy, 0.6);
    assert.equal(result.code, 'fixture_pass');
  });

  it('--seed-fixture + --min-accuracy 门控 → fixture_below_threshold + 非零 exit', () => {
    const lines = [
      { description: 'fix typo in README', filesChanged: ['README.md'], expectedTier: 'full' }, // miss
      { description: 'update docs', filesChanged: ['docs/a.md'], expectedTier: 'full' }, // miss
    ];
    const path = writeSeedFixture(lines);
    const result = runReplay({ seedFixture: path, minAccuracy: 0.9 });
    assert.equal(result.code, 'fixture_below_threshold');
    assert.equal(result.accuracy, 0);

    const proc = spawnSync(process.execPath, [TOOL_PATH, '--seed-fixture', path, '--min-accuracy', '0.9'], { encoding: 'utf8' });
    assert.notEqual(proc.status, 0);
  });

  it('--seed-fixture 全命中 → accuracy=1.0, code=fixture_pass, exit=0', () => {
    const lines = [
      { description: 'fix typo in README', filesChanged: ['README.md'], expectedTier: 'micro' },
      { description: 'add auth logic', filesChanged: ['src/a.mjs'], expectedTier: 'full' },
      { description: 'refactor helper', filesChanged: ['src/a.mjs'], expectedTier: 'light' },
    ];
    const path = writeSeedFixture(lines);
    const result = runReplay({ seedFixture: path });
    assert.equal(result.code, 'fixture_pass');
    assert.equal(result.accuracy, 1.0);
    assert.equal(result.correct, 3);

    const proc = spawnSync(process.execPath, [TOOL_PATH, '--seed-fixture', path], { encoding: 'utf8' });
    assert.equal(proc.status, 0);
  });

  it('fixture 与 archives 同给时 fixture 优先 (source=seed-fixture)', () => {
    const archives = writeArchives([{
      id: 'arch-only',
      description: 'add auth logic',
      snap: { modifiedFiles: ['src/a.mjs'] },
      tier: 'full',
    }]);
    const path = writeSeedFixture([
      { description: 'fix typo in README', filesChanged: ['README.md'], expectedTier: 'micro' },
    ]);
    const result = runReplay({ seedFixture: path, archivesDir: archives });
    assert.equal(result.source, 'seed-fixture');
    assert.equal(result.total, 1);
    assert.equal(result.cases[0].description, 'fix typo in README');
    assert.equal(result.cases[0].correct, true);
  });
});
