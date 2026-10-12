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
 *   - 已有 PROPOSAL 不覆盖：改写 PROPOSAL.upgrade.md，原文件字节不变
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

describe('upgradeToFull · 已有 PROPOSAL 不覆盖', () => {
  it('改写 PROPOSAL.upgrade.md，原 PROPOSAL.md 字节不变', () => {
    const root = makeRoot();
    const changeId = 'has-proposal';
    writeStateFixture(root, { pipeline: 'light', activeChange: changeId, currentStage: 'fast' });
    const changeDir = writeLightJson(root, changeId, { goal: '改点东西', scope: ['src/a.mjs'] });

    const original = '# PROPOSAL: 旧事实，别覆盖我\n\n- **Change ID**: has-proposal\n';
    writeFileSync(join(changeDir, 'PROPOSAL.md'), original, 'utf-8');

    const result = upgradeToFull(root, {
      source: 'auto',
      hits: [{ ruleId: 'out-of-scope', files: ['src/b.mjs'] }],
    });

    assert.match(result.proposalPath, /PROPOSAL\.upgrade\.md$/);
    assert.ok(existsSync(join(changeDir, 'PROPOSAL.upgrade.md')));
    assert.equal(readFileSync(join(changeDir, 'PROPOSAL.md'), 'utf-8'), original, '旧 PROPOSAL 不得被覆盖');
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
