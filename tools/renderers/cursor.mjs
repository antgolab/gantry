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
  const phase = stage && STAGE_PHASE_MAP[stage] ? `${STAGE_PHASE_MAP[stage]}.md` : null;
  const packBlock = `\n\n## Context Pack 协议\n\n执行阶段型规则时先读取 \`.gantry/planning/context-pack.json\` (schema v2)。若 pack 不存在:\n- \`gantry-change\`:先按编排协议运行 \`gantry change "<描述>"\`,由 CLI 创建 pack,再读取 pack 继续。\n- 其他阶段型规则:停手并提示运行 \`gantry context\` 刷新,或先用 \`gantry status\` 查看状态。\n\n读取到 pack 后:\n- 校验 \`schemaVersion === 2\`,否则停手。\n- 顺序消费 \`loadOrder\` (agent-prompt / phase-prompt / artifacts / context-doc / LESSONS)；\`agent-prompt.required === true\` 时必须读取，其 constraints 与 phase prompt 同时生效。\n- 子检查非对称信任:\`trigger===true\` 必跑;\`false+confidence==="high"\` 跳过;\`false+confidence==="low"\` 关键词可能漏判,据完整上下文复核后决定是否补跑。只能上调 low 的 false,不得下调 true。\n- 仅当当前 skill 的编排协议要求推进时，才执行 \`next.onSuccess\`；明确要求停在人工确认关卡时禁止执行，等待后续 \`/gantry-next\`。\n- 不允许在 v2 schema 上自行发明字段。`;
  const ref = phase
    ? `${packBlock}\n\n## 阶段执行指令\n\n读取并严格执行 \`.gantry/core/phases/${phase}\` 中的完整阶段协议。`
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
