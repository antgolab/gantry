// Cursor renderer
// Produces: .cursor/rules/*.mdc
//
// Cursor rules are generated from the same public skill surface as Claude/Codex.
// Internal phases are referenced through .gantry/core/phases/* instead of being
// emitted as standalone user-facing rules.

import { PUBLIC_SKILLS, STAGE_PHASE_MAP } from '../lib/stage-map.mjs';

export function render(core, commands, agents) {
  const files = {};

  files['.cursor/rules/00-system.mdc'] = mdc(
    { alwaysApply: true, description: 'gantry 硬规则 R1~R8 + 流程概览' },
    core.rules,
  );

  let idx = 1;
  for (const [name, content] of Object.entries(commands ?? {})) {
    if (!PUBLIC_SKILLS.has(name)) continue;
    const { frontmatter, body } = splitFrontmatter(content);
    const title = frontmatter.description ?? extractTitle(body) ?? `gantry ${name}`;
    const prefix = String(idx).padStart(2, '0');
    files[`.cursor/rules/${prefix}-gantry-${name}.mdc`] = mdc(
      { description: `[gantry] ${title}`, globs: ['**/*'] },
      withPhaseRef(body, frontmatter.stage),
    );
    idx++;
  }

  return files;
}

function mdc(frontmatter, body) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  return `---\n${fm}\n---\n\n${body.trim()}\n`;
}

function extractTitle(md) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
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
