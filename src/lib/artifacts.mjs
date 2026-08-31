/**
 * artifacts.mjs — 工件命名表
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const ARTIFACT_ALIASES = {
  proposal: ['PROPOSAL.md'],
  spec: ['SPEC.md'],
  design: ['DESIGN.md'],
  'ui-design': ['UI-DESIGN.md'],
  tasks: ['TASKS.md'],
  execution: ['EXECUTION.md'],
  test: ['TEST.md'],
  review: ['REVIEW.md'],
  integration: ['UAT.md'],
  blockers: ['BLOCKERS.md'],
  followups: ['FOLLOWUPS.md'],
};

export function artifactCandidates(key) {
  return ARTIFACT_ALIASES[key] ? [...ARTIFACT_ALIASES[key]] : [];
}

export function getPreferredArtifactName(key) {
  return artifactCandidates(key)[0] || null;
}

export function resolveArtifactPath(baseDir, key) {
  for (const name of artifactCandidates(key)) {
    const path = join(baseDir, name);
    if (existsSync(path)) return { key, name, path };
  }
  const preferred = getPreferredArtifactName(key);
  return preferred ? { key, name: preferred, path: join(baseDir, preferred) } : null;
}

export function artifactExists(baseDir, key) {
  return artifactCandidates(key).some(name => existsSync(join(baseDir, name)));
}
