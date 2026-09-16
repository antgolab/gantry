/**
 * test-commands.mjs — 零依赖 test-commands.yml 解析器
 *
 * 只支持 SPEC AC-1 声明的最小语法:
 *   - 顶级 map:`key:` 后跟缩进块
 *   - 2 空格缩进的嵌套 map(cmd + covers)
 *   - `[a, b, c]` 单行数组(covers 专用)
 *   - `#` 行尾注释(整行或行内)
 *   - 空行忽略
 *
 * 不支持:多行数组 / anchor & alias / block scalar / 顶级列表。
 *
 * 输出结构直接对齐 P1 checkAcCoverage 消费的形状:
 *   { [key]: { cmd: string, covers: string[] } }
 *
 * 与 P1 loop.mjs 单向依赖:P2 生产 → P1 消费,P1 不反查 P2。
 */

import { existsSync, readFileSync } from 'node:fs';

/**
 * @param {string} path - test-commands.yml 绝对路径
 * @returns {object|null} 文件不存在时返回 null(与 checkAcCoverage skipped 分支一致)
 * @throws {Error} 语法非法或缺 cmd 字段
 */
export function parseTestCommands(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  return parseTestCommandsFromString(raw);
}

/**
 * 便于测试:从字符串直接解析。
 */
export function parseTestCommandsFromString(raw) {
  const lines = raw.split(/\r?\n/);
  const result = {};
  let currentKey = null;
  let currentEntry = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = stripComment(rawLine);
    if (line.trim() === '') continue;

    // 顶级 key(无缩进,以 `:` 结尾或后跟内容)
    const topMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (topMatch && !line.startsWith(' ')) {
      // 提交前一个 entry
      if (currentKey != null) commitEntry(result, currentKey, currentEntry, i);
      currentKey = topMatch[1];
      currentEntry = {};
      const inline = topMatch[2].trim();
      if (inline !== '') {
        throw new Error(`[test-commands] invalid: 顶级 key "${currentKey}" 不接受行内值 (line ${i + 1})`);
      }
      continue;
    }

    // 2 空格缩进的嵌套字段
    const nestedMatch = line.match(/^ {2}([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
    if (nestedMatch) {
      if (currentEntry == null) {
        throw new Error(`[test-commands] invalid: 悬挂的嵌套字段 "${nestedMatch[1]}" (line ${i + 1})`);
      }
      const [, field, valueRaw] = nestedMatch;
      currentEntry[field] = parseValue(valueRaw.trim(), i);
      continue;
    }

    throw new Error(`[test-commands] invalid: 不支持的语法 (line ${i + 1}): ${rawLine}`);
  }

  // 提交最后一个 entry
  if (currentKey != null) commitEntry(result, currentKey, currentEntry, lines.length);

  return result;
}

function commitEntry(result, key, entry, lineNum) {
  if (!entry || typeof entry.cmd !== 'string' || entry.cmd.trim() === '') {
    throw new Error(`[test-commands] invalid: key "${key}" 缺少 cmd 字段 (near line ${lineNum})`);
  }
  const covers = Array.isArray(entry.covers) ? entry.covers : [];
  result[key] = { cmd: entry.cmd, covers };
}

function parseValue(raw, lineNum) {
  // 单行数组 [a, b, c] 或 [] 或 ['*']
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item, idx) => {
      const cleaned = item.trim().replace(/^['"]/, '').replace(/['"]$/, '');
      if (cleaned === '') {
        throw new Error(`[test-commands] invalid: 数组元素 ${idx + 1} 为空 (line ${lineNum + 1})`);
      }
      return cleaned;
    });
  }
  // 带引号字符串
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // 裸字符串
  return raw;
}

function stripComment(line) {
  // 注释:`#` 前有空白或行首;不支持转义
  let inQuote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") { inQuote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}
