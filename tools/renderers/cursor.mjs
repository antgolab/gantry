// Cursor renderer
// Produces: .cursor/rules/*.mdc
//
// Cursor rules are generated from the same public skill surface as Claude/Codex.
// Internal phases are referenced through .gantry/core/phases/* instead of being
// emitted as standalone user-facing rules.

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
  const packBlock = `\n\n## Context Pack 协议\n\n执行前先读取 \`.gantry/planning/context-pack.json\` (schema v2):\n- 校验 \`schemaVersion === 2\`,否则停手。\n- 顺序消费 \`loadOrder\`。\n- 子检查非对称信任:\`trigger===true\` 必跑;\`false+confidence==="high"\` 跳过;\`false+confidence==="low"\` 关键词可能漏判,据完整上下文复核后决定是否补跑。只能上调 low 的 false,不得下调 true。\n- 完成后执行 \`next.onSuccess\`。\n- 不允许在 v2 schema 上自行发明字段。`;
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
