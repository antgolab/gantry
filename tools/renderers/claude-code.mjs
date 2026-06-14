// Claude Code renderer
// Produces: CLAUDE.md + .claude/skills/gantry-<name>/SKILL.md
//
// Uses the official Claude Code Skills format (.claude/skills/<name>/SKILL.md).
// Each skill is a folder — can hold supporting files (templates, scripts, etc).
//
// Strategy:
// - Orchestration commands (skills/) that have a matching phase get the phase
//   content appended at install time → single merged SKILL.md.
// - Phases without a matching skill are emitted as standalone gantry-<name> skills.
// - All entry points unified under /gantry-* (user invokes /gantry-change, etc).
// - Source files (phases/*.md, skills/*.md) remain unchanged.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const systemPartial = readFileSync(join(__dirname, 'partials/patch-protocol.md'), 'utf8');

// Map skill stage field → phase filename (without .md)
const STAGE_PHASE_MAP = {
  change: '0-change',
  requirement: '1-requirement',
  design: '2-design',
  'ui-design': '2a-ui-design',
  task: '3-task',
  dev: '4-dev',
  test: '5-test',
  review: '6-review',
  integration: '7-integration',
  architect: 'A-architect',
  evolve: 'A-evolve',
  curator: 'C-curator',
  fast: 'F-fast',
  scan: 'I-intel-scan',
  knowledge: 'K-knowledge',
  restyle: 'L-restyle',
  health: 'M-health',
};

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

  // Orchestration commands: reference matching phase file
  if (commands) {
    for (const [name, content] of Object.entries(commands)) {
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

  // Remaining phases → standalone skill that references the phase file
  for (const [cmdName, { fileName }] of Object.entries(phaseLookup)) {
    if (consumedPhases.has(cmdName)) continue;
    if (commands && commands[cmdName]) continue;
    const skillName = `gantry-${cmdName}`;
    files[`.claude/skills/${skillName}/SKILL.md`] = phaseRefSkill(skillName, fileName, core.phases[fileName]);
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
idle → change → requirement → design → [ui-design] → task → dev → test → review → integration → idle
\`\`\`

---

## 可用 Skills

所有 gantry skills 位于 \`.claude/skills/gantry-*/\`。Claude 会根据 description 自动匹配，也可用 \`/gantry-<name>\` 显式调用。

核心命令：\`/gantry-change\`、\`/gantry-next\`、\`/gantry-exec\`、\`/gantry-verify\`、\`/gantry-archive\`。
`;
}

// --- Skill file builders ---

/**
 * Orchestration skill that references an external phase file.
 * The phase content lives in .gantry/core/phases/<fileName> — skill tells
 * the agent to read it at execution time.
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

/**
 * Phase without a matching skill → standalone skill that references the phase file.
 */
function phaseRefSkill(skillName, fileName, content) {
  const title = extractTitle(content) ?? fileName;
  const description = `gantry 阶段：${title}`;

  return `---
description: ${oneLine(description)}
disable-model-invocation: true
---

读取并严格执行 \`.gantry/core/phases/${fileName}\` 中的完整阶段协议。
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
