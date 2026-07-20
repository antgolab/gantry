/**
 * agents.mjs — stage → agent mapping.
 *
 * Gantry is not an agent runtime, but each stage still has a required role
 * prompt. The mapping is deterministic so STATE.md and context-pack stay in
 * sync.
 */

export const AGENT_FILES = {
  planner: 'planner.md',
  architect: 'architect.md',
  executor: 'executor.md',
  reviewer: 'reviewer.md',
  integrator: 'integrator.md',
  researcher: 'researcher.md',
  curator: 'curator.md',
};

export const STAGE_AGENTS = {
  change: 'planner',
  requirement: 'planner',
  task: 'planner',
  design: 'architect',
  'ui-design': 'architect',
  architect: 'architect',
  evolve: 'architect',
  dev: 'executor',
  fast: 'executor',
  test: 'reviewer',
  review: 'reviewer',
  integration: 'integrator',
  scan: 'researcher',
  knowledge: 'researcher',
  health: 'curator',
};

export function getAgentForStage(stage) {
  return STAGE_AGENTS[stage] || null;
}

export function getAgentFile(agent) {
  return AGENT_FILES[agent] || null;
}
