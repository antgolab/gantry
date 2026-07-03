// Copilot renderer
// Produces: .github/copilot-instructions.md + .github/prompts/*.prompt.md
//
// Copilot prompts mirror the public skill surface. Internal phases are
// referenced through .gantry/core/phases/* and are not emitted as standalone
// user-facing prompts.

const PUBLIC_SKILLS = new Set([
  'init',
  'status',
  'change',
  'next',
  'exec',
  'verify',
  'adjust',
  'resume',
  'archive',
  'unarchive',
  'auto',
  'review',
  'health',
  'context',
  'knowledge',
  'debug',
  'fast',
]);

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

运行时先读 \`.gantry/planning/context-pack.json\` 并按 \`loadOrder\` 最小加载；完整方法论仅在需要解释规则时回查 \`docs/METHODOLOGY.md\`。
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
    ? `\n\n## 阶段执行指令\n\n读取并严格执行 \`.gantry/core/phases/${phase}\` 中的完整阶段协议。`
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
