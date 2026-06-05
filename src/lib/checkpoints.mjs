/**
 * checkpoints.mjs — Checkpoint 系统
 * 管理阶段间的人工确认、决策点和自动推进
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const PLANNING_DIR = '.planning';
const CHECKPOINTS_DIR = 'checkpoints';

/**
 * 创建 checkpoint
 * @param {string} projectRoot
 * @param {object} opts - { changeId, stage, type, prompt, artifacts }
 * @returns {object} checkpoint 对象
 */
export function createCheckpoint(projectRoot, opts) {
  const dir = join(projectRoot, PLANNING_DIR, CHECKPOINTS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const id = `cp-${randomBytes(3).toString('hex')}`;
  const checkpoint = {
    id,
    changeId: opts.changeId,
    stage: opts.stage,
    type: opts.type || 'human-verify',
    status: 'pending',
    createdAt: new Date().toISOString(),
    prompt: opts.prompt || `阶段 ${opts.stage} 完成，等待确认`,
    artifacts: opts.artifacts || [],
    resolution: null,
    resolvedAt: null,
  };

  const filename = `${opts.changeId}-${opts.stage}-${id}.json`;
  writeFileSync(join(dir, filename), JSON.stringify(checkpoint, null, 2), 'utf-8');
  return checkpoint;
}

/**
 * 解决 checkpoint
 */
export function resolveCheckpoint(projectRoot, checkpointId, resolution) {
  const dir = join(projectRoot, PLANNING_DIR, CHECKPOINTS_DIR);
  const files = readdirSync(dir).filter(f => f.includes(checkpointId));

  if (files.length === 0) {
    return { error: `未找到 checkpoint: ${checkpointId}` };
  }

  const filePath = join(dir, files[0]);
  const checkpoint = JSON.parse(readFileSync(filePath, 'utf-8'));
  checkpoint.status = 'resolved';
  checkpoint.resolution = resolution || 'approved';
  checkpoint.resolvedAt = new Date().toISOString();
  writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');
  return checkpoint;
}

/**
 * 列出所有 checkpoints
 */
export function listCheckpoints(projectRoot, filter) {
  const dir = join(projectRoot, PLANNING_DIR, CHECKPOINTS_DIR);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const checkpoints = files.map(f =>
    JSON.parse(readFileSync(join(dir, f), 'utf-8'))
  );

  if (filter === 'pending') return checkpoints.filter(cp => cp.status === 'pending');
  if (filter === 'resolved') return checkpoints.filter(cp => cp.status === 'resolved');
  return checkpoints;
}

/**
 * 获取当前阶段是否需要 checkpoint
 */
export function shouldCheckpoint(stage, config) {
  const stageConfig = config?.stages?.[stage];
  if (!stageConfig) return false;
  return stageConfig.checkpoint === 'human-verify' || stageConfig.checkpoint === 'decision';
}

/**
 * 获取最近的 pending checkpoint
 */
export function getPendingCheckpoint(projectRoot, changeId) {
  const all = listCheckpoints(projectRoot, 'pending');
  if (changeId) return all.find(cp => cp.changeId === changeId);
  return all[0] || null;
}
