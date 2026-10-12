/**
 * light-upgrade.test.mjs — light → full 单向升档
 *
 * 派生自 AC-8（守卫红线命中自动升 full@change）与 AC-13（手动升档入口 + 禁止降档），
 * 以及 DESIGN D13 的 PROPOSAL 初稿内容约定。
 *
 * 覆盖：
 *   - auto 升档：STATE → full@change；PROPOSAL 初稿含原目标 / rule id / 文件 / spike；
 *     `## 待澄清问题` 恰好 1 条未勾选；EXECUTION 追加 `## upgrade`（source: auto）；
 *     升档前后 `git diff HEAD` 与 `git status --porcelain`（排除 .gantry/）逐字节一致
 *   - manual 升档且无 light.json：不报错，intent 降级为空，reason: manual
 *   - 已有 PROPOSAL 改名保留：旧 PROPOSAL.md → PROPOSAL.pre-light.md（内容不变），
 *     规范名 PROPOSAL.md 写本轮初稿（D20 · F-03）；.pre-light.md 已占用则 .2 递增
 *   - 已是 full → 抛错（含「已是 full」）；无活跃 change → 抛错
 *   - renderUpgradeProposal 空 intent 不抛错且仍有 1 条未勾选待澄清项
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { upgradeToFull, renderUpgradeProposal } from '../src/lib/light-upgrade.mjs';
import { readState, writeState } from '../src/lib/state.mjs';
import { countOpenQuestions } from '../src/lib/phases.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

// --- 夹具 ---

function makeRoot(prefix = 'gantry-light-upgrade-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** 用 state 模块自己的渲染器写一份真实的 `.gantry/planning/STATE.md`。 */
function writeStateFixture(root, { pipeline, activeChange = null, currentStage = 'fast' }) {
  writeState(root, {
    pipeline,
    activeChange,
    currentStage,
    currentWave: null,
    currentTask: null,
    activeAgent: null,
    autonomous: false,
    stagesRun: 0,
    maxStages: 3,
    retries: 0,
    maxRetries: 3,
    pauseReason: null,
    verifyFailCount: 0,
    contextUsage: { tokens: null, windowPercent: null },
  });
}

function writeLightJson(root, changeId, intent) {
  const dir = join(root, '.gantry', 'specs', changeId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'light.json'),
    JSON.stringify({ intent, baseline: {}, createdAt: new Date().toISOString() }, null, 2),
    'utf-8',
  );
  return dir;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' });
}

/**
 * 初始化一个真实 git 仓库：提交一个被跟踪文件后改一笔（tracked modification），
 * 再放一个未跟踪文件（untracked）。`.gantry/` 通过 .gitignore 忽略，
 * 这样升档写入 `.gantry/` 内的文件不会污染 git 快照。
 */
function initRepoWithDirtyWorkspace(root) {
  git(root, ['init', '-q']);
  writeFileSync(join(root, '.gitignore'), '.gantry/\n', 'utf-8');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.js'), 'v1\n', 'utf-8');
  git(root, ['add', '.']);
  git(root, ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  writeFileSync(join(root, 'src', 'app.js'), 'v2\n', 'utf-8'); // 未提交修改
  writeFileSync(join(root, 'notes.txt'), 'untracked\n', 'utf-8'); // 未跟踪
}

/** 采一份「工作区」快照：git diff HEAD 全文 + status（排除 .gantry/ 行）。 */
function workspaceSnapshot(root) {
  const diff = git(root, ['diff', 'HEAD']);
  const status = git(root, ['status', '--porcelain'])
    .split('\n')
    .filter((line) => line !== '' && !line.includes('.gantry'))
    .join('\n');
  return { diff, status };
}

// --- 用例 ---

describe('upgradeToFull · auto（AC-8）', () => {
  it('STATE → full@change，PROPOSAL 初稿含意图/命中/spike，工作区不变', () => {
    const root = makeRoot();
    initRepoWithDirtyWorkspace(root);

    const changeId = 'light-up-1';
    const goal = '新增迁移脚本 001';
    writeStateFixture(root, { pipeline: 'light', activeChange: changeId, currentStage: 'fast' });
    writeLightJson(root, changeId, {
      goal,
      accept: ['迁移可重复执行'],
      scope: ['src/app.js'],
    });

    const before = workspaceSnapshot(root);

    const result = upgradeToFull(root, {
      source: 'auto',
      hits: [{ ruleId: 'migration-change', files: ['migrations/001.sql'] }],
    });

    // 返回值
    assert.equal(result.changeId, changeId);
    assert.ok(existsSync(result.proposalPath), 'PROPOSAL 初稿应存在');
    assert.match(result.proposalPath, /PROPOSAL\.md$/);

    // STATE → full@change
    const state = readState(root);
    assert.equal(state.pipeline, 'full');
    assert.equal(state.currentStage, 'change');
    assert.equal(state.activeChange, changeId);

    // PROPOSAL 初稿内容
    const proposal = readFileSync(result.proposalPath, 'utf-8');
    assert.ok(proposal.includes(goal), '应包含 light 原目标');
    assert.ok(proposal.includes('migration-change'), '应包含命中的 rule id');
    assert.ok(proposal.includes('migrations/001.sql'), '应包含命中的文件');
    assert.ok(proposal.includes('spike'), '应含 spike 标记');
    assert.match(proposal, /Pipeline\*\*: full/);
    assert.match(proposal, /uiImpact\*\*: false/);

    // change 门禁：恰好 1 条未勾选待澄清项
    assert.equal(countOpenQuestions(proposal), 1);

    // EXECUTION 追加 ## upgrade
    const execution = readFileSync(join(root, '.gantry', 'specs', changeId, 'EXECUTION.md'), 'utf-8');
    assert.match(execution, /## upgrade/);
    assert.match(execution, /- source: auto/);
    assert.match(execution, /- reason: migration-change/);
    assert.match(execution, /- files: migrations\/001\.sql/);

    // light.json 原地保留（升档不改写 history）
    assert.ok(existsSync(join(root, '.gantry', 'specs', changeId, 'light.json')));

    // 工作区逐字节不变
    const after = workspaceSnapshot(root);
    assert.equal(after.diff, before.diff, 'git diff HEAD 应逐字节一致');
    assert.equal(after.status, before.status, 'git status --porcelain（排除 .gantry/）应逐字节一致');
  });
});

describe('upgradeToFull · manual（AC-13）', () => {
  it('无 light.json 也能升档，intent 降级为空，reason: manual', () => {
    const root = makeRoot();
    const changeId = 'legacy-light-1';
    // 存量 light（无 light.json）—— readState 不归一化（stage=idle）
    writeStateFixture(root, { pipeline: 'light', activeChange: changeId, currentStage: 'idle' });

    const result = upgradeToFull(root, { source: 'manual' });

    assert.equal(result.changeId, changeId);
    const state = readState(root);
    assert.equal(state.pipeline, 'full');
    assert.equal(state.currentStage, 'change');

    const proposal = readFileSync(result.proposalPath, 'utf-8');
    // 目标缺失 → 回落到 changeId
    assert.ok(proposal.includes(changeId));
    assert.equal(countOpenQuestions(proposal), 1);

    const execution = readFileSync(join(root, '.gantry', 'specs', changeId, 'EXECUTION.md'), 'utf-8');
    assert.match(execution, /- source: manual/);
    assert.match(execution, /- reason: manual/);
  });
});

describe('upgradeToFull · 预置 PROPOSAL 改名保留（D20 · F-03）', () => {
  // D20: 预置 PROPOSAL 会顶替升档初稿（F-03）。
  // 旧语义「已有 PROPOSAL.md 时改写 PROPOSAL.upgrade.md」已 drop —— change 门禁只读
  // 规范名 PROPOSAL.md，初稿落到 .upgrade.md 会让门禁读到旧的「待澄清=无」而放行。
  // replacement：初稿一律写规范名，旧件改名为 PROPOSAL.pre-light.md 保留。
  it('旧 PROPOSAL.md 改名为 PROPOSAL.pre-light.md（内容不变），规范名写初稿', () => {
    const root = makeRoot();
    const changeId = 'has-proposal';
    writeStateFixture(root, { pipeline: 'light', activeChange: changeId, currentStage: 'fast' });
    const changeDir = writeLightJson(root, changeId, { goal: '改点东西', scope: ['src/a.mjs'] });

    const original = '# PROPOSAL: 旧事实，别覆盖我\n\n## 待澄清问题\n\n无\n';
    writeFileSync(join(changeDir, 'PROPOSAL.md'), original, 'utf-8');

    const result = upgradeToFull(root, {
      source: 'auto',
      hits: [{ ruleId: 'out-of-scope', files: ['src/b.mjs'] }],
    });

    // 规范名承载本轮初稿
    assert.match(result.proposalPath, /PROPOSAL\.md$/);
    assert.ok(existsSync(join(changeDir, 'PROPOSAL.md')));
    assert.ok(!existsSync(join(changeDir, 'PROPOSAL.upgrade.md')), '不再写 PROPOSAL.upgrade.md');

    // 旧件改名保留，字节不变
    assert.ok(existsSync(join(changeDir, 'PROPOSAL.pre-light.md')), '旧 PROPOSAL 应改名保留');
    assert.equal(
      readFileSync(join(changeDir, 'PROPOSAL.pre-light.md'), 'utf-8'),
      original,
      '旧 PROPOSAL 内容不得变',
    );

    // 规范名 = 本轮初稿，恰好 1 条未勾选待澄清项（change 门禁据此保持锁）
    const proposal = readFileSync(join(changeDir, 'PROPOSAL.md'), 'utf-8');
    assert.ok(proposal.includes('改点东西'), '初稿应含 light 原目标');
    assert.ok(proposal.includes('out-of-scope'), '初稿应含命中 rule id');
    assert.equal(countOpenQuestions(proposal), 1);
  });

  it('PROPOSAL.pre-light.md 已存在 → 旧件落到 PROPOSAL.pre-light.2.md', () => {
    const root = makeRoot();
    const changeId = 'has-pre-light';
    writeStateFixture(root, { pipeline: 'light', activeChange: changeId, currentStage: 'fast' });
    const changeDir = writeLightJson(root, changeId, { goal: '再改点东西', scope: ['src/a.mjs'] });

    const original = '# PROPOSAL: 这一轮要保留的旧件\n\n## 待澄清问题\n\n无\n';
    const olderPreLight = '# PROPOSAL: 更早的一版\n';
    writeFileSync(join(changeDir, 'PROPOSAL.md'), original, 'utf-8');
    writeFileSync(join(changeDir, 'PROPOSAL.pre-light.md'), olderPreLight, 'utf-8');

    const result = upgradeToFull(root, { source: 'manual' });

    assert.match(result.proposalPath, /PROPOSAL\.md$/);
    // .pre-light.md 被占用 → 递增到 .2，两件旧事实都不得被覆盖
    assert.equal(readFileSync(join(changeDir, 'PROPOSAL.pre-light.md'), 'utf-8'), olderPreLight);
    assert.equal(readFileSync(join(changeDir, 'PROPOSAL.pre-light.2.md'), 'utf-8'), original);
    assert.equal(countOpenQuestions(readFileSync(join(changeDir, 'PROPOSAL.md'), 'utf-8')), 1);
  });
});

describe('upgradeToFull · 前置校验', () => {
  it('已是 full → 抛错并提示「已是 full」', () => {
    const root = makeRoot();
    writeStateFixture(root, { pipeline: 'full', activeChange: 'already-full', currentStage: 'change' });

    assert.throws(
      () => upgradeToFull(root, { source: 'manual' }),
      /已是 full/,
    );
  });

  it('无活跃 change → 抛错', () => {
    const root = makeRoot();
    writeStateFixture(root, { pipeline: 'light', activeChange: null, currentStage: 'idle' });

    assert.throws(
      () => upgradeToFull(root, { source: 'manual' }),
      /没有活跃 change/,
    );
  });
});

describe('renderUpgradeProposal', () => {
  it('空 intent 不抛错，仍有恰好 1 条未勾选待澄清项', () => {
    const md = renderUpgradeProposal({ changeId: 'empty-1', intent: {}, hits: [], source: 'manual' });
    assert.equal(typeof md, 'string');
    assert.ok(md.includes('empty-1'), 'goal 回落到 changeId');
    assert.ok(md.includes('spike'));
    assert.equal(countOpenQuestions(md), 1);
  });

  it('命中项渲染 ruleId + 文件 + detail；无文件时用 —', () => {
    const md = renderUpgradeProposal({
      changeId: 'detail-1',
      intent: { goal: 'x' },
      hits: [
        { ruleId: 'guard-error', files: [], detail: 'git 不可用' },
        { ruleId: 'migration-change', files: ['migrations/001.sql', 'migrations/002.sql'] },
      ],
      source: 'auto',
    });
    assert.ok(md.includes('guard-error: — — git 不可用'));
    assert.ok(md.includes('migration-change: migrations/001.sql, migrations/002.sql'));
    assert.equal(countOpenQuestions(md), 1);
  });
});
