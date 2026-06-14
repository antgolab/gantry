// Cursor renderer
// Produces: .cursor/rules/*.mdc

export function render(core, commands, agents) {
  const files = {};

  files['.cursor/rules/00-system.mdc'] = mdc(
    { alwaysApply: true, description: 'gantry 硬规则 R1~R8 + 流程概览' },
    core.rules,
  );

  let idx = 1;
  for (const [name, content] of Object.entries(core.phases)) {
    const title = extractTitle(content) ?? name;
    const slug = toSlug(name);
    const prefix = String(idx).padStart(2, '0');
    files[`.cursor/rules/${prefix}-${slug}.mdc`] = mdc(
      { description: `[phase] ${title}`, globs: ['**/*'] },
      content,
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

function toSlug(name) {
  return name.replace(/\.md$/, '').toLowerCase();
}
