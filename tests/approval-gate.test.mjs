import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { approveStage, isStageApproved, readState, writeState, readFence } from '../src/lib/state.mjs';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');

let tmpDir;

const run = (cmd, opts = {}) =>
  execSync(`node ${CLI} ${cmd}`, { encoding: 'utf-8', timeout: 15000, cwd: tmpDir, ...opts });

// 写一份能过门禁（待澄清问题=无）的 PROPOSAL
function seedProposal(changeId) {
  const specsDir = join(tmpDir, '.gantry/specs', changeId);
  writeFileSync(join(specsDir, 'PROPOSAL.md'),
    `# PROPOSAL — ${changeId}\n\n## Why\nx\n\n## 待澄清问题\n\n无\n\n---\n`);
}

function readStage() {
  const md = readFileSync(join(tmpDir, '.gantry/planning/STATE.md'), 'utf-8');
  return md.match(/当前阶段\*\*:\s*`(.+?)`/)?.[1];
}

function readActiveAgent() {
  const md = readFileSync(join(tmpDir, '.gantry/planning/STATE.md'), 'utf-8');
  return md.match(/活跃 Agent\*\*:\s*`(.+?)`/)?.[1];
}

function seedArtifact(changeId, name, content) {
  writeFileSync(join(tmpDir, '.gantry/specs', changeId, name), content, 'utf-8');
}

beforeEach(() => {
  tmpDir = join(import.meta.dirname, '..', '.test-tmp-approval-' + Date.now());
  mkdirSync(tmpDir, { recursive: true });
  execSync(`node ${CLI} install --tool claude --pipeline full`, { cwd: tmpDir, encoding: 'utf-8' });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('人工确认关卡 · 派生策略', () => {
  it('auto 可经过 requirement，但进入 design 后暂停', () => {
    run('change --tier full "add feature x"');
    seedProposal('add-feature-x');
    seedArtifact('add-feature-x', 'SPEC.md', '# SPEC\n');

    approveStage(tmpDir, 'change');
    const out = run('auto');
    assert.match(out, /需人工确认|⏸/);
    assert.equal(readStage(), 'design');
  });

  it('auto --trust 已移除，不能绕过人工确认', () => {
    assert.throws(() => run('auto --trust'), /--trust 已移除/);
  });

  it('内部 gantry advance 只推进一个阶段，不循环', () => {
    run('change --tier full "add feature y"');
    seedProposal('add-feature-y');

    run('advance'); // change → requirement，且到此为止（不循环冲向 design）
    assert.equal(readStage(), 'requirement');
  });

  it('advance 不接受 --auto（多阶段由 auto 独占）', () => {
    run('change --tier full "add feature w"');
    seedProposal('add-feature-w');

    // 传 --auto 应被当作未知 flag 忽略，行为等同纯单步：只推进一步
    run('advance --auto');
    assert.equal(readStage(), 'requirement', 'advance --auto 不应再循环多步');
  });

  it('CLI gantry next 不是 CLI 命令，引导到 IDE skill', () => {
    assert.throws(() => run('next'), /是 IDE skill.*\/gantry-next/s);
  });

  it('status 显示当前 approval 阶段需人工确认', () => {
    run('change --tier full "add feature z"');
    seedProposal('add-feature-z');
    seedArtifact('add-feature-z', 'SPEC.md', '# SPEC\n');
    run('advance'); // 进入 requirement
    run('advance'); // 进入 design

    const out = run('status');
    assert.match(out, /需人工确认/);
  });

  it('advance 后 activeAgent 跟随目标阶段更新', () => {
    run('change --tier full "add feature agent"');
    seedProposal('add-feature-agent');
    assert.equal(readActiveAgent(), 'planner');

    run('advance'); // change → requirement
    assert.equal(readStage(), 'requirement');
    assert.equal(readActiveAgent(), 'planner');

    writeFileSync(join(tmpDir, '.gantry/specs/add-feature-agent/SPEC.md'), '# SPEC\n\n## AC\n- AC-1\n', 'utf-8');
    run('advance'); // requirement → design
    assert.equal(readStage(), 'design');
    assert.equal(readActiveAgent(), 'architect');
  });
});

describe('门禁绕过', () => {
  it('advance --skip 不能绕过未批准的 change', () => {
    run('change --tier full "risky change"');
    // 故意不 seed PROPOSAL 的待澄清清空 → 直接 --skip 绕过 requirement 门禁
    // （PROPOSAL 由 change 未创建，requirement 门禁必失败）
    assert.throws(() => run('advance --skip'), /advance --approve change/);
    assert.equal(readStage(), 'change');
  });

  it('正常推进不显示 skip 提示', () => {
    run('change "clean change"');
    seedProposal('clean-change');
    run('advance'); // 正常推进，无绕过

    const statusOut = run('status');
    assert.doesNotMatch(statusOut, /本 change 有/);
  });
});


describe('内容绑定的人工批准', () => {
  it('integration 先等待显式批准，再返回终态；工件变化后重新等待', () => {
    run('change --tier full "integration approval"');
    writeState(tmpDir, { ...readState(tmpDir), currentStage: 'integration' });
    seedArtifact('integration-approval', 'UAT.md', '# UAT\nreviewed bytes\n');
    const advance = (...args) => {
      const result = spawnSync(process.execPath, [CLI, 'advance', '--json', ...args], { cwd: tmpDir, encoding: 'utf8' });
      return { ...result, outcome: JSON.parse(result.stdout) };
    };
    const pending = advance('--skip');
    assert.equal(pending.status, 2, pending.stderr);
    assert.equal(pending.outcome.pausedForApproval, 'integration');
    assert.equal(isStageApproved(tmpDir, 'integration'), false);
    assert.equal(advance('--approve', 'design').status, 2);
    const approved = advance('--approve', 'integration');
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(approved.outcome.reachedEnd, 'integration');
    assert.equal(isStageApproved(tmpDir, 'integration'), true);
    assert.ok(readFence(tmpDir).approvals.integration.digest);
    assert.equal(readState(tmpDir).pauseReason, null);
    assert.equal(readStage(), 'integration');
    assert.equal(readFileSync(join(tmpDir, '.gantry/specs/integration-approval/UAT.md'), 'utf8'), '# UAT\nreviewed bytes\n');
    assert.equal(existsSync(join(tmpDir, '.gantry/specs/_archive/integration-approval')), false);
    seedArtifact('integration-approval', 'REVIEW.md', '# REVIEW\nchanged evidence\n');
    assert.equal(isStageApproved(tmpDir, 'integration'), false);
    assert.equal(advance().outcome.pausedForApproval, 'integration');
  });

  function enterDesign() {
    run('change --tier full "approval binding"');
    seedProposal('approval-binding');
    seedArtifact('approval-binding', 'SPEC.md', '# SPEC\n');
    run('advance');
    run('advance');
    seedArtifact('approval-binding', 'DESIGN.md', '# DESIGN\nreviewed bytes\n');
  }

  it('design 未获批准时 --skip 仍被阻止，错误阶段批准也被拒绝', () => {
    enterDesign();
    assert.throws(() => run('advance --skip'), /advance --approve design/);
    assert.equal(readStage(), 'design');
    assert.throws(() => run('advance --approve change'), /当前人工确认阶段/);
    assert.equal(readStage(), 'design');
  });

  it('批准绑定工件摘要，改写已批准设计后失效', () => {
    enterDesign();
    approveStage(tmpDir, 'design');
    assert.equal(isStageApproved(tmpDir, 'design'), true);
    seedArtifact('approval-binding', 'DESIGN.md', '# DESIGN\nchanged after review\n');
    assert.equal(isStageApproved(tmpDir, 'design'), false);
    assert.throws(() => run('advance --skip'), /advance --approve design/);
    assert.equal(readStage(), 'design');
  });

  it('advance --json 仅输出JSON，进入人工关卡返回2；普通进入design返回0', () => {
    run('change --tier full "json approval"');
    seedProposal('json-approval');
    seedArtifact('json-approval', 'SPEC.md', '# SPEC\n');
    run('advance');
    const json = spawnSync(process.execPath, [CLI, 'advance', '--json'], { cwd: tmpDir, encoding: 'utf8' });
    assert.equal(json.status, 2, json.stderr);
    assert.equal(JSON.parse(json.stdout).pausedForApproval, 'design');
    assert.equal(readStage(), 'design');
  });
});
