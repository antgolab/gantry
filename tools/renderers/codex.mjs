// Codex renderer
// Produces:
//   AGENTS.md                                    — compact entry contract
//   .agents/skills/gantry-<name>/SKILL.md        — merged skill (orchestration + phase)
//
// Strategy: orchestration commands that have a matching phase get the phase
// content appended at install time. Phases without a skill become standalone.
// All entry points are unified under gantry-* skills.
// Source files (phases/*.md, skills/*.md) remain unchanged.

// Map skill stage → phase filename (without .md)
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

  // Remaining phases → standalone gantry-<name> skill
  for (const [cmdName, { fileName, content }] of Object.entries(phaseLookup)) {
    if (consumedPhases.has(cmdName)) continue;
    if (commands && commands[cmdName]) continue;
    const skillName = `gantry-${cmdName}`;
    files[`.agents/skills/${skillName}/SKILL.md`] = phaseOnlySkill(skillName, fileName, content);
  }

  return files;
}

function codexRoot(core, commands) {
  return `# AGENTS · gantry（Codex 注入）

本项目使用 gantry 阶段驱动协作框架。入口文件保持极简；详细规则和阶段协议按需读取，避免常驻上下文膨胀。

## 启动契约

- 不依赖聊天记忆；以仓库工件为准。
- 改文件前读取：\`docs/RULES.md\`、\`docs/METHODOLOGY.md\`、\`.gantry/planning/STATE.md\`、当前阶段 prompt、DEV 阶段的活动 \`TASK.md\`。
- 严格遵守 \`TASK.md\` 的 \`read_files\` / \`write_files\` 边界。
- 完成前必须运行并报告 verify 证据。
- 累计 / 输入 token > 200k 或上下文窗口使用率 > 85% 时，写 \`<task-id>-PROGRESS.md\` 后清窗。
- 禁止把长规则或长工件复制进聊天；用 \`@文件路径\` 引用。

## 核心 Skills

- \`$gantry-status\`：查看当前状态
- \`$gantry-change\`：启动新变更
- \`$gantry-next\`：推进下一阶段
- \`$gantry-exec\`：执行当前任务 / wave
- \`$gantry-verify\`：运行任务验证
- \`$gantry-resume\`：断点恢复
- \`$gantry-archive\`：完成并归档

完整 skills 位于 \`.agents/skills/\`；优先使用 Codex 原生 \`/skills\` 发现，而不是把完整索引常驻上下文。
`;
}

/**
 * Merge orchestration skill + phase into one SKILL.md
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

## 阶段执行指令

${stripFrontmatter(phaseContent).trim()}
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

/**
 * Phase without a matching skill → standalone skill.
 */
function phaseOnlySkill(skillName, fileName, content) {
  const body = stripFrontmatter(content);
  const title = extractTitle(body) ?? fileName;
  const description = `gantry 阶段：${title}`;
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
