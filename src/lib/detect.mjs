/**
 * detect.mjs — 项目特征探测（确定性信号，零第三方依赖）
 *
 * 目的：为 ui-design 阶段的 `enabled:'auto' + condition:'frontend'` 门禁提供
 * 「项目是否前端」的机械可读判定。判定必须确定、可测、无副作用——
 * 因此只看确定性文件信号，不做启发式 grep、不解析自由文本。
 *
 * 判定依据（对齐 I-intel-scan.md 1.2 框架检测的框架名单）：
 *   1. package.json 的 dependencies / devDependencies 里出现前端框架包
 *   2. 仓库根出现前端框架/构建配置文件（next.config.* / vite.config.* 等）
 *
 * 三态返回：
 *   true      → 命中前端信号
 *   false     → 有 package.json 但无任何前端信号（明确非前端，如本 CLI 工具）
 *   undefined → 无从判断（无 package.json 且无前端配置文件）——保守留给上层「不跳过」
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 前端框架包名（对齐 intel-scan 1.2：react / vue / svelte / next / nuxt / angular）。
// 用精确包名匹配，避免 "react" 子串误伤（如 "react-native-web" 仍算前端，符合预期）。
const FRONTEND_PACKAGES = [
  'react', 'react-dom', 'react-native',
  'vue', '@vue/runtime-core',
  'svelte',
  'next', 'nuxt',
  '@angular/core',
  'solid-js', 'preact', 'lit',
  '@sveltejs/kit',
];

// 前端框架 / 构建工具的根配置文件（存在即视为前端信号）。
const FRONTEND_CONFIG_FILES = [
  'next.config.js', 'next.config.mjs', 'next.config.ts',
  'nuxt.config.js', 'nuxt.config.ts',
  'vite.config.js', 'vite.config.mjs', 'vite.config.ts',
  'svelte.config.js', 'svelte.config.mjs',
  'angular.json',
  'vue.config.js',
];

/**
 * 判定项目是否为前端项目（确定性文件信号）。
 * @param {string} projectRoot
 * @returns {boolean|undefined} true=前端 / false=明确非前端 / undefined=无从判断
 */
export function detectFrontend(projectRoot) {
  // 信号 2：根前端配置文件（先查，命中即定，不依赖 package.json 可解析）
  for (const name of FRONTEND_CONFIG_FILES) {
    if (existsSync(join(projectRoot, name))) return true;
  }

  // 信号 1：package.json 依赖
  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    // 无 package.json 且无前端配置文件 → 无从判断，交回上层保守处理
    return undefined;
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    // package.json 损坏无法解析 → 无从判断
    return undefined;
  }

  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
  };
  for (const name of FRONTEND_PACKAGES) {
    if (Object.prototype.hasOwnProperty.call(deps, name)) return true;
  }

  // 有 package.json 但无任何前端信号 → 明确非前端
  return false;
}
