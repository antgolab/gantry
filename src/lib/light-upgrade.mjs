/**
 * light-upgrade.mjs — light → full 单向升档
 *
 * 用途:light change 的守卫命中(D13 · source=auto)或用户显式 `gantry pipeline full`
 * (AC-13 · source=manual)时,把已经写在工作区的代码原样保留,把 STATE 切到
 * full@change,并落一份 PROPOSAL 初稿让 full 的 change 硬锁接管人工确认。
 *
 * 约束:
 * - 只读 `.gantry/specs/<id>/light.json`(由 CLI 在 light 入口写入,升档过程不改写),
 *   并把 PROPOSAL / EXECUTION / STATE 写入 `.gantry/` 内。绝不触碰工作区代码,
 *   不执行任何 git 命令。
 * - 初稿一律写规范名 `PROPOSAL.md`(D20 —— change 门禁只读规范名)。已有提案绝不覆盖,
 *   改名为 `PROPOSAL.pre-light.md`(占用则 `.pre-light.2.md`,依次递增)保留旧事实。
 * - light.json 缺失(存量 light / legacy 手动升档)不是错误:intent 按空对象降级。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPECS_DIR } from './paths.mjs';
import { resolveArtifactPath } from './artifacts.mjs';
import { readState, updateState } from './state.mjs';

/** 升档初稿的规范名(change 门禁读它)。 */
const PROPOSAL_NAME = 'PROPOSAL.md';
/** 既有提案改名保留时的前缀(D20)。 */
const PRE_LIGHT_BASE = 'PROPOSAL.pre-light';

/**
 * 渲染升档用 PROPOSAL 初稿(纯函数)。
 *
 * 结构对齐 `templates/PROPOSAL.md`,但内容换成「light 升档」语义:
 * 意图(Why/What/验收线/原范围)、守卫命中(rule id + 文件 + detail)、
 * spike 标记,以及恰好一条未勾选的待澄清项——它让 full 的 change 门禁
 * (phases.mjs#countOpenQuestions) 天然阻断,人工确认在 full 侧发生(D13)。
 *
 * 所有 intent 字段缺失时降级(goal → changeId,accept / scope → 空列表),不抛错。
 *
 * @param {object} input
 * @param {string} input.changeId
 * @param {{ goal?: string, accept?: string[], scope?: string[], verify?: string }} [input.intent]
 * @param {Array<{ ruleId: string, files?: string[], detail?: string }>} [input.hits]
 * @param {'auto'|'manual'} [input.source]
 * @returns {string} markdown
 */
export function renderUpgradeProposal({ changeId, intent, hits, source } = {}) {
  const id = typeof changeId === 'string' && changeId.trim() ? changeId.trim() : 'unnamed-change';
  const it = intent && typeof intent === 'object' ? intent : {};

  const goal = typeof it.goal === 'string' && it.goal.trim() ? it.goal.trim() : id;
  const accept = toStringList(it.accept);
  const scope = toStringList(it.scope);

  const hitList = Array.isArray(hits) ? hits.filter((h) => h && typeof h === 'object') : [];
  const src = source === 'manual' ? 'manual' : 'auto';
  const sourceLabel = src === 'auto'
    ? '守卫命中（auto）'
    : '手动执行 `gantry pipeline full`（manual）';

  const today = new Date().toISOString().slice(0, 10);

  const hitLines = hitList.length > 0
    ? hitList.map((h) => {
      const files = toStringList(h.files).join(', ') || '—';
      const detail = typeof h.detail === 'string' && h.detail.trim() ? ` — ${h.detail.trim()}` : '';
      return `- ${typeof h.ruleId === 'string' && h.ruleId ? h.ruleId : 'unknown'}: ${files}${detail}`;
    })
    : ['- （无守卫命中记录）'];

  const acceptLines = accept.length > 0
    ? accept.map((a) => `- ${a}`)
    : ['- 待补：light 意图未声明验收线，需在 change 阶段反问确认'];

  const scopeText = scope.length > 0 ? scope.join(', ') : '未声明';

  return `# PROPOSAL: ${goal}

- **Change ID**: ${id}
- **创建日期**: ${today}
- **Pipeline**: full
- **uiImpact**: false
- **状态**: draft

---

## Why（为什么做）

本 change 由 light 档升级为 full，来源：${sourceLabel}。light 阶段的意图与已写代码保留，转入 full 的 change 阶段重新对齐。

升级原因（守卫命中项）：

${hitLines.join('\n')}

## What（做什么）

${goal}

## 影响面

- [ ] 影响 \`SPEC.md\`
- [ ] 影响 \`DESIGN.md\` / 引入新 ADR
- [ ] 影响现有 AC
- [ ] 影响数据模型 / 迁移
- [ ] 影响外部 API 兼容性
- [ ] 仅修复 bug，无范围变化

## 范围排除（这次不做）

- 待 change 阶段反问用户后补全（light 升档时未声明范围排除）

## 验收线（粗粒度，不是 AC）

${acceptLines.join('\n')}

## 风险与未知

- 已有代码为 light 阶段的 spike，需在 full dev 阶段按 TASKS 重新对齐，并补 AC 派生测试（R5.1）
- 原 light 允许改动范围：${scopeText}

## 待澄清问题（阻断推进 · 必须全部解决）

> change 阶段没问清的点列在这里。每条都**必须先反问用户、拿到答案、把结论合并进上面的 Why/What/影响面，然后划掉本条**。
> 本段存在任何未勾选项（\`- [ ]\`）时，推进会被门禁阻断。

- [ ] 确认 spike 范围与升档原因，补全范围排除

---

> full 的后续 AC 与设计细节进入 \`SPEC.md\` / \`DESIGN.md\`；spike 代码在工作区保留，不随升档丢失。
`;
}

/**
 * 执行升档:写 PROPOSAL 初稿 + 追加 EXECUTION `## upgrade` + STATE → full@change。
 *
 * 步骤(见 TASKS T05 / DESIGN D13):
 *   1. readState(readState 可能已做过存量归一化);无 activeChange 抛错;已是 full 抛错。
 *   2. 读 light.json(缺失 → intent={} 继续,覆盖 legacy 手动升档)。
 *   3. 写规范名 PROPOSAL.md;已有提案改名为 PROPOSAL.pre-light[.N].md 保留(D20)。
 *   4. 追加 EXECUTION 的 `## upgrade` 段(缺失则创建)。
 *   5. updateState → full@change / planner / 清 pauseReason 与 retries。
 *
 * @param {string} projectRoot
 * @param {{ source?: 'auto'|'manual', hits?: Array<object> }} [options]
 * @returns {{ changeId: string, proposalPath: string }}
 */
export function upgradeToFull(projectRoot, { source, hits } = {}) {
  const state = readState(projectRoot);

  const changeId = state?.activeChange;
  if (!changeId) {
    throw new Error('升档失败：当前没有活跃 change（STATE 活跃 Change 为「无」）。');
  }
  if (state.pipeline === 'full') {
    throw new Error(`升档失败：${changeId} 已是 full 档，不支持重复升档。`);
  }

  const src = source === 'manual' ? 'manual' : 'auto';
  const hitList = Array.isArray(hits)
    ? hits.filter((h) => h && typeof h === 'object')
    : [];

  const intent = readLightIntent(projectRoot, changeId);

  const changeDir = join(projectRoot, SPECS_DIR, changeId);
  mkdirSync(changeDir, { recursive: true });

  // D20 · F-03：初稿一律写规范名 PROPOSAL.md —— change 门禁（phases.mjs#requiresApproval
  // / checkProposalReady）只读规范名。已有提案（PROPOSAL.md 或兼容别名 CHANGE.md）绝不
  // 静默覆盖：改名为 PROPOSAL.pre-light[.N].md 保留旧事实，再把本轮初稿写到规范名上。
  const existing = resolveArtifactPath(changeDir, 'proposal');
  if (existing && existsSync(existing.path)) {
    renameSync(existing.path, join(changeDir, nextPreLightName(changeDir)));
  }
  const proposalPath = join(changeDir, PROPOSAL_NAME);

  const markdown = renderUpgradeProposal({ changeId, intent, hits: hitList, source: src });
  writeFileSync(proposalPath, markdown, 'utf-8');

  appendExecutionUpgrade(changeDir, { source: src, hits: hitList });

  updateState(projectRoot, {
    pipeline: 'full',
    currentStage: 'change',
    activeAgent: 'planner',
    pauseReason: null,
    retries: 0,
  });

  return { changeId, proposalPath };
}

// --- 内部辅助 ---

/**
 * 为既有提案选一个空着的 `PROPOSAL.pre-light[.N].md` 文件名 —— 绝不覆盖。
 * 首选 `PROPOSAL.pre-light.md`；被占用则 `PROPOSAL.pre-light.2.md`、`.3.md` 依次递增。
 */
function nextPreLightName(changeDir) {
  const first = `${PRE_LIGHT_BASE}.md`;
  if (!existsSync(join(changeDir, first))) return first;
  for (let n = 2; ; n += 1) {
    const candidate = `${PRE_LIGHT_BASE}.${n}.md`;
    if (!existsSync(join(changeDir, candidate))) return candidate;
  }
}

/** 读 `.gantry/specs/<id>/light.json`;缺失 / 非法 JSON → 空对象(不是错误)。 */
function readLightIntent(projectRoot, changeId) {
  const lightPath = join(projectRoot, SPECS_DIR, changeId, 'light.json');
  if (!existsSync(lightPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(lightPath, 'utf-8'));
    return parsed && typeof parsed === 'object' && parsed.intent && typeof parsed.intent === 'object'
      ? parsed.intent
      : {};
  } catch {
    return {};
  }
}

/** 向 change 的 EXECUTION.md 追加 `## upgrade` 段(文件缺失则连同标题创建)。 */
function appendExecutionUpgrade(changeDir, { source, hits }) {
  const resolved = resolveArtifactPath(changeDir, 'execution');
  const executionPath = resolved.path;

  const ruleIds = [...new Set(hits.map((h) => h.ruleId).filter((r) => typeof r === 'string' && r))];
  const files = [...new Set(hits.flatMap((h) => toStringList(h.files)))];
  const reason = ruleIds.length > 0 ? ruleIds.join(', ') : 'manual';
  const filesLine = files.length > 0 ? files.join(', ') : '—';

  const section = [
    '## upgrade',
    '',
    `- at: ${new Date().toISOString()}`,
    `- source: ${source}`,
    `- reason: ${reason}`,
    `- files: ${filesLine}`,
    '',
  ].join('\n');

  const existing = existsSync(executionPath) ? readFileSync(executionPath, 'utf-8') : '';
  const prefix = existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n` : '';
  writeFileSync(executionPath, `${prefix}${section}`, 'utf-8');
}

/** 过滤出非空字符串数组(容忍 undefined / 非数组 / 混杂类型)。 */
function toStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
}
