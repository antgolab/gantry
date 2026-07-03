/**
 * config.mjs — gantry 配置读取(单一事实源)
 *
 * 全局 (~/.gantry/config.json) + 项目 (.gantry/planning/config.json) 深合并,项目覆盖全局。
 * CLI 命令与 context-pack 生成共用此函数,避免"pack 看不到全局 config"的语义分叉。
 * 解析失败(文件损坏)按空对象容错,不抛。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PLANNING_DIR } from './paths.mjs';

function readJsonSafe(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

export function readConfig(projectRoot) {
  const global = readJsonSafe(join(homedir(), '.gantry', 'config.json'));
  const project = readJsonSafe(join(projectRoot, PLANNING_DIR, 'config.json'));
  return deepMerge(global, project);
}

export function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (override[key] && typeof override[key] === 'object' && !Array.isArray(override[key])
        && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}
