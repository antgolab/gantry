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
  const phase = stage && STAGE_PHASE_MAP[stage] ? `${STAGE_PHASE_MAP[stage]}.md` : null;
  const ref = phase
    ? `\n\n## Context Pack 协议\n\n执行阶段型 prompt 时先读取 \`.gantry/planning/context-pack.json\` (schema v2)。若 pack 不存在:\n- \`gantry-change\`:先按编排协议运行 \`gantry change "<描述>"\`,由 CLI 创建 pack,再读取 pack 继续。\n- 其他阶段型 prompt:停手并提示运行 \`gantry context\` 刷新,或先用 \`gantry status\` 查看状态。\n\n读取到 pack 后，校验 \`schemaVersion === 2\`，按 \`loadOrder\` 最小加载；\`agent-prompt.required === true\` 时必须读取，其 constraints 与 phase prompt 同时生效。按 \`checklists[]\` 执行子检查。仅当当前 skill 的编排协议要求推进时，才执行 \`next.onSuccess\`；明确要求停在人工确认关卡时禁止执行，等待后续 \`/gantry-next\`。\n\n## 阶段执行指令\n\n读取并严格执行 \`.gantry/core/phases/${phase}\` 中的完整阶段协议。`
    : '';
  return `${body.trim()}${ref}`;
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
