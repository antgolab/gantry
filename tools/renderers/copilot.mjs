// Copilot renderer
// Produces: .github/copilot-instructions.md + .github/prompts/*.prompt.md
//
// Copilot prompts mirror the public skill surface. Internal phases are
// referenced through .gantry/core/phases/* and are not emitted as standalone
// user-facing prompts.

import { PUBLIC_SKILLS, STAGE_PHASE_MAP } from '../lib/stage-map.mjs';

export function render(core, commands, agents) {
  const files = {};

  const publicCommands = Object.entries(commands ?? {})
    .filter(([name]) => PUBLIC_SKILLS.has(name));

  files['.github/copilot-instructions.md'] = `# Copilot instructions · gantry

${core.rules.trim()}

---

## 可用 reusable prompts

位置：\`.github/prompts/*.prompt.md\`。只暴露公开 Gantry 入口；内部阶段协议由 prompt 按需读取 \`.gantry/core/phases/*\`。

| prompt | 用途 |
|---|---|
${publicCommands.map(([name, content]) => {
  const { frontmatter } = splitFrontmatter(content);
  return `| \`gantry-${name}\` | ${frontmatter.description ?? `gantry ${name}`} |`;
}).join('\n')}

阶段运行时先读 \`.gantry/planning/context-pack.json\` 并按 \`loadOrder\` 最小加载；其中 \`agent-prompt\` 与 \`phase-prompt\` 都是执行约束。\`gantry-change\` 首次执行若 pack 不存在，先运行 \`gantry change "<描述>"\` 创建 pack；完整方法论仅在需要解释规则时回查 \`docs/METHODOLOGY.md\`。
`;

  for (const [name, content] of publicCommands) {
    const { frontmatter, body } = splitFrontmatter(content);
    const title = frontmatter.description ?? (body.match(/^#\s+(.+)$/m) ?? [])[1] ?? name;
    files[`.github/prompts/gantry-${name}.prompt.md`] = `---
mode: agent
description: ${title.trim()}
source: gantry/skills/${name}.md
---

${withPhaseRef(body, frontmatter.stage)}
`;
  }

  return files;
}

function withPhaseRef(body, stage) {
  if (!stage || !STAGE_PHASE_MAP[stage]) return body.trim();
  return `${body.trim()}

## Context Pack 协议

在编排协议的加载步骤读取一次 \`.gantry/planning/context-pack.json\`，校验 \`schemaVersion === 2\`；change 首次由 \`gantry change\` 创建，其余缺失时用 \`gantry context\` 生成。

- 按 \`loadOrder\` 消费 \`required\` 项，按 \`focus\` 读相关章节；同一上下文已读且未变化的内容复用，新上下文重新加载。agent constraints 与 phase 同时生效。
- \`checklists\`：\`trigger=true\` 必跑；\`false+confidence=high\` 跳过；\`false+confidence=low\` 据相关任务和设计复核，只能上调补跑，不得下调 true。
- 仅按编排协议执行 \`next.onSuccess\`；人工关卡先完成可审阅工件再等待明确批准，不自行推进。不增造 schema 字段。
`;
}

function splitFrontmatter(content) {
  if (!content.startsWith('---\n')) return { frontmatter: {}, body: content };
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return { frontmatter: {}, body: content };
  const raw = content.slice(4, end).trim();
  const body = content.slice(end + 5);
  const frontmatter = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { frontmatter, body };
}
