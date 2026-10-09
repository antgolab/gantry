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
        files[`.claude/skills/${skillName}/SKILL.md`] = skillWithPhaseRef(skillName, content, phaseFileName);
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
light: idle → change → fast → integration → idle
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
- \`fast\`:light 挡位由 \`/gantry-change\` / \`/gantry-auto\` 内部判定
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
function skillWithPhaseRef(skillName, skillContent, phaseFileName) {
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

每次执行阶段型 skill 时先 \`Read .gantry/planning/context-pack.json\`,严格按 schema v2 行事。
若 pack 不存在:
- \`gantry-change\`:先按上方编排协议运行 \`gantry change "<描述>"\`,由 CLI 创建 pack,再读取 pack 继续。
- 其他阶段型 skill:停手并提示运行 \`gantry context\` 刷新,或先用 \`gantry status\` 查看状态。

读取到 pack 后:
- 校验 \`schemaVersion === 2\`,否则停手并告知用户。
- 顺序消费 \`loadOrder\`(agent-prompt / phase-prompt / artifacts / context-doc / LESSONS)；\`agent-prompt.required === true\` 时必须读取，其 constraints 与 phase prompt 同时生效。
- 子检查按**非对称信任**执行 \`checklists[]\`:
  - \`trigger === true\`:必跑,机器判定可信,不得跳过。
  - \`trigger === false && confidence === "high"\`:确定不用跑(基于文件存在性等事实),跳过。
  - \`trigger === false && confidence === "low"\`:关键词判定可能漏判,**你必须据完整上下文(DESIGN/task 全文)复核**——确实涉及就补跑并说明;不涉及才跳过。
  - 你**只能把 low 的 false 上调为"跑"**,**不得把任何 true 下调为"跳过"**。
- 仅当当前 skill 的编排协议要求推进时，才执行 \`next.onSuccess\` (失败走 \`next.onFailure\`)；明确要求停在人工确认关卡时禁止执行，等待后续 \`/gantry-auto\` 或 \`/gantry-next\`。
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
    ?? `gantry 编排命令 ${skillName}`;

  const fmLines = [
    `description: ${oneLine(description)}`,
    `disable-model-invocation: true`,
  ];

  return `---
${fmLines.join('\n')}
---

${body.trim()}
`;
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
