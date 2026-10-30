// Claude Code renderer
// Produces: CLAUDE.md + .claude/skills/gantry-<name>/SKILL.md
//
// Uses the official Claude Code Skills format (.claude/skills/<name>/SKILL.md).
// Each skill is a folder — can hold supporting files (templates, scripts, etc).
//
// Strategy:
// - Public orchestration commands (skills/) that have a matching phase reference
//   that phase at install time.
// - Internal phases are not emitted as standalone user-facing skills.
// - All public entry points unified under /gantry-* (user invokes /gantry-change, etc).
// - Source files (phases/*.md, skills/*.md) remain unchanged.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_SKILLS, STAGE_PHASE_MAP } from '../lib/stage-map.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const systemPartial = readFileSync(join(__dirname, 'partials/patch-protocol.md'), 'utf8');

export function render(core, commands, agents) {
  const files = {};

  files['CLAUDE.md'] = claudeRoot(core, commands, agents);

  // Build phase lookup: cmdName → { fileName, content }
  const phaseLookup = {};
  for (const [fileName, content] of Object.entries(core.phases)) {
    const cmdName = toCommandName(fileName);
    phaseLookup[cmdName] = { fileName, content };
  }

  const consumedPhases = new Set();

  // Merge intent: install loop recognizes the __merge__/ prefix and merges
  // (rather than overwrites) the target file. Renderer stays IO-free — it only
  // declares what to merge.
  //
  // - addToAllow:    gantry 当前意图，install 合并进 settings。
  // - legacyAliases: gantry 历史 install 曾写过的条目，现在已被更宽的 addToAllow
  //                  覆盖。install **不**把它们写回 settings（避免复活历史产物），
  //                  但要登记到侧文件，让 uninstall 认领并清掉老项目里的残留。
  files['__merge__/.claude/settings.json'] = {
    addToAllow: ['Bash(gantry *)'],
    legacyAliases: ['Bash(gantry status *)'],
  };

  // Orchestration commands: reference matching phase file
  if (commands) {
    for (const [name, content] of Object.entries(commands)) {
      if (!PUBLIC_SKILLS.has(name)) continue;
      const { frontmatter } = splitFrontmatter(content);
      const stage = frontmatter.stage;

      let phaseFileName = null;
      if (stage && STAGE_PHASE_MAP[stage]) {
        const phaseCmd = toCommandName(STAGE_PHASE_MAP[stage] + '.md');
        if (phaseLookup[phaseCmd]) {
          phaseFileName = phaseLookup[phaseCmd].fileName;
          consumedPhases.add(phaseCmd);
        }
      }

      const skillName = `gantry-${name}`;
      if (phaseFileName) {
        files[`.claude/skills/${skillName}/SKILL.md`] = skillWithPhaseRef(skillName, content);
      } else {
        files[`.claude/skills/${skillName}/SKILL.md`] = flowSkill(skillName, name, content);
      }
    }
  }

  return files;
}

// --- CLAUDE.md ---

function claudeRoot(core, commands, agents) {
  const agentList = agents ? Object.keys(agents).map(name =>
    `- **${name}**`
  ).join('\n') : '';

  return `# gantry · Claude Code 注入

本项目使用 gantry 阶段驱动工程协作框架。以下规则每会话常驻生效。

---

${systemPartial.trim()}

---

## 编排协议

- 状态文件: \`.gantry/planning/STATE.md\`
- 配置: \`.gantry/planning/config.json\`

### Agent 角色

${agentList}

### 状态机

\`\`\`
full:  idle → change → requirement → design → [ui-design] → task → dev → test → review → integration → idle
light: idle → fast → idle（--tier light 直入；gantry advance 出口门：全过自动归档，命中自动升 full@change）
\`\`\`

---

## 可用 Skills

公开 gantry skills 位于 \`.claude/skills/gantry-*/\`。内部阶段协议由 \`/gantry-next\` 按需读取,\`exec\` / \`fast\` / \`knowledge\` 已内部化(见下)。

日常骨架：\`/gantry-change\`、\`/gantry-next\`、\`/gantry-archive\`。
自动驾驶：\`/gantry-auto\`(多步推进 · 保留人工确认关卡)。
状态类：\`/gantry-status\`、\`/gantry-resume\`、\`/gantry-adjust\`。
审查与排障：\`/gantry-review\`、\`/gantry-debug\`。
维护：\`/gantry-context\`(scan / architect / evolve / knowledge)、\`/gantry-health\`、\`/gantry-unarchive\`。

内部化(不再作为用户命令入口)：
- \`exec\`:\`/gantry-next\` 到 dev 阶段自动触发
- \`fast\`:light 管线由 \`gantry change --tier light --scope\` 直接进入,无人工关卡
- \`knowledge\`:capture / curate 并入 \`/gantry-context knowledge <sub>\`
`;
}

// --- Skill file builders ---

/**
 * Orchestration skill that references an external phase file.
 * The phase content lives in .gantry/core/phases/<fileName> — skill tells
 * the agent to read it at execution time. The skill also reminds the agent
 * to consume `.gantry/planning/context-pack.json` (the kernel ↔ client contract).
 */
function skillWithPhaseRef(skillName, skillContent) {
  const { frontmatter, body } = splitFrontmatter(skillContent);
  const description = frontmatter.description || `gantry skill ${skillName}`;

  const fmLines = [
    `description: ${oneLine(description)}`,
    `disable-model-invocation: true`,
  ];

  return `---
${fmLines.join('\n')}
---

${body.trim()}

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
    ?? `gantry 编排命令 ${skillName}`;

  const fmLines = [
    `description: ${oneLine(description)}`,
    `disable-model-invocation: true`,
  ];

  return `---
${fmLines.join('\n')}
---

${body.trim()}
${cmdName === 'auto' ? claudeAutoAdapter() : ''}
`;
}

function claudeAutoAdapter() {
  return [
    '',
    '## Claude Code 子 Agent 适配',
    '',
    '- 每次成功预约只创建一个 fresh executor subagent：调用 `Agent` 工具，设置 `subagent_type: "general-purpose"`、`run_in_background: false`；同步等待该任务返回并完成外层验收后，才重新 dispatch 下一个 task。共享工作区不并行写。',
    '- prompt 必须包含 taskId、attemptId、repairOrdinal 和已冻结的单任务 pack 全文，以及“你不是唯一在工作区工作的 Agent，不得撤销他人修改”。不得继承 orchestrator 的长对话。',
    '- prompt 要求读取 `.gantry/core/agents/executor.md` 与 `.gantry/core/phases/4-dev.md`「单任务执行」；只按自己的 pack 产候选和实际 TDD/verify 报告，不读取后续被覆盖的共享 pack。',
    '- 子 Agent 是叶子执行者：禁止调用 `Agent` 工具或通过 resume 创建、恢复或委派其他子 Agent；禁止 commit、gantry done/dispatch/advance/approve/archive，禁止改 TASKS/EXECUTION/STATE/execution 控制 JSON/锁/验收 contract。',
    '- 唯一例外：验收字段被误改时，只允许将当前任务的 verify/done/checks/preflight 精确恢复为传入的已保存 contract 原值；不修改 contract 控制记录、TASKS 完成状态或其他任务，不重新定义验收。',
    '- worker 返回后由 orchestrator 运行 `gantry done <id> --json`，真实验收通过才完成任务；pack 的 next.onSuccess 不由 worker 执行。',
    '- 可修复失败先经 dispatch 持久化扣额度，再创建新子 Agent；不得 resume/continue/followup 复用失败上下文，不得在主上下文接管清零。初次执行 + 最新 ralph.maxRepairs 次修复（默认3），耗尽后报告最后诊断；安全返回的未知失败先分析修复。消费 gateFeedback/retryHistory，阶段采用 autonomous.maxRetries，与宿主共用预算，不在 skill/phase/hook 另套计数。',
    '- 已有候选或 receipt 时先恢复验证，不无条件重新预约。all_done 后仅由 orchestrator 调用 advance，完成最终组合检查、安全统一提交和阶段推进。',
    '',
  ].join('\n');
}

// --- Utilities ---

function toCommandName(phaseFile) {
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

function oneLine(s) {
  return s.replace(/\s+/g, ' ').replace(/"/g, '\\"').trim();
}
