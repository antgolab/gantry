// Codex renderer
// Produces:
//   AGENTS.md                                 — system + rules + 编排协议 + skill 索引
//   .agents/skills/<phase>/SKILL.md           — 每个 phase prompt 一个 skill
//   .agents/skills/gantry-<name>/SKILL.md       — 每个 /gantry:* 编排命令一个 skill
//
// Codex CLI 以 .agents/skills/<name>/SKILL.md 形式发现 project-scoped skills。
// SKILL.md 必须含 YAML frontmatter (name + description)，可通过 $name 显式调用，
// 也会按 description 隐式匹配。
// 文档：https://developers.openai.com/codex/skills

export function render(core, commands, agents) {
  const files = {};

  files['AGENTS.md'] = codexRoot(core, commands, agents);

  const flowNames = commands ? new Set(Object.keys(commands)) : new Set();
  for (const [name, content] of Object.entries(core.phases)) {
    const skillName = toSkillName(name);
    if (flowNames.has(skillName)) continue; // /gantry:* 同名优先
    files[`.agents/skills/${skillName}/SKILL.md`] = phaseSkill(skillName, name, content);
  }

  if (commands) {
    for (const [name, content] of Object.entries(commands)) {
      const skillName = `gantry-${name}`;
      files[`.agents/skills/${skillName}/SKILL.md`] = flowSkill(skillName, name, content);
    }
  }

  return files;
}

function codexRoot(core, commands, agents) {
  const phaseRows = Object.keys(core.phases)
    .map((name) => {
      const skill = toSkillName(name);
      const purpose = extractTitle(core.phases[name]) ?? name;
      return `| \`$${skill}\` | ${purpose} | \`.agents/skills/${skill}/SKILL.md\` |`;
    })
    .join('\n');

  const orchRows = commands
    ? Object.keys(commands).map((name) => {
        const skill = `gantry-${name}`;
        const purpose = extractDescription(commands[name]) ?? '编排命令';
        return `| \`$${skill}\` | ${purpose} | \`.agents/skills/${skill}/SKILL.md\` |`;
      }).join('\n')
    : '';

  const agentList = agents
    ? Object.keys(agents).map(name => `- **${name}**`).join('\n')
    : '';

  return `# AGENTS · gantry（Codex 注入）

本项目使用 gantry 阶段驱动协作框架。下面是 Codex 必须遵守的规则、方法论与编排协议。
具体阶段 / 编排命令的 prompt 以 **Codex Skills** 形式分发在 \`.agents/skills/\` 下。

---

${core.methodology.trim()}

---

${core.rules.trim()}

---

## 编排协议

本项目使用状态驱动的 agent 协作模式：
- 状态文件: \`.planning/STATE.md\`
- 配置: \`.planning/config.json\`
- CLI: \`node <gantry>/src/cli.mjs <command>\`

### 状态机

\`\`\`
idle → change → requirement → design → [ui-design] → task → dev → test → review → integration → idle
\`\`\`

每个阶段有门禁（前置工件必须存在）和 checkpoint（人工确认点）。

### Agent 角色

${agentList}

### Checkpoint 类型

- \`human-verify\`: 阶段完成需人工确认，暂停等待
- \`decision\`: 检测到歧义，展示选项等待决策
- \`auto\`: 自动推进，无需等待

---

## Skills 索引

调用方式：在 Codex 会话内输入 \`$<skill-name>\`（如 \`$change\`、\`$gantry-next\`），
也可输入 \`/skills\` 浏览选择；Codex 也会按 description 隐式匹配触发。

### 编排 Skills（gantry-*）

| 调用 | 用途 | 来源 |
|---|---|---|
${orchRows}

### 阶段 Skills

| 调用 | 用途 | 来源 |
|---|---|---|
${phaseRows}

---

## 完整规则（R1~R8 + 违规处理）

${extractBody(core.rules)}

---

## 方法论骨架

${extractBody(core.methodology)}

---

## 模板与参考

- 模板：\`templates/\`
- 参考：\`reference/\`（按节读，不整读）
`;
}

function phaseSkill(skillName, fileName, content) {
  const { body } = splitFrontmatter(content);
  const title = extractTitle(body) ?? fileName;
  const description = `gantry 阶段命令：${title}。来源 phases/${fileName}。当用户进入对应阶段或显式调用 $${skillName} 时使用。`;
  return skillFile(skillName, description, body);
}

function flowSkill(skillName, cmdName, content) {
  const { frontmatter, body } = splitFrontmatter(content);
  const description = frontmatter.description
    ?? extractTitle(body)
    ?? `gantry 编排命令 /gantry:${cmdName}。`;
  return skillFile(skillName, description, body);
}

function skillFile(name, description, body) {
  const sanitized = oneLine(description);
  return `---
name: ${name}
description: ${sanitized}
---

${body.trim()}
`;
}

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

function extractDescription(md) {
  const { frontmatter, body } = splitFrontmatter(md);
  if (frontmatter.description) return frontmatter.description;
  return extractTitle(body);
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

function extractBody(md) {
  return md.replace(/^#\s+.+$/m, '').trim();
}

function oneLine(s) {
  return s.replace(/\s+/g, ' ').replace(/"/g, '\\"').trim();
}
