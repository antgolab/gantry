// Codex renderer
// Produces:
//   AGENTS.md                                    — compact entry contract
//   .agents/skills/gantry-<name>/SKILL.md        — merged skill (orchestration + phase)
//
// Strategy: public orchestration commands load their phase through the context
// pack. Internal phases are not emitted as
// standalone user-facing skills.
// All public entry points are unified under gantry-* skills.
// Source files (phases/*.md, skills/*.md) remain unchanged.

import { PUBLIC_SKILLS, STAGE_PHASE_MAP } from '../lib/stage-map.mjs';

export function render(core, commands, agents) {
  const files = {};

  files['AGENTS.md'] = codexRoot(core, commands);

  // Build phase lookup
  const phaseLookup = {};
  for (const [fileName, content] of Object.entries(core.phases)) {
    const cmdName = toSkillName(fileName);
    phaseLookup[cmdName] = { fileName, content };
  }

  const consumedPhases = new Set();

  // Orchestration commands: merge with matching phase
  if (commands) {
    for (const [name, content] of Object.entries(commands)) {
      if (!PUBLIC_SKILLS.has(name)) continue;
      const { frontmatter, body } = splitFrontmatter(content);
      const stage = frontmatter.stage;
      const skillName = `gantry-${name}`;

      let phaseContent = null;
      if (stage && STAGE_PHASE_MAP[stage]) {
        const phaseCmd = toSkillName(STAGE_PHASE_MAP[stage] + '.md');
        if (phaseLookup[phaseCmd]) {
          phaseContent = phaseLookup[phaseCmd].content;
          consumedPhases.add(phaseCmd);
        }
      }

      if (phaseContent) {
        files[`.agents/skills/${skillName}/SKILL.md`] = mergedSkill(skillName, content, phaseContent);
      } else {
        files[`.agents/skills/${skillName}/SKILL.md`] = flowSkill(skillName, name, content);
      }
    }
  }

  return files;
}

function codexRoot(core, commands) {
  return `# AGENTS · gantry（Codex 注入）

本项目使用 gantry 阶段驱动协作框架。入口文件保持极简；详细规则和阶段协议按需读取，避免常驻上下文膨胀。

## 启动契约

- 不依赖聊天记忆；以仓库工件为准。
- 执行阶段型 gantry skill 时读取 \`.gantry/planning/context-pack.json\`，按 \`loadOrder\` 最小加载当前阶段所需文件；其中 \`agent-prompt\` 与 \`phase-prompt\` 都是执行约束。 \`gantry-change\` 首次执行若 pack 不存在，先运行 \`gantry change "<描述>"\` 创建 pack。
- \`docs/RULES.md\` / \`docs/METHODOLOGY.md\` 是规则源文件；仅在解释规则、修改 gantry 框架或 \`context-pack\` 明确要求时读取。
- 按 \`TASKS.md\` 的 \`read_files\` / \`write_files\` 计划加载与实现；full DEV 文件列表差异记录提示，不代替实际验收或自动提交归属判断，保留用户内容。
- 完成前必须运行并报告 verify 证据。
- 累计 / 输入 token > 200k 或上下文窗口使用率 > 85% 时，写 \`<task-id>-PROGRESS.md\` 后清窗。
- 禁止把长规则或长工件复制进聊天；用 \`@文件路径\` 引用。

## 核心 Skills

日常骨架：
- \`$gantry-change\`：启动新变更
- \`$gantry-next\`：执行当前阶段并推进
- \`$gantry-archive\`：完成并归档

自动驾驶：
- \`$gantry-auto\`：多步自主推进（保留人工确认关卡）

状态类：
- \`$gantry-status\`：查看当前状态
- \`$gantry-resume\`：断点恢复
- \`$gantry-adjust\`：中途变化 → 打开 PATCH.md 闭环

审查与排障：
- \`$gantry-review\`：审查入口（代码 / 需求 / 对抗）
- \`$gantry-debug\`：系统化调试

维护：
- \`$gantry-context\`：上下文与架构治理（scan / architect / evolve / knowledge）
- \`$gantry-health\`：代码库健康检查
- \`$gantry-unarchive\`：从归档恢复 change

已内部化（不再作为用户命令入口）：
- \`exec\`：\`$gantry-next\` 到 dev 阶段自动触发
- \`fast\`：light 管线由 \`gantry change --tier light --scope\` 直接进入，无人工关卡
- \`knowledge\`：capture / curate 并入 \`$gantry-context knowledge <sub>\`

公开 skills 位于 \`.agents/skills/\`；内部阶段协议由 \`gantry-next\` 按需读取。
`;
}

/**
 * Merge orchestration skill + phase reference + pack protocol.
 * Phase content lives at .gantry/core/phases/<fileName> — skill tells
 * agent to read it at execution time (thin transcoder mode).
 */
function mergedSkill(skillName, skillContent, phaseContent) {
  const { frontmatter, body } = splitFrontmatter(skillContent);
  const phaseTitle = extractTitle(phaseContent);
  const description = frontmatter.description || phaseTitle || `gantry skill ${skillName}`;

  return `---
name: ${skillName}
description: ${oneLine(description)}
---

## 编排协议

${body.trim()}

---

## Context Pack 协议

在编排协议的加载步骤读取一次 \`.gantry/planning/context-pack.json\`，校验 \`schemaVersion === 2\`；change 首次由 \`gantry change\` 创建，其余缺失时用 \`gantry context\` 生成。

- 按 \`loadOrder\` 消费 \`required\` 项，按 \`focus\` 读相关章节；同一上下文已读且未变化的内容复用，新上下文重新加载。agent constraints 与 phase 同时生效。
- \`checklists\`：\`trigger=true\` 必跑；\`false+confidence=high\` 跳过；\`false+confidence=low\` 据相关任务和设计复核，只能上调补跑，不得下调 true。
- 仅按编排协议执行 \`next.onSuccess\`；人工关卡先完成可审阅工件再等待明确批准，不自行推进。不增造 schema 字段。

`;
}

/**
 * Orchestration skill without a matching phase.
 */
function flowSkill(skillName, cmdName, content) {
  const { frontmatter, body } = splitFrontmatter(content);
  const description = frontmatter.description
    ?? extractTitle(body)
    ?? `gantry 编排命令 /gantry:${cmdName}。`;
  return `---
name: ${skillName}
description: ${oneLine(description)}
---

${body.trim()}
${cmdName === 'auto' ? codexAutoAdapter() : ''}
`;
}

function codexAutoAdapter() {
  return [
    '',
    '## Codex 子 Agent 适配',
    '',
    '- 每次成功预约只创建一个 fresh executor subagent：调用 `spawn_agent`，`agent_type="worker"`、`fork_turns="none"`；调用 `wait_agent` 同步等待该任务返回并完成外层验收后，才重新 dispatch 下一个 task。共享工作区不并行写。',
    '- message 必须包含 taskId、attemptId、repairOrdinal 和已冻结的单任务 pack 全文，以及“你不是唯一在工作区工作的 Agent，不得撤销他人修改”。不得继承 orchestrator 的长对话。',
    '- message 要求读取 `.gantry/core/agents/executor.md` 与 `.gantry/core/phases/4-dev.md`「单任务执行」；只按自己的 pack 产候选和实际 TDD/verify 报告，不读取后续被覆盖的共享 pack。',
    '- 子 Agent 是叶子执行者：禁止调用 `spawn_agent` 或 `followup_task` 创建、恢复或委派其他子 Agent；禁止 commit、gantry done/dispatch/advance/approve/archive，禁止改 TASKS/EXECUTION/STATE/execution 控制 JSON/锁/验收 contract。',
    '- 唯一例外：验收字段被误改时，只允许将当前任务的 verify/done/checks/preflight 精确恢复为传入的已保存 contract 原值；不修改 contract 控制记录、TASKS 完成状态或其他任务，不重新定义验收。',
    '- worker 返回后由 orchestrator 运行 `gantry done <id> --json`，真实验收通过才完成任务；pack 的 next.onSuccess 不由 worker 执行。',
    '- 可修复失败先经 dispatch 持久化扣额度，再创建新子 Agent；不得 resume/continue/followup 复用失败上下文，不得在主上下文接管清零。初次执行 + 最新 ralph.maxRepairs 次修复（默认3），耗尽后报告最后诊断；安全返回的未知失败先分析修复。消费 gateFeedback/retryHistory，阶段采用 autonomous.maxRetries，与宿主共用预算，不在 skill/phase/hook 另套计数。',
    '- 已有候选或 receipt 时先恢复验证，不无条件重新预约。all_done 后仅由 orchestrator 调用 advance，完成最终组合检查、安全统一提交和阶段推进。',
    '',
  ].join('\n');
}

// --- Utilities ---

function toSkillName(phaseFile) {
  return phaseFile
    .replace(/\.md$/, '')
    .replace(/^\d+[a-z]?-/, '')
    .replace(/^[A-Z]-/, '');
}

function extractTitle(md) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function splitFrontmatter(md) {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: md };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+?)\s*$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  return { frontmatter: fm, body: m[2] };
}

function stripFrontmatter(md) {
  const m = md.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/);
  return m ? m[1] : md;
}

function oneLine(s) {
  return s.replace(/\s+/g, ' ').replace(/"/g, '\\"').trim();
}
