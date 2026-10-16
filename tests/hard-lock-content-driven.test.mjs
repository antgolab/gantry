/**
 * hard-lock-content-driven.test.mjs — requiresApproval 内容驱动分支单测
 *
 * 覆盖 change hard-lock 的 4 条判定路径:
 *   1. PROPOSAL「## 待澄清问题」有未勾选 `- [ ]` → 锁
 *   2. 段清空(勾选完 / 段留白 / 段填「无」) → 放行
 *   3. PROPOSAL 缺失 / specsDir 缺失 → 保守锁
 *   4. design / integration 不受 PROPOSAL 内容影响,始终锁
 *
 * 与 approval-gate.test.mjs 的区别:那里通过 execSync 派生 CLI 走端到端,
 * 这里聚焦纯函数分支,快、稳、语义单一。
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requiresApproval } from '../src/lib/phases.mjs';

function makeSpecsDir(proposalContent) {
  const root = mkdtempSync(join(tmpdir(), 'hardlock-'));
  const specsDir = join(root, 'CHG-001');
  mkdirSync(specsDir, { recursive: true });
  if (proposalContent != null) {
    writeFileSync(join(specsDir, 'PROPOSAL.md'), proposalContent, 'utf-8');
  }
  return { root, specsDir };
}

test('change · PROPOSAL 有未勾选待澄清问题 → 保持锁', () => {
  const { root, specsDir } = makeSpecsDir(`# 变更提案

## 待澄清问题

- [ ] 未决问题 A
- [x] 已决问题 B
`);
  try {
    assert.equal(requiresApproval('change', specsDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('change · PROPOSAL 待澄清问题段全部勾选 → 放行', () => {
  const { root, specsDir } = makeSpecsDir(`# 变更提案

## 待澄清问题

- [x] 已决问题 A
- [x] 已决问题 B
`);
  try {
    assert.equal(requiresApproval('change', specsDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('change · PROPOSAL 待澄清问题段留白 → 放行', () => {
  const { root, specsDir } = makeSpecsDir(`# 变更提案

## 待澄清问题

## 下一节
`);
  try {
    assert.equal(requiresApproval('change', specsDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('change · PROPOSAL 待澄清问题段写「无」 → 放行', () => {
  const { root, specsDir } = makeSpecsDir(`# 变更提案

## 待澄清问题

无

## 下一节
`);
  try {
    assert.equal(requiresApproval('change', specsDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('change · PROPOSAL 缺失 → 保守锁', () => {
  const { root, specsDir } = makeSpecsDir(null); // 不写 PROPOSAL.md
  try {
    assert.equal(requiresApproval('change', specsDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('change · specsDir 未传 → 保守锁', () => {
  assert.equal(requiresApproval('change', undefined), true);
  assert.equal(requiresApproval('change', null), true);
});

test('change · 其他段落的未勾选 checkbox 不影响判定', () => {
  // 「## 影响面」等其他段落 checkbox 不能污染「待澄清问题」段
  const { root, specsDir } = makeSpecsDir(`# 变更提案

## 影响面

- [ ] 前端
- [ ] 后端

## 待澄清问题

- [x] 已决问题 A
`);
  try {
    assert.equal(requiresApproval('change', specsDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('design · 无条件锁,不看 PROPOSAL 内容', () => {
  const { root, specsDir } = makeSpecsDir(`# 变更提案

## 待澄清问题

无
`);
  try {
    // 即使 change 已清空,design 关卡仍需人工确认
    assert.equal(requiresApproval('design', specsDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration · 无条件锁,不看 PROPOSAL 内容', () => {
  const { root, specsDir } = makeSpecsDir(`# 变更提案

## 待澄清问题

无
`);
  try {
    assert.equal(requiresApproval('integration', specsDir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('design / integration · specsDir 缺失也仍然锁', () => {
  assert.equal(requiresApproval('design', undefined), true);
  assert.equal(requiresApproval('integration', undefined), true);
});

test('非关卡阶段 · 始终放行', () => {
  for (const stage of ['requirement', 'task', 'dev', 'test', 'review', 'idle', 'fast']) {
    assert.equal(requiresApproval(stage, undefined), false, `${stage} 不应触发人工关卡`);
  }
});
