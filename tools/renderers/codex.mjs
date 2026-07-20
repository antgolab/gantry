// Codex renderer
// Produces:
//   AGENTS.md                                    — compact entry contract
//   .agents/skills/gantry-<name>/SKILL.md        — merged skill (orchestration + phase)
//
// Strategy: public orchestration commands that have a matching phase get the
// phase content appended at install time. Internal phases are not emitted as
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
      let phaseFileName = null;
      if (stage && STAGE_PHASE_MAP[stage]) {
        const phaseCmd = toSkillName(STAGE_PHASE_MAP[stage] + '.md');
        if (phaseLookup[phaseCmd]) {
          phaseContent = phaseLookup[phaseCmd].content;
          phaseFileName = phaseLookup[phaseCmd].fileName;
          consumedPhases.add(phaseCmd);
        }
      }

      if (phaseContent) {
        files[`.agents/skills/${skillName}/SKILL.md`] = mergedSkill(skillName, content, phaseContent, phaseFileName);
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
- 严格遵守 \`TASKS.md\`（兼容期接受 \`TASK.md\`）的 \`read_files\` / \`write_files\` 边界。
- 完成前必须运行并报告 verify 证据。
- 累计 / 输入 token > 200k 或上下文窗口使用率 > 85% 时，写 \`<task-id>-PROGRESS.md\` 后清窗。
- 禁止把长规则或长工件复制进聊天；用 \`@文件路径\` 引用。

## 核心 Skills

- \`$gantry-status\`：查看当前状态
- \`$gantry-change\`：启动新变更
- \`$gantry-next\`：执行当前阶段并推进
- \`$gantry-exec\`：执行当前任务 / wave
- \`$gantry-resume\`：断点恢复
- \`$gantry-archive\`：完成并归档
- \`$gantry-auto\`：自主推进（保留人工确认关卡）
- \`$gantry-review\`：审查入口（代码 / 需求 / 对抗）
- \`$gantry-health\`：代码库健康检查
- \`$gantry-context\`：上下文与架构治理
- \`$gantry-knowledge\`：知识捕获与维护
- \`$gantry-debug\`：系统化调试
- \`$gantry-fast\`：快速路径

公开 skills 位于 \`.agents/skills/\`；内部阶段协议由 \`gantry-next\` / \`gantry-exec\` / \`gantry-review\` 按需读取。
`;
}

/**
 * Merge orchestration skill + phase reference + pack protocol.
 * Phase content lives at .gantry/core/phases/<fileName> — skill tells
 * agent to read it at execution time (thin transcoder mode).
 */
function mergedSkill(skillName, skillContent, phaseContent, phaseFileName) {
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

每次执行阶段型 skill 时先读取 \`.gantry/planning/context-pack.json\`,严格按 schema v2 行事。
若 pack 不存在:
- \`gantry-change\`:先按上方编排协议运行 \`gantry change "<描述>"\`,由 CLI 创建 pack,再读取 pack 继续。
- 其他阶段型 skill:停手并提示运行 \`gantry context\` 刷新,或先用 \`gantry status\` 查看状态。

读取到 pack 后:
- 校验 \`schemaVersion === 2\`,否则停手。
- 顺序消费 \`loadOrder\` (agent-prompt / phase-prompt / artifacts / context-doc / LESSONS)；\`agent-prompt.required === true\` 时必须读取，其 constraints 与 phase prompt 同时生效。
- 子检查按**非对称信任**执行 \`checklists[]\`:
  - \`trigger === true\`:必跑,不得跳过。
  - \`trigger === false && confidence === "high"\`:确定不用跑,跳过。
  - \`trigger === false && confidence === "low"\`:关键词判定可能漏,**据完整上下文复核**,涉及就补跑。
  - 只能把 low 的 false 上调为"跑",不得把 true 下调为"跳过"。
- 仅当当前 skill 的编排协议要求推进时，才执行 \`next.onSuccess\` (失败走 \`next.onFailure\`)；明确要求停在人工确认关卡时禁止执行，等待后续 \`/gantry-next\`。
- 不允许在 v2 schema 上自行发明字段。

## 阶段执行指令

读取并严格执行 \`.gantry/core/phases/${phaseFileName}\` 中的完整阶段协议。
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
`;
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
