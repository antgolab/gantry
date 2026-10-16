// 手写 YAML frontmatter 最小子集解析器（<50 行，不引入 yaml/gray-matter 依赖）。
// 仅支持 learnings schema 的 7 字段：id/tags/source/createdAt/hitCount/lastHitAt/scope。
const DELIM = '---';
const PLAIN = /^[A-Za-z0-9_\-./:+]+$/;
const NUM = /^-?\d+(\.\d+)?$/;
const RESERVED = new Set(['null', 'true', 'false']);

const scalar = (raw) => {
  if (raw === 'null') return null;
  if (NUM.test(raw)) return Number(raw);
  if (raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')) return JSON.parse(raw);
  return raw;
};

const parseValue = (raw) => {
  raw = raw.trim();
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((s) => scalar(s.trim()));
  }
  return scalar(raw);
};

const ser = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? '[' + v.map(ser).join(', ') + ']' : '[]';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string')
    return PLAIN.test(v) && !NUM.test(v) && !RESERVED.has(v) ? v : JSON.stringify(v);
  return String(v);
};

export function parse(mdContent) {
  const content = String(mdContent ?? '');
  const lines = content.split('\n');
  if (lines[0].trim() !== DELIM) return { frontmatter: {}, body: content };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === DELIM) { end = i; break; }
  if (end === -1) return { frontmatter: {}, body: content };
  const frontmatter = {};
  for (const line of lines.slice(1, end)) {
    const idx = line.indexOf(':');
    if (idx !== -1) frontmatter[line.slice(0, idx).trim()] = parseValue(line.slice(idx + 1));
  }
  return { frontmatter, body: lines.slice(end + 1).join('\n') };
}

export function stringify({ frontmatter = {}, body = '' } = {}) {
  const keys = Object.keys(frontmatter);
  if (!keys.length) return body;
  const lines = keys.map((k) => `${k}: ${ser(frontmatter[k])}`);
  return `${DELIM}\n${lines.join('\n')}\n${DELIM}\n${body}`;
}
