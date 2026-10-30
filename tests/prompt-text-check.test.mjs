/**
 * prompt-text-check.test.mjs — T17 phase prompt + CLAUDE.md + LESSONS 迁移文本落位检查
 *
 * 纯 grep-based 断言：读取 8 个目标文件，断言关键短语 / 路径全部落位，
 * 另断言旧 LESSONS 老文件仍存在（兼容读 6 个月）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * 词边界匹配 micro 管线残留：允许 `microservice` 这类含 micro 的完整词，
 * 只拦截独立的 `micro`（如 `micro 档` / `micro(3 阶段)`）。
 */
const MICRO_RE = /(^|[^A-Za-z0-9_])micro([^A-Za-z0-9_]|$)/;

/**
 * 2-design.md § 8.5 字体层级里的 `micro` 是排版术语，不是管线档位；扫描前剔除这一固定短语，
 * 其余任何独立 `micro` 仍判为残留。
 */
const TYPOGRAPHY_MICRO = 'label / micro / mono';

describe('T17 · prompt 文本落位检查', () => {
  it('0-change.md 含 --tier + light，且不再含 tier-router', () => {
    const c = read('.gantry/core/phases/0-change.md');
    assert.ok(c.includes('--tier'), '应含 --tier');
    assert.ok(c.includes('light'), '应含 light');
    assert.ok(!c.includes('tier-router'), '不应再含已删除的 tier-router');
  });

  it('4-dev.md 已去 micro 档，且保留 R2.5 自愈上限', () => {
    const c = read('phases/4-dev.md');
    assert.ok(!MICRO_RE.test(c), '不应含 micro 管线档位');
    assert.ok(c.includes('R2.5'), '应含 R2.5');
    assert.ok(c.includes('receipt → EXECUTION → TASKS'), '完成协议应由控制器持证写入');
    assert.ok(!c.includes('整波 revert 到 wave 前'), '不得指导自动撤销用户工作区');
  });

  it('6-review.md 含 review_context_leak + review-lane-guard', () => {
    const c = read('.gantry/core/phases/6-review.md');
    assert.ok(c.includes('review_context_leak'), '应含 review_context_leak');
    assert.ok(c.includes('review-lane-guard'), '应含 review-lane-guard');
  });

  it('7-integration.md 含 friction + Curator 且移除手动提名 LESSONS', () => {
    const c = read('.gantry/core/phases/7-integration.md');
    assert.ok(c.includes('friction'), '应含 friction');
    assert.ok(c.includes('Curator'), '应含 Curator');
    assert.ok(!c.includes('提名与更新 LESSONS'), '不应再含旧手动提名段标题');
    assert.ok(!c.includes('按 LESSONS.md 的条目格式追加'), '不应再含旧手动追加表述');
  });

  it('K-knowledge.md 输出路径改为 .gantry/learnings/team/ + tags:[knowledge]', () => {
    const c = read('.gantry/core/phases/K-knowledge.md');
    assert.ok(c.includes('.gantry/learnings/team/'), '应含 .gantry/learnings/team/');
    assert.ok(c.includes('tags: [knowledge'), '应含 tags: [knowledge');
    assert.ok(!c.includes('.gantry/specs/knowledge/'), '不应残留旧 .gantry/specs/knowledge/ 路径');
  });

  it('F-fast.md 引用 src/lib/hard-rules.mjs 单点收敛', () => {
    const c = read('.gantry/core/phases/F-fast.md');
    assert.ok(c.includes('src/lib/hard-rules.mjs'), '应含 src/lib/hard-rules.mjs');
    assert.ok(c.includes('红线单点收敛'), '应含 红线单点收敛');
    assert.ok(c.includes('禁止'), '应含禁止重复定义表述');
  });

  it('T-FIX-09 · F-fast 红线段与 HARD_RULE_KEYWORDS 语义对齐', async () => {
    const fFast = read('.gantry/core/phases/F-fast.md');

    // 提取「不可进入 FAST 的变更」红线段（至下一节标题为止）
    const sectionStart = fFast.indexOf('## 不可进入 FAST 的变更');
    const sectionEnd = fFast.indexOf('## 执行协议', sectionStart);
    assert.ok(sectionStart >= 0, 'F-fast.md 应含「不可进入 FAST 的变更」标题');
    const redLine = fFast.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);

    // 「定义源」注释应位于红线段列表顶部（首个条目之前）
    const anchorIdx = redLine.indexOf('定义源:');
    const firstBullet = redLine.indexOf('\n- ');
    assert.ok(anchorIdx > 0, '红线段应含「定义源:」注释');
    assert.ok(firstBullet === -1 || anchorIdx < firstBullet, '「定义源:」注释应位于红线段列表顶部');
    assert.ok(redLine.includes('src/lib/hard-rules.mjs#HARD_RULE_KEYWORDS'), '应引用 src/lib/hard-rules.mjs#HARD_RULE_KEYWORDS');

    // 动态 import ES module 常量单点
    const { HARD_RULE_KEYWORDS } = await import('../src/lib/hard-rules.mjs');
    const kwText = HARD_RULE_KEYWORDS
      .flatMap((r) => r.keywords || [])
      .join(' ')
      .toLowerCase();

    // 语义类目 → 检测词（红线段实际用词）→ 期望命中关键词
    const categories = [
      { name: 'schema', detect: ['schema'], expect: ['schema'] },
      { name: '迁移', detect: ['迁移', 'migration'], expect: ['迁移', 'migration'] },
      { name: 'auth/认证', detect: ['鉴权', 'auth', '认证'], expect: ['auth', '鉴权', '认证'] },
      { name: '权限', detect: ['权限'], expect: ['permission', '权限'] },
    ];

    for (const cat of categories) {
      const mentioned = cat.detect.some((t) => redLine.toLowerCase().includes(t.toLowerCase()));
      if (!mentioned) continue;
      const matched = cat.expect.some((kw) => kwText.includes(kw.toLowerCase()));
      assert.ok(matched, `F-fast 红线段提到「${cat.name}」但 HARD_RULE_KEYWORDS 无对应关键词`);
    }
  });

  it('CLAUDE.md 红线段主语改 lane + R1.8 引用 .gantry/learnings/team/', () => {
    const c = read('CLAUDE.md');
    assert.ok(c.includes('Architect lane'), '应含 Architect lane');
    assert.ok(c.includes('Dev lane'), '应含 Dev lane');
    assert.ok(c.includes('Reviewer lane'), '应含 Reviewer lane');
    assert.ok(c.includes('grep `.gantry/learnings/team/`'), 'R1.8 应引用 .gantry/learnings/team/');
  });

  it('LESSONS.md 顶部含 MIGRATED to .gantry/learnings/team/', () => {
    const c = read('.gantry/specs/LESSONS.md');
    assert.ok(c.includes('> MIGRATED to .gantry/learnings/team/'), '应含 MIGRATED 提示行');
    assert.ok(c.split('\n')[0].trim().startsWith('> MIGRATED'), 'MIGRATED 提示应在首行');
  });

  it('LESSONS 老文件仍存在（兼容读 6 个月）', () => {
    assert.equal(existsSync(join(ROOT, '.gantry/specs/LESSONS.md')), true, '老 LESSONS.md 应保留');
  });
});

describe('AC-16 · micro 管线残留清零 + F-fast 描述新 light', () => {
  const phaseDir = join(ROOT, '.gantry/core/phases');
  const phaseFiles = readdirSync(phaseDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(phaseDir, f));

  // microservice 等含 micro 的完整词不算命中，独立 micro 才算
  it('phase 产物 / 两个公开 skill / docs/loop.md 均无 micro 管线描述', () => {
    const targets = [
      ...phaseFiles,
      join(ROOT, '.claude/skills/gantry-change/SKILL.md'),
      join(ROOT, '.claude/skills/gantry-auto/SKILL.md'),
      join(ROOT, 'docs/loop.md'),
    ];
    for (const target of targets) {
      const content = readFileSync(target, 'utf8').replaceAll(TYPOGRAPHY_MICRO, '');
      assert.ok(!MICRO_RE.test(content), `${target} 不应残留 micro 管线描述`);
    }
  });

  it('CLAUDE.md / AGENTS.md 不再描述旧 light 流程（change → fast → integration / 内部判定）', () => {
    for (const rel of ['CLAUDE.md', 'AGENTS.md']) {
      const content = read(rel);
      assert.ok(!content.includes('change → fast → integration'), `${rel} 不应含旧 light 状态机`);
      assert.ok(!content.includes('light 挡位由'), `${rel} 不应含「light 挡位由 change/auto 内部判定」`);
    }
  });

  it('F-fast.md 描述 light：含 light.json + gantry advance，且不要求 PROPOSAL', () => {
    const fFast = read('.gantry/core/phases/F-fast.md');
    assert.ok(fFast.includes('light.json'), '应含 light.json');
    assert.ok(fFast.includes('gantry advance'), '应含 gantry advance');

    // 输入段不得把 PROPOSAL 当作必需工件（light 只读 light.json 意图）
    const inputStart = fFast.indexOf('## 输入');
    const inputEnd = fFast.indexOf('\n## ', inputStart + 1);
    assert.ok(inputStart >= 0, 'F-fast.md 应含「## 输入」节');
    const inputSection = fFast.slice(inputStart, inputEnd === -1 ? undefined : inputEnd);
    assert.ok(!inputSection.includes('PROPOSAL'), '「输入」节不应要求 PROPOSAL');
  });
});
