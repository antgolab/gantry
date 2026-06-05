import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadCore(rootDir) {
  const read = (p) => readFileSync(join(rootDir, p), 'utf8');
  const dirFiles = (sub) => {
    const entries = {};
    const abs = join(rootDir, sub);
    if (!existsSync(abs)) return entries;
    for (const name of readdirSync(abs)) {
      const full = join(abs, name);
      if (statSync(full).isFile() && name.endsWith('.md')) {
        entries[name] = readFileSync(full, 'utf8');
      }
    }
    return entries;
  };
  return {
    rules: read('docs/RULES.md'),
    methodology: read('docs/METHODOLOGY.md'),
    go: read('docs/GO.md'),
    phases: dirFiles('phases'),
    templates: dirFiles('templates'),
    reference: dirFiles('reference'),
    ruleFiles: dirFiles('rules'),
  };
}

export function loadCommands(dir) {
  const commands = {};
  if (!existsSync(dir)) return commands;
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.md')) {
      commands[name.replace('.md', '')] = readFileSync(join(dir, name), 'utf8');
    }
  }
  return commands;
}

export function loadAgents(dir) {
  const agents = {};
  if (!existsSync(dir)) return agents;
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.md')) {
      agents[name.replace('.md', '')] = readFileSync(join(dir, name), 'utf8');
    }
  }
  return agents;
}
