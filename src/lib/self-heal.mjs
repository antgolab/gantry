/**
 * self-heal.mjs — EXECUTION.md `## Self-Heal Log` 段读写(纯函数)
 *
 * 语义边界(与 PATCH 完全隔离):
 *   - PATCH.md = 需求变更(SPEC/DESIGN/TASK 的补丁)
 *   - self-heal = dev verify 失败的重试记忆,只追加到 EXECUTION.md
 *
 * 段格式(SPEC AC-1,DESIGN §3):
 *
 *   ## Self-Heal Log
 *
 *   ### <taskId> · attempt #<n>
 *
 *   - at: <ISO8601>
 *   - reason: <单行,超长截 200 字符 + …>
 *   - command: `<单行>`
 *   - stderr:
 *     ```
 *     <多行>
 *     ```
 *
 * 依赖:仅 node:fs。不 import patch.mjs / 不读 PATCH.md(AC-8)。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const HEAL_SECTION_TITLE = '## Self-Heal Log';

const TASK_ID_RE = /^[^\s#\n\r]+$/;
const REASON_MAX = 200;
const STDERR_MAX = 8 * 1024;
const STDERR_HEAD = 6 * 1024;
const STDERR_TAIL = 2 * 1024;

const ENTRY_HEADER_RE = /^### (\S+) · attempt #(\d+)$/;

/**
 * 追加一条 self-heal 记录到 EXECUTION.md。
 *
 * @param {string} execPath - EXECUTION.md 绝对路径
 * @param {{taskId: string, reason: string, command?: string, stderr?: string, at?: string}} attempt
 * @returns {number} 新记录的 attempt 序号(从 1 起)
 * @throws {Error} execPath 不存在 / taskId 非法
 */
export function appendHealAttempt(execPath, attempt) {
  if (!existsSync(execPath)) {
    throw new Error(`[self-heal] execution file missing: ${execPath}`);
  }
  const { taskId, reason, command, stderr, at } = attempt || {};
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new Error('[self-heal] invalid taskId');
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new Error('[self-heal] reason required');
  }

  const raw = readFileSync(execPath, 'utf-8');
  const log = parseHealLog(raw);
  const prev = log[taskId] || [];
  const n = prev.length + 1;
  const iso = typeof at === 'string' && at.length > 0 ? at : new Date().toISOString();

  const block = renderEntry({
    taskId,
    attempt: n,
    at: iso,
    reason: truncateReason(reason),
    command: typeof command === 'string' && command.length > 0 ? command : null,
    stderr: typeof stderr === 'string' && stderr.length > 0 ? truncateStderr(stderr) : null,
  });

  const next = appendToSection(raw, block);
  writeFileSync(execPath, next, 'utf-8');
  return n;
}

/**
 * 读取 EXECUTION.md 的 self-heal 段,按 taskId 分组。
 *
 * @param {string} execPath
 * @returns {Object<string, Array<{attempt:number, at:string, reason:string, command:string, stderr?:string}>>}
 */
export function readHealLog(execPath) {
  if (!existsSync(execPath)) return {};
  const raw = readFileSync(execPath, 'utf-8');
  return parseHealLog(raw);
}

/**
 * 统计某 taskId 已记录的 attempt 数(int,0 表示无记录)。
 *
 * @param {object} log - readHealLog 返回的分组结果
 * @param {string} taskId
 * @returns {number}
 */
export function countRecentFailures(log, taskId) {
  if (log == null || typeof log !== 'object') return 0;
  const arr = log[taskId];
  return Array.isArray(arr) ? arr.length : 0;
}

/**
 * R2.5 上限判定(硬编码默认 3,limit 参数仅供测试覆盖)。
 *
 * @param {object} log
 * @param {string} taskId
 * @param {number} [limit=3]
 * @returns {{stop: boolean, count: number, limit: number}}
 * @throws {Error} limit 非正整数
 */
export function shouldStopHealing(log, taskId, limit = 3) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('[self-heal] invalid limit');
  }
  const count = countRecentFailures(log, taskId);
  return { stop: count >= limit, count, limit };
}

// --- 内部实现 ---

function truncateReason(s) {
  const oneLine = s.replace(/\r?\n/g, ' ').trim();
  if (oneLine.length <= REASON_MAX) return oneLine;
  return oneLine.slice(0, REASON_MAX) + '…';
}

function truncateStderr(s) {
  const bytes = Buffer.byteLength(s, 'utf-8');
  if (bytes <= STDERR_MAX) return stripEdgeBlanks(s);
  const head = s.slice(0, STDERR_HEAD);
  const tail = s.slice(-STDERR_TAIL);
  return `${stripEdgeBlanks(head)}\n[...truncated ${bytes - STDERR_HEAD - STDERR_TAIL} bytes]\n${stripEdgeBlanks(tail)}`;
}

function stripEdgeBlanks(s) {
  return s.replace(/^\s*\n+/, '').replace(/\n+\s*$/, '');
}

function renderEntry({ taskId, attempt, at, reason, command, stderr }) {
  const lines = [
    `### ${taskId} · attempt #${attempt}`,
    '',
    `- at: ${at}`,
    `- reason: ${reason}`,
  ];
  if (command != null) {
    lines.push(`- command: \`${command.replace(/\r?\n/g, ' ').trim()}\``);
  }
  if (stderr != null) {
    lines.push('- stderr:');
    lines.push('  ```');
    for (const l of stderr.split('\n')) lines.push(`  ${l}`);
    lines.push('  ```');
  }
  return lines.join('\n') + '\n';
}

function appendToSection(raw, block) {
  const sectionIdx = findSectionStart(raw);
  if (sectionIdx === -1) {
    const sep = raw.endsWith('\n') ? '' : '\n';
    return `${raw}${sep}\n${HEAL_SECTION_TITLE}\n\n${block}`;
  }
  const trimmed = raw.endsWith('\n') ? raw : raw + '\n';
  return `${trimmed}\n${block}`;
}

function findSectionStart(raw) {
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === HEAL_SECTION_TITLE) return i;
  }
  return -1;
}

function parseHealLog(raw) {
  const idx = findSectionStart(raw);
  if (idx === -1) return {};
  const lines = raw.split('\n').slice(idx + 1);

  const out = {};
  let cur = null;
  let mode = null; // 'meta' | 'stderr'
  let stderrBuf = [];

  const flush = () => {
    if (cur) {
      if (stderrBuf.length > 0) cur.entry.stderr = stderrBuf.join('\n');
      pushEntry(out, cur.entry);
    }
    cur = null; mode = null; stderrBuf = [];
  };

  for (const line of lines) {
    // 遇到新 H2 段结束
    if (/^##\s+/.test(line) && !/^###\s+/.test(line)) { flush(); break; }
    const h = line.match(ENTRY_HEADER_RE);
    if (h) {
      flush();
      cur = {
        entry: {
          taskId: h[1],
          attempt: parseInt(h[2], 10),
          at: null,
          reason: null,
          command: null,
        },
      };
      mode = 'meta';
      continue;
    }
    if (!cur) continue;

    if (mode === 'meta') {
      const at = line.match(/^-\s+at:\s*(.+)$/);
      const rs = line.match(/^-\s+reason:\s*(.+)$/);
      const cmd = line.match(/^-\s+command:\s*`(.*)`\s*$/);
      const se = line.match(/^-\s+stderr:\s*$/);
      if (at) cur.entry.at = at[1].trim();
      else if (rs) cur.entry.reason = rs[1].trim();
      else if (cmd) cur.entry.command = cmd[1];
      else if (se) { mode = 'stderr'; stderrBuf = []; }
      continue;
    }
    if (mode === 'stderr') {
      // 缩进 2 空格的 code fence:```/```(带缩进)或内容行
      if (/^\s{2}```\s*$/.test(line)) continue; // fence 开/闭都吞
      if (/^\s{2}/.test(line)) stderrBuf.push(line.replace(/^\s{2}/, ''));
      else if (line.trim() === '') stderrBuf.push('');
      else {
        // stderr 段外的下一行,回到 meta(处理紧接的 next entry / next key)
        // 若是新 entry header,交给下一轮识别
        const h2 = line.match(ENTRY_HEADER_RE);
        if (h2) {
          flush();
          cur = { entry: { taskId: h2[1], attempt: parseInt(h2[2], 10), at: null, reason: null, command: null } };
          mode = 'meta';
        } else {
          mode = 'meta';
        }
      }
    }
  }
  flush();
  return out;
}

function pushEntry(out, entry) {
  if (!entry || entry.at == null || entry.reason == null) {
    // 结构损坏 → 跳过 + warn(不抛)
    if (entry?.taskId) {
      process.stderr.write(`[self-heal warn] skip malformed entry: task=${entry.taskId} attempt=${entry.attempt}\n`);
    }
    return;
  }
  if (!out[entry.taskId]) out[entry.taskId] = [];
  out[entry.taskId].push(entry);
}
