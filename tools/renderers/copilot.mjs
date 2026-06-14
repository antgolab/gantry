// Copilot renderer
// Produces: .github/copilot-instructions.md + .github/prompts/*.prompt.md

export function render(core, commands, agents) {
  const files = {};

  files['.github/copilot-instructions.md'] = `# Copilot instructions · gantry

${core.rules.trim()}

---

## 可用 reusable prompts

位置：\`.github/prompts/*.prompt.md\`。按阶段命名，可在 Copilot Chat 中以 \`/\` 调用。

| prompt | 对应阶段 |
|---|---|
${Object.keys(core.phases).map((n) => `| \`${toPromptSlug(n)}\` | \`phases/${n}\` |`).join('\n')}

查完整方法论：\`docs/METHODOLOGY.md\`。
`;

  for (const [name, content] of Object.entries(core.phases)) {
    const slug = toPromptSlug(name);
    const title = (content.match(/^#\s+(.+)$/m) ?? [])[1] ?? name;
    files[`.github/prompts/${slug}.prompt.md`] = `---
mode: agent
description: ${title.trim()}
source: gantry/phases/${name}
---

${content.trim()}
`;
  }

  return files;
}

function toPromptSlug(phaseFile) {
  return phaseFile.replace(/\.md$/, '').toLowerCase();
}
