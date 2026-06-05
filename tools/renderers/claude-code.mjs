// Claude Code renderer
// Produces: CLAUDE.md + .claude/commands/<name>.md (phases + orchestration commands)

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const systemPartial = readFileSync(join(__dirname, 'partials/patch-protocol.md'), 'utf8');

export function render(core, commands, agents) {
  const files = {};

  // Root CLAUDE.md = SYSTEM + RULES 摘要 + 命令清单 + 编排协议
  files['CLAUDE.md'] = claudeRoot(core, commands, agents);

  // Phase commands: 每个 phase → 一个 .md（跳过与 flow 命令同名的）
  const flowNames = commands ? new Set(Object.keys(commands)) : new Set();
  for (const [name, content] of Object.entries(core.phases)) {
    const cmdName = toCommandName(name);
    if (flowNames.has(cmdName)) continue; // flow 命令优先，跳过同名 phase 命令
    files[`.claude/commands/${cmdName}.md`] = claudeCommand(name, content);
  }

  // Orchestration commands: /gantry:* 命令
  if (commands) {
    for (const [name, content] of Object.entries(commands)) {
      files[`.claude/commands/gantry-${name}.md`] = content;
    }
  }

  return files;
}

function claudeRoot(core, commands, agents) {
  const orchCmds = commands ? Object.keys(commands).map(name =>
    `| \`/gantry:${name}\` | 编排命令 | \`commands/${name}.md\` |`
  ).join('\n') : '';

  const agentList = agents ? Object.keys(agents).map(name =>
    `- **${name}**`
  ).join('\n') : '';

  return `# gantry · Claude Code 注入

本项目使用 gantry 阶段驱动工程协作框架。以下规则每会话常驻生效。

---

${systemPartial.trim()}

---

## 编排协议

本项目使用状态驱动的 agent 协作模式：
- 状态文件: \`.planning/STATE.md\`
- 配置: \`.planning/config.json\`
- CLI: \`node <gantry>/src/cli.mjs <command>\`

### Agent 角色

${agentList}

### 状态机

\`\`\`
idle → change → requirement → design → [ui-design] → task → dev → test → review → integration → idle
\`\`\`

每个阶段有门禁（前置工件必须存在）和 checkpoint（人工确认点）。

---

## 可用斜杠命令

### 编排命令 (/gantry:*)

| 命令 | 用途 | 来源 |
|---|---|---|
${orchCmds}

### 阶段命令（直接执行）

| 命令 | 用途 | 来源 |
|---|---|---|
${listCommands(core.phases)}

调用方式：\`/gantry:change\`、\`/change\`、\`/design\` 等。
`;
}

function listCommands(phases) {
  return Object.keys(phases)
    .map((name) => {
      const cmd = toCommandName(name);
      const purpose = extractTitle(phases[name]) ?? name;
      return `| \`/${cmd}\` | ${purpose} | \`phases/${name}\` |`;
    })
    .join('\n');
}

function claudeCommand(name, content) {
  const title = extractTitle(content) ?? name;
  return `---
description: ${title}
source: phases/${name}
---

${content.trim()}
`;
}

function toCommandName(phaseFile) {
  // 0-change.md → change
  // 2a-ui-design.md → ui-design
  // A-architect.md → architect
  // K-knowledge.md → knowledge
  return phaseFile
    .replace(/\.md$/, '')
    .replace(/^\d+[a-z]?-/, '')
    .replace(/^[A-Z]-/, '');
}

function extractTitle(md) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}
