/**
 * agents.mjs — Agent 角色分发 + 约束检查 + prompt 组装
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE_FILES } from './phases.mjs';
import { queryBeforeWork } from './failure-memory.mjs';
import { parseTasks } from './tasks.mjs';
import { selectModel } from './model-router.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AGENTS_DIR = join(__dirname, '..', 'agents');

// 阶段 → Agent 角色映射
const STAGE_AGENT_MAP = {
  change:       'planner',
  requirement:  'planner',
  design:       'architect',
  'ui-design':  'architect',
  task:         'planner',
  dev:          'executor',
  test:         'reviewer',
  review:       'reviewer',
  integration:  'integrator',
  scan:         'researcher',
  health:       'curator',
  knowledge:    'researcher',
  architect:    'architect',
  evolve:       'architect',
  restyle:      'architect',
  fast:         'executor',
};

/**
 * 获取阶段对应的 agent 角色名
 */
export function getAgentForStage(stage) {
  return STAGE_AGENT_MAP[stage] || null;
}

/**
 * 加载 agent 定义（解析 frontmatter + body）
 */
export function loadAgent(agentName) {
  const filePath = join(AGENTS_DIR, `${agentName}.md`);
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, 'utf-8');
  return parseAgentDef(content, agentName);
}

/**
 * 列出所有可用 agent
 */
export function listAgents() {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const name = f.replace('.md', '');
      const agent = loadAgent(name);
      return { name, display: agent?.display || name, stages: agent?.stages || [] };
    });
}

/**
 * 检查 agent 约束是否被违反
 * @param {string} agentName - agent 角色名
 * @param {object} action - { type: 'write', path: '...' }
 * @returns {{ allowed: boolean, violation?: string }}
 */
export function checkConstraint(agentName, action) {
  const agent = loadAgent(agentName);
  if (!agent) return { allowed: true };

  // 检查写入权限
  if (action.type === 'write' && agent.capabilities?.write) {
    const allowedPaths = agent.capabilities.write;
    const isAllowed = allowedPaths.some(pattern => {
      if (pattern.includes('*')) {
        const prefix = pattern.replace('*', '');
        return action.path.startsWith(prefix) || action.path.includes(prefix.replace('/', ''));
      }
      return action.path.endsWith(pattern);
    });

    if (!isAllowed) {
      return {
        allowed: false,
        violation: `Agent "${agentName}" 不允许写入 ${action.path}。允许范围: ${allowedPaths.join(', ')}`,
      };
    }
  }

  return { allowed: true };
}

/**
 * 组装完整的 agent prompt（agent 定义 + 阶段 prompt + 上下文）
 * @param {string} stage - 当前阶段
 * @param {object} context - { specsDir, projectRoot, changeId, taskId, task? }
 * @returns {object} { agentName, prompt, phaseFile, constraints, lessonsContext?, model }
 */
export function assemblePrompt(stage, context) {
  const agentName = getAgentForStage(stage);
  const agent = loadAgent(agentName);
  const phaseFile = PHASE_FILES[stage];

  const coreDir = join(dirname(__dirname), 'core');
  const phasePromptPath = join(coreDir, 'phases', phaseFile);
  const phasePrompt = existsSync(phasePromptPath)
    ? readFileSync(phasePromptPath, 'utf-8')
    : null;

  // 收集上下文文件
  const contextFiles = [];
  if (context.specsDir) {
    const specFiles = ['CONTEXT.md', 'CHANGE.md', 'REQUIREMENT.md', 'DESIGN.md', 'UI-DESIGN.md', 'TASK.md'];
    for (const f of specFiles) {
      const p = join(context.specsDir, f);
      if (existsSync(p)) contextFiles.push({ name: f, path: p });
    }
  }

  // Failure Memory: query LESSONS before work
  let lessonsContext = '';
  let task = context.task || null;
  if (context.specsDir) {
    if (!task && context.taskId) {
      const taskMdPath = join(context.specsDir, 'TASK.md');
      if (existsSync(taskMdPath)) {
        const tasks = parseTasks(taskMdPath);
        task = tasks.find(t => t.id === context.taskId) || null;
      }
    }
    if (task) {
      const result = queryBeforeWork(context.specsDir, task);
      lessonsContext = result.context;
    }
  }

  // Model routing
  const modelResult = task
    ? selectModel(task, { stage, pipeline: 'standard' })
    : { tier: 'standard', reason: 'no task context' };

  return {
    agentName,
    agentDisplay: agent?.display || agentName,
    phaseFile,
    phasePromptPath,
    constraints: agent?.constraints || [],
    freshContext: agent?.freshContext || false,
    contextFiles,
    lessonsContext,
    model: modelResult.tier,
    modelReason: modelResult.reason,
    summary: `[${agent?.display || agentName}] 执行阶段 ${stage}，prompt: phases/${phaseFile}`,
  };
}

// --- 内部辅助 ---

function parseAgentDef(content, name) {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return { name, body: content };
  }

  const frontmatter = frontmatterMatch[1];
  const body = content.slice(frontmatterMatch[0].length).trim();

  // 简单 YAML 解析（避免外部依赖）
  const def = { name, body };
  for (const line of frontmatter.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (!kv) continue;
    const [, key, value] = kv;

    if (value.startsWith('[')) {
      def[key] = value.replace(/[\[\]"']/g, '').split(',').map(s => s.trim());
    } else if (value === 'true' || value === 'false') {
      def[key] = value === 'true';
    } else {
      def[key] = value;
    }
  }

  // 解析 capabilities 块
  const capMatch = frontmatter.match(/capabilities:\n([\s\S]*?)(?=\n\w|\n---)/);
  if (capMatch) {
    def.capabilities = {};
    for (const line of capMatch[1].split('\n')) {
      const m = line.match(/\s+(\w+):\s*(.+)/);
      if (m) {
        const val = m[2].trim();
        if (val.startsWith('[')) {
          def.capabilities[m[1]] = val.replace(/[\[\]"']/g, '').split(',').map(s => s.trim());
        } else if (val === 'true' || val === 'false') {
          def.capabilities[m[1]] = val === 'true';
        } else {
          def.capabilities[m[1]] = val;
        }
      }
    }
  }

  return def;
}
