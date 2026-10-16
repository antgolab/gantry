/**
 * ac-coverage.mjs — SPEC AC 编号 ↔ test-commands.yml covers 覆盖判定(纯函数)
 *
 * 从 P1 loop.mjs 抽出(T-FIX-01 · REVIEW Round 2 · R5 Dependency Disorder):
 *   P3 让 phases.mjs 反向 import loop.mjs 的 checkAcCoverage,破坏了 loop.mjs
 *   头注释「依赖单向:loop.mjs → phases.mjs」不变式。把 AC 覆盖判定抽到这个
 *   叶子模块后,phases 与 loop 各自 import 它,循环解除。
 *
 * loop.mjs 保留 re-export 以维持既有 test 与 cli 的 import 路径。
 *
 * 零 IO 承诺被 `readFileSync(SPEC.md)` 打破,但这是 checkAcCoverage 的既有
 * 语义(P1 交付时就已 IO);抽模块不改契约,只改依赖图。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 检查 SPEC.md 里所有 AC 编号是否都被 test-commands.yml 里某个命令的 covers 覆盖。
 *
 * **fail-closed(2026-10-12)**:SPEC 只要含 AC 编号,就必须有覆盖映射。因此
 * `testCommands` 为 `null`(文件缺失)或为 `{}`(文件存在但无有效条目)时,
 * 不再返回 `skipped`,而是把全部 AC 判为 `missing`。这是为了让「AC 强校验闸」
 * 在真实项目里真正存在——此前它是 fail-open,而 `install` 从不生成
 * `test-commands.yml`,导致每个用户项目的 integration 门禁都静默跳过。
 *
 * 唯一保留的降级放行:SPEC.md 不存在,或其中没有任何 AC 编号(无从校验)。
 *
 * @param {string} specsDir - .gantry/specs/<change-id>/
 * @param {object|null} testCommands - 解析后的 test-commands.yml;null = 无该文件
 * @returns {{ covered: string[], missing: string[], skipped: boolean }}
 */
export function checkAcCoverage(specsDir, testCommands) {
  const specPath = join(specsDir, 'SPEC.md');
  if (!existsSync(specPath)) {
    return { covered: [], missing: [], skipped: true };
  }

  const acIds = extractAcIds(readFileSync(specPath, 'utf-8'));
  if (acIds.length === 0) {
    return { covered: [], missing: [], skipped: true };
  }

  // 收集所有 covers 项(合并所有命令);null / 非对象 = 无任何覆盖映射
  const allCovers = new Set();
  if (testCommands != null && typeof testCommands === 'object') {
    for (const cmdKey of Object.keys(testCommands)) {
      const covers = testCommands[cmdKey]?.covers;
      if (Array.isArray(covers)) {
        for (const c of covers) allCovers.add(c);
      }
    }
  }

  const wildcard = allCovers.has('*');
  const covered = [];
  const missing = [];
  for (const ac of acIds) {
    if (wildcard || allCovers.has(ac)) covered.push(ac);
    else missing.push(ac);
  }
  // 保留通配符信息(方便 driver 上报)
  if (wildcard) covered.push('*');
  return { covered, missing, skipped: false };
}

/**
 * 抠出 SPEC.md 里的 AC 编号(AC-1, AC-2, ...)。
 * 语法:行首 `###` 或 `####` 后紧跟 `AC-<数字>` 单词边界。
 */
export function extractAcIds(content) {
  const ids = new Set();
  const regex = /^#{2,4}\s+(AC-\d+)\b/gm;
  let m;
  while ((m = regex.exec(content)) != null) {
    ids.add(m[1]);
  }
  return Array.from(ids).sort((a, b) => {
    const na = parseInt(a.slice(3), 10);
    const nb = parseInt(b.slice(3), 10);
    return na - nb;
  });
}
