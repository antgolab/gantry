/**
 * hooks.mjs — 阶段 hook 执行器
 * 类型自动推断：http(s):// → fetch POST，*.mjs/*.js/路径 → import()，其余 → execSync
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function detectType(cmd) {
  if (/^https?:\/\//.test(cmd)) return 'http';
  if (/\.(mjs|js)$/.test(cmd) || cmd.startsWith('./') || cmd.startsWith('/')) return 'script';
  return 'shell';
}

async function runOne(hookDef, projectRoot, event) {
  const cmd = typeof hookDef === 'string' ? hookDef : hookDef.cmd;
  const type = (typeof hookDef === 'object' && hookDef.type) || detectType(cmd);

  try {
    if (type === 'http') {
      const res = await fetch(cmd, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, projectRoot }),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    }

    if (type === 'script') {
      const scriptPath = resolve(projectRoot, cmd);
      if (!existsSync(scriptPath)) return { ok: false, error: `脚本不存在: ${scriptPath}` };
      const mod = await import(scriptPath);
      if (typeof mod.default !== 'function') return { ok: false, error: '脚本未导出 default 函数' };
      await mod.default({ projectRoot, event });
      return { ok: true };
    }

    // shell (default)
    execSync(cmd, { cwd: projectRoot, stdio: 'inherit' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 运行阶段 hook
 * @param {object} config - 项目配置（含 hooks 字段）
 * @param {string} event  - "before:dev" / "after:test" 等
 * @param {string} projectRoot
 * @returns {Promise<{ ok: boolean, skipped?: boolean }>}
 */
export async function runHook(config, event, projectRoot) {
  const hookDef = config?.hooks?.[event];
  if (!hookDef) return { ok: true, skipped: true };

  const label = typeof hookDef === 'string' ? hookDef : hookDef.cmd;
  console.log(`⚙ hook ${event}: ${label}`);

  const result = await runOne(hookDef, projectRoot, event);
  if (!result.ok) {
    console.error(`✗ hook ${event} 失败: ${result.error}`);
  } else {
    console.log(`✓ hook ${event} 通过`);
  }
  return result;
}

/**
 * 列出所有已配置的 hook
 */
export function listHooks(config) {
  return config?.hooks || {};
}
