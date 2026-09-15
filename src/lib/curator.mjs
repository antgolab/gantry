/**
 * curator.mjs — Curator subagent 候选 learning 生成 (T15 friction 汇总)
 *
 * proposeLearning(changeId, events, opts) → { id, tags, source, body }
 *   - 纯逻辑,无文件 IO;产物交给 store.write('team', doc) 落盘。
 *   - body 含 场景(events 摘要,脱敏) / 根因 / 解法 / 关键词。
 *   - 根因/解法默认 TODO,opts.promptStub.rootCause / .solution 可注入固定内容(测试用)。
 *   - 脱敏:meta 的 key 含 token|key|secret|password|bearer|authorization|jwt|pem|credential|apikey,
 *     或 value 匹配 /[A-Za-z0-9_\-.=+/]{20,}/ (长 token 状字符串) → 替换为 '***'。
 */

const SENSITIVE_KEY = /token|key|secret|password|bearer|authorization|jwt|pem|credential|apikey/i;
const SENSITIVE_VALUE = /[A-Za-z0-9_\-.=\/+]{20,}/;

/**
 * 生成一条 friction learning 候选。
 * @param {string} changeId
 * @param {{kind: string, ts?: string, meta?: object}[]} events
 * @param {{promptStub?: {rootCause?: string, solution?: string}, baseDir?: string}} [opts]
 * @returns {{id: string, tags: string[], source: string, body: string}}
 */
export function proposeLearning(changeId, events = [], opts = {}) {
  const stub = opts.promptStub && typeof opts.promptStub === 'object' ? opts.promptStub : {};
  const rootCause = stub.rootCause ?? 'TODO';
  const solution = stub.solution ?? 'TODO';

  const scenario = summarizeEvents(events);
  const keywords = uniqueKinds(events);

  const body = [
    '## 场景',
    ...scenario,
    '',
    '## 根因',
    '',
    String(rootCause),
    '',
    '## 解法',
    '',
    String(solution),
    '',
    '## 关键词',
    '',
    keywords.length ? keywords.join(', ') : '(无)',
    '',
  ].join('\n');

  return {
    id: `friction-${changeId}`,
    tags: ['lesson', 'friction'],
    source: changeId,
    body,
  };
}

// --- 内部 ---

function summarizeEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return ['- (无事件)'];
  return events.map((e) => {
    const kind = e && typeof e.kind === 'string' ? e.kind : '(unknown)';
    const meta = summarizeMeta(e && e.meta);
    return `- ${kind}${meta ? ` — ${meta}` : ''}`;
  });
}

function summarizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return '';
  return Object.entries(meta).map(([k, v]) => `${k}=${redact(v, k)}`).join(', ');
}

function redact(value, key) {
  if (SENSITIVE_KEY.test(String(key))) return '***';
  if (typeof value === 'string') {
    return SENSITIVE_VALUE.test(value) ? '***' : value;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => redact(v, key)).join(', ')}]`;
  }
  if (value && typeof value === 'object') {
    const inner = Object.entries(value).map(([k, v]) => `${k}=${redact(v, k)}`);
    return `{${inner.join(', ')}}`;
  }
  return String(value);
}

function uniqueKinds(events) {
  const seen = new Set();
  for (const e of events || []) {
    if (e && typeof e.kind === 'string') seen.add(e.kind);
  }
  return [...seen];
}
