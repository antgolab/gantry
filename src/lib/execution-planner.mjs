/**
 * execution-planner.mjs — task → agent/runtime/model execution plan
 */

import { selectModel } from './model-router.mjs';

const AGENT_CAPABILITIES = {
  executor: {
    runtimes: ['subagent', 'workflow'],
    isolation: ['shared-worktree', 'worktree'],
    models: ['fast', 'standard', 'deep'],
    workflowRoles: ['reviewer'],
    specializations: ['implementation', 'security', 'api', 'schema', 'ui'],
    fallbackRuntime: 'subagent',
    fallbackIsolation: 'shared-worktree',
    fallbackModel: 'standard',
  },
  planner: {
    runtimes: ['subagent'],
    isolation: ['shared-worktree'],
    models: ['standard', 'deep'],
    workflowRoles: ['reviewer'],
    specializations: ['requirements', 'task-breakdown'],
    fallbackRuntime: 'subagent',
    fallbackIsolation: 'shared-worktree',
    fallbackModel: 'standard',
  },
  architect: {
    runtimes: ['subagent', 'workflow'],
    isolation: ['shared-worktree'],
    models: ['standard', 'deep'],
    workflowRoles: ['reviewer'],
    specializations: ['architecture', 'ui-design', 'api', 'schema'],
    fallbackRuntime: 'subagent',
    fallbackIsolation: 'shared-worktree',
    fallbackModel: 'deep',
  },
  reviewer: {
    runtimes: ['subagent'],
    isolation: ['shared-worktree'],
    models: ['standard', 'deep'],
    workflowRoles: [],
    specializations: ['test', 'review', 'security-review', 'api-review', 'verification'],
    fallbackRuntime: 'subagent',
    fallbackIsolation: 'shared-worktree',
    fallbackModel: 'standard',
  },
  researcher: {
    runtimes: ['subagent'],
    isolation: ['shared-worktree'],
    models: ['fast', 'standard'],
    workflowRoles: ['reviewer'],
    specializations: ['scan', 'knowledge', 'documentation'],
    fallbackRuntime: 'subagent',
    fallbackIsolation: 'shared-worktree',
    fallbackModel: 'standard',
  },
  curator: {
    runtimes: ['subagent'],
    isolation: ['shared-worktree'],
    models: ['fast', 'standard'],
    workflowRoles: [],
    specializations: ['health', 'lessons', 'metrics'],
    fallbackRuntime: 'subagent',
    fallbackIsolation: 'shared-worktree',
    fallbackModel: 'standard',
  },
  integrator: {
    runtimes: ['subagent', 'workflow'],
    isolation: ['shared-worktree', 'worktree'],
    models: ['standard', 'deep'],
    workflowRoles: ['reviewer'],
    specializations: ['integration', 'uat', 'release'],
    fallbackRuntime: 'subagent',
    fallbackIsolation: 'shared-worktree',
    fallbackModel: 'standard',
  },
};

const LOGICAL_AGENT_MAP = {
  writer: { agent: 'researcher', specialization: 'documentation' },
  verifier: { agent: 'reviewer', specialization: 'verification' },
  'test-engineer': { agent: 'reviewer', specialization: 'test' },
  'security-reviewer': { agent: 'reviewer', specialization: 'security-review' },
  'api-reviewer': { agent: 'reviewer', specialization: 'api-review' },
};

const MODEL_ORDER = ['fast', 'standard', 'deep'];

/**
 * @param {object} task
 * @param {object} context - { stage, pipeline, retryCount, repaired? }
 * @returns {{
 *   agent: string,
 *   runtime: 'subagent'|'workflow',
 *   isolation: 'shared-worktree'|'worktree',
 *   model: 'fast'|'standard'|'deep',
 *   workflow: string[],
 *   risk: 'low'|'medium'|'high',
 *   specialization: string,
 *   reasons: string[]
 * }}
 */
export function planExecution(task, context = {}) {
  const { stage = 'dev', pipeline = 'standard', retryCount = 0, repaired = false } = context;
  const reasons = [];
  const risk = classifyRisk(task, { repaired, retryCount }, reasons);
  const role = chooseAgent(task, stage, reasons);
  const { agent, specialization } = resolveLogicalAgent(role, task, stage, reasons);
  const runtime = chooseRuntime(task, risk, reasons);
  const isolation = chooseIsolation(task, risk, runtime, reasons);
  const modelResult = selectModel(task, { stage, pipeline, retryCount, risk });
  let model = modelResult.tier;

  if (risk === 'high' && model !== 'deep') {
    model = 'deep';
    reasons.push('high risk task escalated to deep model');
  } else {
    reasons.push(modelResult.reason);
  }

  const workflow = chooseWorkflow(agent, risk, task, reasons);

  return normalizeExecutionPlan({
    agent,
    requestedAgent: role,
    specialization,
    runtime,
    isolation,
    model,
    modelReason: modelResult.reason,
    workflow,
    risk,
    reasons,
  });
}

function classifyRisk(task, context, reasons) {
  const text = taskText(task);
  const writeCount = (task.writeFiles || []).length;
  const readCount = (task.readFiles || []).length;
  const explicitRisk = task.risk;

  if (context.retryCount >= 2) {
    reasons.push('retry count indicates prior execution failures');
    return 'high';
  }
  if (context.repaired) {
    reasons.push('schedule used dependency auto-repair');
    return 'high';
  }
  if (explicitRisk === 'high') {
    reasons.push('task declares high risk');
    return 'high';
  }
  if (matchesAny(text, ['security', 'auth', 'payment', 'migration', 'schema', 'concurrency', '安全', '支付', '迁移', '并发'])) {
    reasons.push('task content touches high-risk domain');
    return 'high';
  }
  if (writeCount > 5 || readCount > 8) {
    reasons.push('task touches many files');
    return 'high';
  }
  if (explicitRisk === 'low' || (writeCount <= 1 && matchesAny(text, ['typo', 'readme', 'docs', 'lint', 'format', 'comment']))) {
    reasons.push('task is small and low-risk');
    return 'low';
  }
  return 'medium';
}

function chooseAgent(task, stage, reasons) {
  const text = taskText(task);
  if (stage === 'change' || stage === 'requirement' || stage === 'task') {
    reasons.push('planning stage routed to planner');
    return 'planner';
  }
  if (stage === 'scan' || stage === 'knowledge') {
    reasons.push('research stage routed to researcher');
    return 'researcher';
  }
  if (stage === 'health') {
    reasons.push('health stage routed to curator');
    return 'curator';
  }
  if (stage === 'integration') {
    reasons.push('integration stage routed to integrator');
    return 'integrator';
  }
  if (stage === 'test' || (!matchesImplementationIntent(text) && matchesAny(text, ['test', 'spec', 'coverage', '测试']))) {
    reasons.push('test-focused task routed to test-engineer');
    return 'test-engineer';
  }
  if (stage === 'review' || matchesReviewIntent(text)) {
    reasons.push('review-focused task routed to verifier');
    return 'verifier';
  }
  if (stage === 'design' || matchesAny(text, ['architect', 'design', '架构', '设计'])) {
    reasons.push('design task routed to architect');
    return 'architect';
  }
  if (matchesAny(text, ['docs', 'readme', 'documentation', '文档'])) {
    reasons.push('documentation task routed to writer');
    return 'writer';
  }
  return 'executor';
}

function resolveLogicalAgent(role, task, stage, reasons) {
  if (AGENT_CAPABILITIES[role]) {
    return {
      agent: role,
      specialization: inferSpecialization(role, task, stage),
    };
  }

  const mapped = LOGICAL_AGENT_MAP[role] || { agent: 'executor', specialization: 'implementation' };
  reasons.push(`${role} is a logical role backed by ${mapped.agent}`);
  return {
    agent: mapped.agent,
    specialization: inferSpecialization(mapped.agent, task, stage, mapped.specialization),
  };
}

function chooseRuntime(task, risk, reasons) {
  if (risk === 'high') {
    reasons.push('high risk task uses workflow runtime');
    return 'workflow';
  }
  if ((task.writeFiles || []).length === 0) {
    reasons.push('read-only task can run as subagent');
    return 'subagent';
  }
  reasons.push('bounded write task can run as subagent');
  return 'subagent';
}

function chooseIsolation(task, risk, runtime, reasons) {
  if (runtime === 'workflow' || risk === 'high') {
    reasons.push('high risk or workflow execution should use isolated worktree');
    return 'worktree';
  }
  reasons.push('shared worktree is acceptable for conflict-free wave task');
  return 'shared-worktree';
}

function chooseWorkflow(agent, risk, task, reasons) {
  if (risk !== 'high') return [agent];

  const text = taskText(task);
  if (matchesAny(text, ['security', 'auth', 'payment', '安全', '支付'])) {
    reasons.push('security-sensitive task adds reviewer security specialization');
    return [agent, 'reviewer'];
  }
  if (matchesAny(text, ['schema', 'migration', 'api', '迁移'])) {
    reasons.push('contract-sensitive task adds reviewer API specialization');
    return [agent, 'reviewer'];
  }
  return [agent, 'reviewer'];
}

function normalizeExecutionPlan(plan) {
  const caps = AGENT_CAPABILITIES[plan.agent] || AGENT_CAPABILITIES.executor;
  const normalized = {
    ...plan,
    reasons: [...plan.reasons],
  };

  if (!caps.specializations.includes(normalized.specialization)) {
    const fallbackSpecialization = caps.specializations[0] || 'general';
    normalized.reasons.push(`${normalized.agent} does not support specialization ${normalized.specialization}; using ${fallbackSpecialization}`);
    normalized.specialization = fallbackSpecialization;
  }

  if (!caps.runtimes.includes(normalized.runtime)) {
    normalized.reasons.push(`${normalized.agent} does not support runtime ${normalized.runtime}; using ${caps.fallbackRuntime}`);
    normalized.runtime = caps.fallbackRuntime;
  }

  if (!caps.isolation.includes(normalized.isolation)) {
    normalized.reasons.push(`${normalized.agent} does not support isolation ${normalized.isolation}; using ${caps.fallbackIsolation}`);
    normalized.isolation = caps.fallbackIsolation;
  }

  if (!caps.models.includes(normalized.model)) {
    const nextModel = nearestAllowedModel(normalized.model, caps.models, caps.fallbackModel);
    normalized.reasons.push(`${normalized.agent} does not support model ${normalized.model}; using ${nextModel}`);
    normalized.model = nextModel;
  }

  normalized.workflow = normalizeWorkflow(normalized.workflow, normalized.agent, caps, normalized.reasons);

  if (normalized.workflow.length <= 1 && normalized.runtime === 'workflow') {
    normalized.reasons.push(`${normalized.agent} workflow has no supported follow-up roles; using ${caps.fallbackRuntime}`);
    normalized.runtime = caps.fallbackRuntime;
    normalized.isolation = caps.fallbackIsolation;
  }

  return normalized;
}

function normalizeWorkflow(workflow, agent, caps, reasons) {
  const normalized = [];
  for (let i = 0; i < workflow.length; i++) {
    const role = workflow[i];
    const resolved = LOGICAL_AGENT_MAP[role]?.agent || role;
    if (i === 0) {
      if (resolved !== agent) {
        reasons.push(`workflow primary role ${role} normalized to ${agent}`);
      }
      normalized.push(agent);
      continue;
    }

    if (caps.workflowRoles.includes(resolved) && !normalized.includes(resolved)) {
      normalized.push(resolved);
    } else if (!caps.workflowRoles.includes(resolved)) {
      reasons.push(`${agent} does not support workflow role ${role}; removed`);
    }
  }
  return normalized.length > 0 ? normalized : [agent];
}

function nearestAllowedModel(model, allowed, fallback) {
  if (allowed.includes(model)) return model;
  const target = MODEL_ORDER.indexOf(model);
  const candidates = allowed
    .map(candidate => ({
      model: candidate,
      distance: Math.abs(MODEL_ORDER.indexOf(candidate) - target),
    }))
    .sort((a, b) => a.distance - b.distance);
  return candidates[0]?.model || fallback;
}

function inferSpecialization(agent, task, stage, fallback = null) {
  const text = taskText(task);
  if (agent === 'planner') {
    if (stage === 'task') return 'task-breakdown';
    return 'requirements';
  }
  if (agent === 'architect') {
    if (stage === 'ui-design' || matchesAny(text, ['ui', 'visual', 'design token'])) return 'ui-design';
    if (matchesAny(text, ['api', 'schema', 'contract'])) return 'api';
    return 'architecture';
  }
  if (agent === 'reviewer') {
    if (stage === 'test' || matchesAny(text, ['test', 'coverage', 'spec'])) return 'test';
    if (matchesAny(text, ['security', 'auth', 'payment'])) return 'security-review';
    if (matchesAny(text, ['api', 'schema', 'migration'])) return 'api-review';
    if (fallback) return fallback;
    return 'review';
  }
  if (agent === 'researcher') {
    if (matchesAny(text, ['docs', 'readme', 'documentation'])) return 'documentation';
    if (stage === 'knowledge') return 'knowledge';
    return 'scan';
  }
  if (agent === 'curator') return 'health';
  if (agent === 'integrator') return 'integration';
  if (matchesAny(text, ['security', 'auth', 'payment'])) return 'security';
  if (matchesAny(text, ['api', 'schema', 'migration'])) return 'api';
  if (matchesAny(text, ['ui', 'visual'])) return 'ui';
  return 'implementation';
}

function taskText(task) {
  return `${task.title || ''} ${task.body || ''} ${(task.writeFiles || []).join(' ')}`.toLowerCase();
}

function matchesAny(text, keywords) {
  return keywords.some(keyword => text.includes(keyword));
}

function matchesReviewIntent(text) {
  return /\b(review|audit|verify|verification)\b/.test(text) || matchesAny(text, ['审查', '验证']);
}

function matchesImplementationIntent(text) {
  return /\b(implement|add|fix|update|build|create|wire|refactor)\b/.test(text) || matchesAny(text, ['实现', '修复', '新增']);
}
