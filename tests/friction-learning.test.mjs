/**
 * friction-learning.test.mjs — T15 curator 候选生成 + archive friction 汇总 hook
 *
 * 分两块:
 *   A) curator.proposeLearning 纯逻辑单测(脱敏 / body 结构 / promptStub / id·tags·source)
 *   B) cli archive 集成测(用 tmpdir 拉起 CLI + GANTRY_AUTO_CONFIRM 注入 y/n,绕过 stdin)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeLearning } from '../src/lib/curator.mjs';
import { recordEvent } from '../src/lib/friction.mjs';
import { writeState } from '../src/lib/state.mjs';
import { createStore } from '../src/lib/learnings/store.mjs';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');

// --- A) curator 纯逻辑 ---

describe('curator.proposeLearning 纯逻辑', () => {
  it('返回 { id, tags, source, body },body 含 场景/根因/解法/关键词 四段', () => {
    const events = [
      { kind: 'verifyFail', ts: '2026-09-14T12:00:00.000Z', meta: {} },
      { kind: 'userManualOverride', ts: '2026-09-14T12:05:00.000Z', meta: { taskId: 'T05' } },
    ];
    const doc = proposeLearning('demo', events);
    assert.equal(doc.id, 'friction-demo');
    assert.deepEqual(doc.tags, ['lesson', 'friction']);
    assert.equal(doc.source, 'demo');
    assert.match(doc.body, /## 场景/);
    assert.match(doc.body, /## 根因/);
    assert.match(doc.body, /## 解法/);
    assert.match(doc.body, /## 关键词/);
    assert.match(doc.body, /verifyFail, userManualOverride/);
    assert.match(doc.body, /userManualOverride — taskId=T05/);
  });

  it('脱敏:key 含 token|key|secret|password 或 value 为长 token 状字符串 → ***', () => {
    const events = [
      { kind: 'verifyFail', meta: { token: 'abc123', apiKey: 'xyz', secret: 's', password: 'p' } },
      { kind: 'userManualOverride', meta: { note: 'fine', longId: 'abcdefghijklmnopqrstuvwxyz123456' } },
    ];
    const doc = proposeLearning('demo', events);
    assert.match(doc.body, /token=\*\*\*/);
    assert.match(doc.body, /apiKey=\*\*\*/);
    assert.match(doc.body, /secret=\*\*\*/);
    assert.match(doc.body, /password=\*\*\*/);
    assert.match(doc.body, /longId=\*\*\*/);
    assert.match(doc.body, /note=fine/);
    assert.doesNotMatch(doc.body, /abc123/);
    assert.doesNotMatch(doc.body, /abcdefghijklmnopqrstuvwxyz123456/);
  });

  it('脱敏:JWT / Base64 padded / URL 内嵌 token / Bearer key 四类真实形态 → ***', () => {
    const events = [
      { kind: 'verifyFail', meta: { jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123defXYZ' } },
      { kind: 'verifyFail', meta: { note: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=' } },
      { kind: 'verifyFail', meta: { url: 'https://api.example.com/v1?token=sk_live_abc123xyz789def' } },
      { kind: 'verifyFail', meta: { authorization: 'Bearer abc123def456ghi789jkl0' } },
    ];
    const doc = proposeLearning('demo', events);
    assert.match(doc.body, /jwt=\*\*\*/);
    assert.match(doc.body, /note=\*\*\*/);
    assert.match(doc.body, /url=\*\*\*/);
    assert.match(doc.body, /authorization=\*\*\*/);
    assert.doesNotMatch(doc.body, /eyJhbGciOiJIUzI1NiJ9\.eyJzdWIiOiIxMjM0In0\.abc123defXYZ/);
    assert.doesNotMatch(doc.body, /YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=/);
    assert.doesNotMatch(doc.body, /https:\/\/api\.example\.com\/v1\?token=sk_live_abc123xyz789def/);
    assert.doesNotMatch(doc.body, /Bearer abc123def456ghi789jkl0/);
  });

  it('promptStub 注入根因/解法;缺省为 TODO', () => {
    const injected = proposeLearning('demo', [], { promptStub: { rootCause: 'RC-X', solution: 'SOL-Y' } });
    assert.match(injected.body, /RC-X/);
    assert.match(injected.body, /SOL-Y/);
    assert.doesNotMatch(injected.body, /TODO/);

    const defaults = proposeLearning('demo', []);
    assert.match(defaults.body, /## 根因\n\nTODO\n/);
    assert.match(defaults.body, /## 解法\n\nTODO\n/);
  });

  it('events 为空时场景为 (无事件),关键词为 (无)', () => {
    const doc = proposeLearning('demo', []);
    assert.match(doc.body, /## 场景\n- \(无事件\)/);
    assert.match(doc.body, /## 关键词\n\n\(无\)/);
  });
});

// --- B) archive friction 汇总 hook 集成 ---

describe('archive friction 汇总 hook', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'friction-learning-'));
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // 在 tmpDir 下:初始化 STATE(integration 阶段活跃 change)+ 记录 friction events。
  function setupProject(changeId, events) {
    writeState(tmpDir, {
      pipeline: 'full',
      activeChange: changeId,
      currentStage: 'integration',
      currentWave: null,
      currentTask: null,
      activeAgent: 'integrator',
      autonomous: false,
      stagesRun: 0,
      maxStages: 3,
      retries: 0,
      maxRetries: 3,
      pauseReason: null,
      verifyFailCount: 0,
      contextUsage: { tokens: null, windowPercent: null },
    });
    for (const e of events) recordEvent(changeId, e, { baseDir: join(tmpDir, '.gantry', 'specs') });
  }

  function runArchive(args = [], env = {}) {
    return execFileSync(process.execPath, [CLI, 'archive', ...args], {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 20000,
      env: { ...process.env, ...env },
    });
  }

  const overThreshold = [
    { kind: 'verifyFail', ts: '2026-09-14T12:00:00.000Z', meta: { taskId: 'T01' } },
    { kind: 'verifyFail', ts: '2026-09-14T12:01:00.000Z', meta: { taskId: 'T02' } },
    { kind: 'userManualOverride', ts: '2026-09-14T12:02:00.000Z', meta: { note: 'manual' } },
  ]; // score = 2 + 2 + 3 = 7 ≥ 5

  it("autoConfirmChoice='y' → 写盘 team/friction-<id>.md 且 frontmatter 完整", async () => {
    setupProject('demo', overThreshold);
    const out = runArchive([], { GANTRY_AUTO_CONFIRM: 'y' });
    assert.match(out, /变更已收尾: demo/);
    assert.match(out, /学习已写入/);

    const store = createStore(join(tmpDir, '.gantry', 'learnings'));
    const doc = await store.read('team', 'friction-demo');
    assert.ok(doc, 'team/friction-demo.md 应存在');
    assert.equal(doc.frontmatter.id, 'friction-demo');
    assert.equal(doc.frontmatter.scope, 'team');
    assert.equal(doc.frontmatter.source, 'demo');
    assert.deepEqual(doc.frontmatter.tags, ['lesson', 'friction']);
    assert.equal(typeof doc.frontmatter.createdAt, 'string');
    assert.equal(doc.frontmatter.hitCount, 0);
    assert.equal(doc.frontmatter.lastHitAt, null);
    assert.match(doc.body, /## 场景/);
    assert.match(doc.body, /## 根因/);
    assert.match(doc.body, /## 解法/);
    assert.match(doc.body, /## 关键词/);
    assert.match(doc.body, /verifyFail, userManualOverride/);
  });

  it("autoConfirmChoice='n' → 不写盘", () => {
    setupProject('demo', overThreshold);
    const out = runArchive([], { GANTRY_AUTO_CONFIRM: 'n' });
    assert.match(out, /已跳过 friction 学习/);
    assert.equal(existsSync(join(tmpDir, '.gantry', 'learnings', 'team', 'friction-demo.md')), false);
  });

  it('--skip-learning → 完全跳过(即使 score 过阈)', () => {
    setupProject('demo', overThreshold);
    const out = runArchive(['--skip-learning'], { GANTRY_AUTO_CONFIRM: 'y' });
    assert.match(out, /变更已收尾: demo/);
    assert.doesNotMatch(out, /学习已写入/);
    assert.equal(existsSync(join(tmpDir, '.gantry', 'learnings', 'team', 'friction-demo.md')), false);
  });

  it('score < threshold → 不触发', () => {
    setupProject('demo', [{ kind: 'verifyFail', ts: '2026-09-14T12:00:00.000Z', meta: {} }]); // score 2 < 5
    const out = runArchive([], { GANTRY_AUTO_CONFIRM: 'y' });
    assert.match(out, /变更已收尾: demo/);
    assert.equal(existsSync(join(tmpDir, '.gantry', 'learnings', 'team', 'friction-demo.md')), false);
  });
});
