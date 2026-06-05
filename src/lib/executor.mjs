/**
 * executor.mjs — 并行 prompt 包组装 + 上下文隔离 + wave 执行
 *
 * Prompt assembler 模式：不执行 AI 调用，只生成结构化 prompt 包供 IDE 消费。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseTasks, groupWaves } from './tasks.mjs';
import { assemblePrompt } from './agents.mjs';
import { selectModel } from './model-router.mjs';
import { queryBeforeWork } from './failure-memory.mjs';

/**
 * @typedef {Object} PromptPackage
 * @property {string} taskId
 * @property {string} agentDef - agent 定义内容
 * @property {string} phasePrompt - 阶段 prompt 内容
 * @property {string[]} taskFiles - task.read_files 的实际内容
 * @property {string} lessonsContext - LESSONS grep 命中条目
 * @property {string} model - 模型层级 (fast|standard|deep)
 * @property {object} metadata - { stage, pipeline, taskId, writeFiles }
 */

/**
 * 为一个 wave 生成所有 prompt 包（并行组装）
 * @param {object[]} wave - 当前 wave 的任务列表
 * @param {object} options - { specsDir, projectRoot, stage, pipeline }
 * @returns {PromptPackage[]}
 */
export function assembleWave(wave, options) {
  const { specsDir, projectRoot, stage = 'dev', pipeline = 'standard' } = options;

  return wave.map(task => buildPromptPackage(task, { specsDir, projectRoot, stage, pipeline }));
}

/**
 * 为单个任务构造最小上下文 prompt 包
 * @param {object} task - 任务对象
 * @param {object} options - { specsDir, projectRoot, stage, pipeline, retryCount }
 * @returns {PromptPackage}
 */
export function buildPromptPackage(task, options) {
  const { specsDir, projectRoot, stage = 'dev', pipeline = 'standard', retryCount = 0 } = options;

  // Model selection
  const { tier, reason } = selectModel(task, { stage, pipeline, retryCount });

  // Assemble base prompt (includes lessonsContext)
  const assembled = assemblePrompt(stage, {
    specsDir,
    projectRoot,
    changeId: specsDir ? specsDir.split('/').pop() : '',
    taskId: task.id,
    task,
  });

  // Read task.read_files content for context isolation
  const taskFiles = readTaskFiles(task, projectRoot);

  // Read agent definition content
  const agentDef = assembled.phasePromptPath && existsSync(assembled.phasePromptPath)
    ? readFileSync(assembled.phasePromptPath, 'utf-8')
    : '';

  return {
    taskId: task.id,
    agentName: assembled.agentName,
    agentDef,
    phaseFile: assembled.phaseFile,
    taskFiles,
    lessonsContext: assembled.lessonsContext || '',
    model: tier,
    modelReason: reason,
    constraints: assembled.constraints,
    metadata: {
      stage,
      pipeline,
      taskId: task.id,
      taskTitle: task.title,
      writeFiles: task.writeFiles || [],
      readFiles: task.readFiles || [],
    },
  };
}

/**
 * 从 TASK.md 加载任务并按 wave 生成全部 prompt 包
 * @param {string} specsDir - .specs/<change-id>/ 路径
 * @param {object} options - { projectRoot, stage, pipeline }
 * @returns {{ waves: PromptPackage[][], progress: object }}
 */
export function assembleAllWaves(specsDir, options = {}) {
  const taskMdPath = join(specsDir, 'TASK.md');
  if (!existsSync(taskMdPath)) {
    return { waves: [], progress: { total: 0, done: 0, percent: 0 } };
  }

  const tasks = parseTasks(taskMdPath);
  const waves = groupWaves(tasks);

  const promptWaves = waves.map(wave =>
    assembleWave(wave, { ...options, specsDir })
  );

  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;

  return {
    waves: promptWaves,
    progress: { total, done, pending: total - done, percent: Math.round((done / total) * 100) },
  };
}

// --- 内部辅助 ---

function readTaskFiles(task, projectRoot) {
  const files = [];
  if (!task.readFiles || !projectRoot) return files;

  for (const filePath of task.readFiles) {
    const fullPath = join(projectRoot, filePath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        files.push({ path: filePath, content });
      } catch {
        files.push({ path: filePath, content: `[ERROR: could not read ${filePath}]` });
      }
    } else {
      files.push({ path: filePath, content: `[NOT FOUND: ${filePath}]` });
    }
  }

  return files;
}
