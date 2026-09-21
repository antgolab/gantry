// Shared renderer constants.
// Single source of truth for the public skill surface and the stage→phase map,
// consumed by all renderers (claude-code / codex / copilot / cursor) so adding a
// new stage or public entry point is a one-place edit instead of a 4-file sync.

// Public orchestration commands (skills/) exposed as user-facing entry points.
// Skills not listed here are internal and referenced through .gantry/core/phases/*.
//
// Deprecated (2026-09-21 · 内部化)：exec / fast 已从公开入口下沉为内部机制
//   - exec：dev 阶段由 /gantry-next 或 /gantry-auto 自动触发，无需用户手动敲
//   - fast：light 挡位由 /gantry-change / /gantry-auto 内部判定
//   - knowledge：capture / curate 已并入 /gantry-context 的 subcommand
// 源文件仍保留在 skills/ 目录下供内部调用与向后兼容；renderer 不再产出为用户 skill。
export const PUBLIC_SKILLS = new Set([
  'status',
  'change',
  'next',
  'adjust',
  'resume',
  'archive',
  'unarchive',
  'auto',
  'review',
  'health',
  'context',
  'debug',
]);

// Map skill stage field → phase filename (without .md)
export const STAGE_PHASE_MAP = {
  change: '0-change',
  requirement: '1-requirement',
  design: '2-design',
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
