import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

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
    run('change "add feature x"');
    seedProposal('add-feature-x');
    seedArtifact('add-feature-x', 'SPEC.md', '# SPEC\n');

    const out = run('auto');
    assert.match(out, /需人工确认|⏸/);
    assert.equal(readStage(), 'design');
  });

  it('auto --trust 已移除，不能绕过人工确认', () => {
    assert.throws(() => run('auto --trust'), /--trust 已移除/);
  });

  it('内部 gantry advance 只推进一个阶段，不循环', () => {
    run('change "add feature y"');
    seedProposal('add-feature-y');

    run('advance'); // change → requirement，且到此为止（不循环冲向 design）
    assert.equal(readStage(), 'requirement');
  });

  it('advance 不接受 --auto（多阶段由 auto 独占）', () => {
    run('change "add feature w"');
    seedProposal('add-feature-w');

    // 传 --auto 应被当作未知 flag 忽略，行为等同纯单步：只推进一步
    run('advance --auto');
    assert.equal(readStage(), 'requirement', 'advance --auto 不应再循环多步');
  });

  it('CLI gantry next 不是 CLI 命令，引导到 IDE skill', () => {
    assert.throws(() => run('next'), /是 IDE skill.*\/gantry-next/s);
  });

  it('status 显示当前 approval 阶段需人工确认', () => {
    run('change "add feature z"');
    seedProposal('add-feature-z');
    seedArtifact('add-feature-z', 'SPEC.md', '# SPEC\n');
    run('advance'); // 进入 requirement
    run('advance'); // 进入 design

    const out = run('status');
    assert.match(out, /需人工确认/);
  });

  it('advance 后 activeAgent 跟随目标阶段更新', () => {
    run('change "add feature agent"');
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
  it('advance --skip 绕过门禁并推进', () => {
    run('change "risky change"');
    // 故意不 seed PROPOSAL 的待澄清清空 → 直接 --skip 绕过 requirement 门禁
    // （PROPOSAL 由 change 未创建，requirement 门禁必失败）
    const skipOut = run('advance --skip');
    assert.match(skipOut, /跳过门禁/);
    assert.equal(readStage(), 'requirement');
  });

  it('正常推进不显示 skip 提示', () => {
    run('change "clean change"');
    seedProposal('clean-change');
    run('advance'); // 正常推进，无绕过

    const statusOut = run('status');
    assert.doesNotMatch(statusOut, /本 change 有/);
  });
});
