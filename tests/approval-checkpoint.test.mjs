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

beforeEach(() => {
  tmpDir = join(import.meta.dirname, '..', '.test-tmp-approval-' + Date.now());
  mkdirSync(tmpDir, { recursive: true });
  execSync(`node ${CLI} init --tool claude --pipeline standard`, { cwd: tmpDir, encoding: 'utf-8' });
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('approval checkpoint · 派生策略', () => {
  it('auto 进入 requirement(approval) 阶段即暂停', () => {
    run('change "add feature x"');
    seedProposal('add-feature-x');

    const out = run('auto');
    // change → requirement 后应停下（requirement 配 approval）
    assert.match(out, /需人工确认|⏸/);
    assert.equal(readStage(), 'requirement', '应停在 requirement，不继续冲到 design');
  });

  it('单步 gantry next 只推进一个阶段，不循环', () => {
    run('change "add feature y"');
    seedProposal('add-feature-y');

    run('next'); // change → requirement，且到此为止（不循环冲向 design）
    assert.equal(readStage(), 'requirement');
  });

  it('next 不再接受 --auto（多阶段由 auto 独占）', () => {
    run('change "add feature w"');
    seedProposal('add-feature-w');

    // 传 --auto 应被当作未知 flag 忽略，行为等同纯单步：只推进一步
    run('next --auto');
    assert.equal(readStage(), 'requirement', 'next --auto 不应再循环多步');
  });

  it('status 显示当前 approval 阶段需人工确认', () => {
    run('change "add feature z"');
    seedProposal('add-feature-z');
    run('next'); // 进入 requirement

    const out = run('status');
    assert.match(out, /需人工确认/);
  });
});

describe('门禁绕过留痕 · timeline 读写对称', () => {
  it('next --skip 绕过门禁后 status 显示绕过记录', () => {
    run('change "risky change"');
    // 故意不 seed PROPOSAL 的待澄清清空 → 直接 --skip 绕过 requirement 门禁
    // （PROPOSAL 由 change 未创建，requirement 门禁必失败）
    const skipOut = run('next --skip');
    assert.match(skipOut, /跳过门禁/);
    assert.match(skipOut, /timeline\.jsonl/);

    const statusOut = run('status');
    assert.match(statusOut, /门禁绕过记录/);
    assert.match(statusOut, /1 次/);
  });

  it('无绕过时 status 不显示绕过段', () => {
    run('change "clean change"');
    seedProposal('clean-change');
    run('next'); // 正常推进，无绕过

    const statusOut = run('status');
    assert.doesNotMatch(statusOut, /门禁绕过记录/);
  });
});
