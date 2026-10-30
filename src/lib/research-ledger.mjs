/** Optional planning coverage ledger. Facts stay in their cited source documents. */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const RESEARCH_SURFACES = Object.freeze([
  'contracts', 'lifecycle', 'failure/retry', 'permission/ownership',
  'source-of-truth', 'experience', 'external-version',
]);
const STATUSES = new Set(['resolved-by-evidence', 'open-needs-user', 'n/a-derived', 'resolved-by-user', 'default-accepted']);
const clean = value => String(value ?? '').trim().replace(/^`|`$/g, '');
const meaningful = value => Boolean(value && !/^(?:[-—]|none|无|待填|TODO|<.*>)$/i.test(value));

function tableCells(line) {
  // Escaped pipe characters belong to the cell, not its separator.
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => clean(cell.replace(/\\\|/g, '|')));
}

/** Pure parser: enabling marker remains detectable even if the section is deleted. */
export function parseResearchLedger(text, source = 'PROPOSAL.md') {
  const enabled = /^\s*<!--\s*gantry:research-ledger\s*-->\s*$|^\s*(?:-\s*)?researchLedger:\s*true\s*$|^##\s+Research Coverage\s*$/m.test(text);
  if (!enabled) return { enabled: false, rows: [], errors: [] };
  const section = /^##\s+Research Coverage\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(text);
  if (!section) return { enabled: true, rows: [], errors: [`${source}: Research Coverage 段缺失，不能删除台账绕过未决事项`] };
  const lines = section[1].split(/\r?\n/).filter(line => /^\s*\|/.test(line));
  const header = lines.findIndex(line => tableCells(line)[0] === 'surface');
  const columns = header < 0 ? [] : tableCells(lines[header]);
  const errors = [];
  for (const key of ['surface', 'status', 'evidence', 'openDecision']) {
    if (!columns.includes(key)) errors.push(`${source}: 台账缺少 ${key} 列`);
  }
  const rows = [];
  for (const line of lines.slice(header + 1)) {
    const cells = tableCells(line);
    if (cells.every(cell => /^:?-+:?$/.test(cell))) continue;
    const row = Object.fromEntries(columns.map((key, index) => [key, cells[index] ?? '']));
    row.source = source;
    if (!RESEARCH_SURFACES.includes(row.surface)) { errors.push(`${source}: 未知 surface ${row.surface ?? ''}`); continue; }
    if (rows.some(prior => prior.surface === row.surface)) errors.push(`${source}: 重复 surface ${row.surface}`);
    if (!STATUSES.has(row.status)) errors.push(`${source}: ${row.surface} 状态非法`);
    if (row.status === 'open-needs-user') {
      if (!meaningful(row.openDecision)) errors.push(`${source}: ${row.surface} 缺少待决问题`);
    } else {
      if (!meaningful(row.evidence)) errors.push(`${source}: ${row.surface} 缺少证据或不适用理由`);
      if (meaningful(row.openDecision)) errors.push(`${source}: ${row.surface} 已解决但仍有未决问题`);
      if (row.status === 'resolved-by-user' && !/^user:\s*\S/i.test(row.evidence)) errors.push(`${source}: ${row.surface} 缺少 user: 决策来源`);
      if (row.status === 'default-accepted' && !/^decision:\s*\S/i.test(row.evidence)) errors.push(`${source}: ${row.surface} 缺少 decision: 接受依据`);
      if (row.surface === 'external-version' && row.status === 'resolved-by-evidence') {
        if (!/https?:\/\/\S+/.test(row.evidence) || !/\bversion:\s*[^;\s]+/i.test(row.evidence) || !/\bdeprecated:\s*(?:no\b|yes\b|\d{4}-\d{2}-\d{2}\b)/i.test(row.evidence)) {
          errors.push(`${source}: external-version 必须带官方 URL、version: 和 deprecated:`);
        }
      }
    }
    rows.push(row);
  }
  for (const surface of RESEARCH_SURFACES) if (!rows.some(row => row.surface === surface)) errors.push(`${source}: 缺少 surface ${surface}，不能通过删行关闭问题`);
  return { enabled: true, rows, errors };
}

function rootFrom(specsDir) {
  const marker = `${join('.gantry', 'specs')}/`;
  const normalized = resolve(specsDir).replaceAll('\\', '/');
  const at = normalized.lastIndexOf(`/${marker}`);
  return at >= 0 ? normalized.slice(0, at) : resolve(specsDir, '../../..');
}
function localEvidenceExists(root, evidence) {
  const refs = [...evidence.matchAll(/`([^`]+)`/g)].map(match => match[1]);
  const candidates = refs.length ? refs : evidence.split(/\s*;\s*/);
  return candidates.some(raw => {
    const path = raw.replace(/^@/, '').replace(/:\d+(?::\d+)?$/, '').replace(/#.*$/, '');
    if (!path || isAbsolute(path) || /[<>]/.test(path)) return false;
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (rel === '..' || rel.startsWith('../')) return false;
    if (!existsSync(full)) return false;
    const real = relative(realpathSync(root), realpathSync(full));
    return real !== '..' && !real.startsWith('../') && !isAbsolute(real);
  });
}

/** Latest complete DESIGN ledger supersedes PROPOSAL facts; malformed earlier ledgers never vanish. */
export function checkResearchLedger(specsDir) {
  const ledgers = [];
  for (const file of ['PROPOSAL.md', 'DESIGN.md']) {
    const path = join(specsDir, file);
    if (existsSync(path)) ledgers.push(parseResearchLedger(readFileSync(path, 'utf8'), file));
  }
  const active = ledgers.filter(ledger => ledger.enabled);
  if (!active.length) return { passed: true, enabled: false, rows: [], errors: [] };
  const rows = active.at(-1).rows;
  const errors = active.flatMap(ledger => ledger.errors);
  const root = rootFrom(specsDir);
  for (const row of rows) {
    if (row.status === 'open-needs-user') errors.push(`${row.source}: ${row.surface} 待用户决策: ${row.openDecision}`);
    if (row.status === 'resolved-by-evidence' && !/https?:\/\/\S+/.test(row.evidence) && !localEvidenceExists(root, row.evidence)) errors.push(`${row.source}: ${row.surface} 证据路径不存在或越出仓库`);
  }
  return { passed: errors.length === 0, enabled: true, rows, errors, ...(errors.length ? { reason: `research-ledger: ${errors.join('; ')}` } : {}) };
}

/** Scope is comma/semicolon separated task ids or literal path prefixes. Empty/* is global. */
export function selectResearchRows(specsDir, { taskId = null, files = [] } = {}) {
  return checkResearchLedger(specsDir).rows.filter(row => {
    const scopes = String(row.scope ?? '').split(/[,;]/).map(clean).filter(Boolean);
    if (!scopes.length || scopes.includes('*')) return true;
    return scopes.some(scope => scope === taskId || files.some(file => file === scope || file.startsWith(scope.endsWith('/') ? scope : `${scope}/`)));
  });
}

/** Add these focused artifact entries to loadOrder; no new context-pack schema fields. */
export function researchContextEntries(specsDir, options = {}) {
  const root = rootFrom(specsDir);
  const grouped = new Map();
  for (const row of selectResearchRows(specsDir, options)) {
    const path = relative(root, join(specsDir, row.source)).replaceAll('\\', '/');
    if (!grouped.has(path)) grouped.set(path, []);
    grouped.get(path).push(`| ${row.surface} |`);
  }
  return [...grouped].map(([path, focus]) => ({ path, kind: 'artifact', required: true, focus }));
}
