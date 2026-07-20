// Shared renderer constants.
// Single source of truth for the public skill surface and the stage→phase map,
// consumed by all renderers (claude-code / codex / copilot / cursor) so adding a
// new stage or public entry point is a one-place edit instead of a 4-file sync.

// Public orchestration commands (skills/) exposed as user-facing entry points.
// Skills not listed here are internal and referenced through .gantry/core/phases/*.
export const PUBLIC_SKILLS = new Set([
  'status',
  'change',
  'next',
  'exec',
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

// Map skill stage field → phase filename (without .md)
export const STAGE_PHASE_MAP = {
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
