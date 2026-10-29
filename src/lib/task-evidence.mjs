/** Task acceptance/content anchors. No task completion state is stored here. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { detectTestWeakening } from './light-guard.mjs';

export const DEFAULT_RALPH_DEADLINES = Object.freeze({ executorTimeoutMs: 900000, verifyTimeoutMs: 600000, runTimeoutMs: 7200000, killGraceMs: 5000 });

const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => hash(JSON.stringify(canonical(value)));
const lines = value => Array.isArray(value) ? value.map(String) : String(value ?? '').split('\n').map(s => s.trim()).filter(Boolean);

export function createContract(task, config = {}) {
  const contract = {
    verify: task.verify ?? '', readFiles: lines(task.readFiles ?? task.read_files),
    writeFiles: lines(task.writeFiles ?? task.write_files), done: task.done ?? '',
    checks: lines(task.checks ?? config.checks), preflight: lines(task.preflight ?? config.preflight),
    deadlineSnapshot: config.deadlineSnapshot ?? task.deadlineSnapshot ?? config.deadline ?? {},
  };
  return { ...contract, digest: digest(contract) };
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function validPath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\0') && !path.split('/').some(p => p === '..' || p === '.git');
}
function runtimePath(path) {
  if (path === '.gantry/planning/config.json' || path === '.gantry/loop/test-commands.yml') return false;
  return /(^|\/)(?:node_modules|\.git)(?:\/|$)/.test(path)
    || /^\.gantry\/(?:planning|logs|metrics|execution|loop)(?:\/|$)/.test(path)
    || /^\.gantry\/specs\/[^/]+\/execution(?:\/|$)/.test(path)
    || /^\.gantry\/specs\/.*\/(?:EXECUTION\.md|.*-PROGRESS\.md|execution(?:\..*)?\.json|.*\.log)$/.test(path)
    || path === 'STATE.md';
}
function acceptanceContent(path, content) {
  if (!/^\.gantry\/specs\/[^/]+\/TASKS?\.md$/.test(path)) return content;
  return String(content).replace(/(<task\b[^>]*?\bstatus\s*=\s*)(["'])[^"']*\2/g, '$1"pending"');
}
function contained(root, target) {
  const path = relative(root, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
}
function inspectPath(root, path) {
  const full = resolve(root, path);
  let stat;
  try { stat = lstatSync(full); } catch (error) { if (error.code === 'ENOENT') return { worktreeHash: null, mode: null, content: null }; throw error; }
  // A normal file can pass through an external symlink in a parent directory.
  if (!contained(root, realpathSync(resolve(full, '..')))) throw new Error(`external symlink boundary: ${path}`);
  if (stat.isSymbolicLink()) {
    if (!contained(root, realpathSync(full))) throw new Error(`external symlink boundary: ${path}`);
    const content = readlinkSync(full);
    return { worktreeHash: hash(content), mode: '120000', permissions: stat.mode & 0o777, content };
  }
  if (!stat.isFile()) throw new Error(`unobservable file/submodule boundary: ${path}`);
  const bytes = readFileSync(full);
  return { worktreeHash: hash(acceptanceContent(path, bytes)), mode: `100${(stat.mode & 0o111) ? '755' : '644'}`, permissions: stat.mode & 0o777, content: bytes.toString('utf8') };
}

/** Complete tracked + nonignored untracked snapshot, including the index and deletions.
 * includePaths is for otherwise ignored Gantry acceptance/config files. Explicitly
 * requested ignored source is refused: callers must make that source observable.
 */
export function captureManifest(root, { includePaths = [] } = {}) {
  root = realpathSync(root);
  if (realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== root) throw new Error('manifest root must be the Git root');
  const index = new Map();
  for (const record of git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(record);
    if (!match || match[3] !== '0') throw new Error('unmerged or invalid Git index');
    if (match[1] === '160000') throw new Error(`unobservable submodule boundary: ${match[4]}`);
    index.set(match[4], { indexHash: match[2], indexMode: match[1] });
  }
  const paths = new Set([...index.keys(), ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)]);
  function include(path) {
    if (!validPath(path) || runtimePath(path) || /[*?\[]/.test(path)) throw new Error(`invalid acceptance include path: ${path}`);
    const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: root, input: `${path}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return ignored;
  }
  for (const path of includePaths) {
    let ignored = false;
    try { ignored = Boolean(include(path)); } catch (error) { if (error.status !== 1) throw error; }
    if (ignored && !path.startsWith('.gantry/')) throw new Error(`ignored source boundary: ${path}`);
    // Includes may be directories, but never follow symlink directories.
    const add = candidate => {
      if (runtimePath(candidate)) return;
      if (!validPath(candidate)) throw new Error(`unsafe manifest path: ${candidate}`);
      const stat = lstatSync(resolve(root, candidate));
      if (stat.isDirectory()) for (const name of readdirSync(resolve(root, candidate))) add(`${candidate}/${name}`);
      else paths.add(candidate);
    };
    try { add(path); } catch (error) { if (error.code !== 'ENOENT') throw error; paths.add(path); }
  }
  const entries = [...paths].filter(path => !runtimePath(path)).sort().map(path => {
    if (!validPath(path)) throw new Error(`unsafe manifest path: ${path}`);
    const staged = index.get(path) ?? { indexHash: null, indexMode: null };
    const indexContent = staged.indexHash ? execFileSync('git', ['cat-file', 'blob', staged.indexHash], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString('utf8') : null;
    const indexHash = staged.indexHash && /^\.gantry\/specs\/[^/]+\/TASKS?\.md$/.test(path)
      ? hash(acceptanceContent(path, indexContent)) : staged.indexHash;
    return { path, ...inspectPath(root, path), ...staged, indexHash, indexContent };
  });
  const manifest = { entries };
  return { ...manifest, manifestDigest: computeContentDigest(manifest) };
}

function entriesOf(manifest) {
  if (!manifest || !Array.isArray(manifest.entries)) throw new TypeError('manifest.entries required');
  const seen = new Set();
  for (const entry of manifest.entries) {
    if (!validPath(entry.path) || seen.has(entry.path)) throw new Error('invalid/duplicate manifest entry');
    seen.add(entry.path);
  }
  return manifest.entries;
}
function identity(entry) {
  return entry ? { path: entry.path, worktreeHash: entry.worktreeHash ?? null, indexHash: entry.indexHash ?? null, mode: entry.mode ?? null, permissions: entry.permissions ?? null, indexMode: entry.indexMode ?? null } : null;
}
export function computeContentDigest(manifest) {
  return digest(entriesOf(manifest).map(identity).sort((a, b) => a.path.localeCompare(b.path)));
}
function changes(baseline, current) {
  const before = new Map(entriesOf(baseline).map(e => [e.path, e]));
  const after = new Map(entriesOf(current).map(e => [e.path, e]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().filter(path => digest(identity(before.get(path))) !== digest(identity(after.get(path)))).map(path => ({ path, before: before.get(path), after: after.get(path) }));
}
function scopeRegex(pattern) {
  if (!validPath(pattern)) return null;
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { expression += '(?:.*/)?'; i += 2; }
      else { expression += '.*'; i++; }
    } else if (pattern[i] === '*') expression += '[^/]*';
    else expression += pattern[i].replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`^${expression}${pattern.endsWith('/') ? '.*' : ''}$`);
}

/** Refuse project inputs that Git cannot anchor, without opening their contents.
 * Knowledge/control documents and installed dependencies are read-only context,
 * not project source. Git exclusions keep broad read globs from walking them.
 */
export function assertTaskPathsObservable(root, task) {
  const contextRead = path => /^(?:\.gantry|\.context)(?:\/|$)/.test(path)
    || /(^|\/)node_modules(?:\/|$)/.test(path);
  function ignored(path) {
    try {
      return Boolean(execFileSync('git', ['check-ignore', '-z', '--stdin'], {
        cwd: root, input: `${path}\0`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }));
    } catch (error) { if (error.status === 1) return false; throw error; }
  }
  function refuse(path) {
    throw new Error(`ignored source boundary: ${path}; track the task source or remove its ignore rule before running the task`);
  }
  for (const [patterns, readOnly] of [[lines(task.readFiles ?? task.read_files), true], [lines(task.writeFiles ?? task.write_files), false]]) {
    for (const pattern of patterns) {
      const matcher = scopeRegex(pattern);
      if (!matcher) throw new Error(`unsafe task source path: ${pattern}`);
      if (readOnly && contextRead(pattern)) continue;
      const wildcard = pattern.indexOf('*');
      const prefix = wildcard < 0 ? pattern : pattern.slice(0, pattern.lastIndexOf('/', wildcard) + 1) || '.';
      const tracked = () => git(root, ['ls-files', '-z', '--', prefix]).split('\0').filter(Boolean)
        .some(path => matcher.test(path) || (wildcard < 0 && path.startsWith(`${pattern.replace(/\/$/, '')}/`)));
      if (wildcard < 0) {
        if (ignored(pattern) && !tracked()) refuse(pattern);
      } else {
        // Checking the literal directory also covers ignored output roots that
        // do not exist yet. Normal check-ignore semantics preserve tracked files.
        if (prefix !== '.' && ignored(prefix) && !tracked()) refuse(prefix);
      }
      const exclusions = readOnly ? [':(exclude).gantry', ':(exclude).context', ':(exclude,glob)**/node_modules/**'] : [];
      const names = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', prefix, ...exclusions]);
      for (const path of names.split('\0').filter(Boolean)) {
        if (readOnly && contextRead(path)) continue;
        if (matcher.test(path) || (wildcard < 0 && path.startsWith(`${pattern.replace(/\/$/, '')}/`))) refuse(path);
      }
    }
  }
}
export function checkTaskScope(baseline, current, writeFiles) {
  const changedFiles = changes(baseline, current).map(e => e.path);
  const patterns = lines(writeFiles).map(scopeRegex);
  const invalid = patterns.some(pattern => !pattern);
  const outOfScope = changedFiles.filter(path => invalid || !patterns.some(pattern => pattern.test(path)));
  return { ok: !invalid && outOfScope.length === 0, changedFiles, outOfScope };
}

const testPath = path => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/.test(path);
const configPath = path => /(?:^|\/)(?:package\.json|(?:jest|vitest|playwright|ava|nyc|tap|mocha|eslint)[^/]*|\.mocharc[^/]*|test-commands\.yml)$/.test(path);
const skips = text => (String(text ?? '').match(/\b(?:test|it|describe)\.(?:skip|todo)\b|\b(?:skip|todo)\s*:\s*(?:true|['"`])/g) ?? []).length;
export function detectTaskWeakening(baseline, current) {
  const delta = changes(baseline, current);
  const reasons = [];
  const files = new Set();
  // Examine working tree and staged content independently, so staging a weakened
  // test and restoring its worktree cannot hide it from the guard.
  for (const field of ['content', 'indexContent']) {
    const tests = delta.map(e => ({ path: e.path, before: e.before?.[field] ?? null, after: e.after?.[field] ?? null,
      status: e.after?.[field] == null ? 'D' : e.before?.[field] == null ? 'A' : 'M' }));
    const weakened = detectTestWeakening(tests.filter(e => e.before !== e.after), testPath);
    for (const path of weakened.files) { files.add(path); reasons.push({ path, kind: 'test-weakened', source: field }); }
    for (const e of tests) if (testPath(e.path) && skips(e.after) > skips(e.before)) {
      files.add(e.path); reasons.push({ path: e.path, kind: 'skip-or-todo-added', source: field });
    }
  }
  for (const e of delta) if (configPath(e.path)) { files.add(e.path); reasons.push({ path: e.path, kind: 'test-configuration-changed' }); }
  return { hit: files.size > 0, files: [...files].sort(), reasons, reviewRequired: files.size > 0 };
}

export function inspectVerificationOutput(output, { kind = 'test' } = {}) {
  const source = String(output ?? '');
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'skipped', 'todo']) {
    const matches = [...source.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm'))];
    if (matches.length) counts[key] = Number(matches.at(-1)[1]);
  }
  if (!Object.hasOwn(counts, 'tests')) {
    const incompleteTap = /^(?:TAP version|1\.\.0\b)/m.test(source);
    return { ok: !incompleteTap || kind === 'command', counts: null, reason: incompleteTap ? 'incomplete-tap' : 'unknown-test-counts' };
  }
  for (const key of ['pass', 'fail', 'skipped', 'todo']) counts[key] ??= 0;
  const reason = counts.tests === 0 ? 'zero-tests' : counts.fail > 0 ? 'tests-failed' : counts.skipped > 0 ? 'tests-skipped' : counts.todo > 0 ? 'tests-todo' : null;
  return { ok: reason === null, counts, reason };
}
export function receiptMatches(receipt, contract, manifest) {
  if (!receipt || !contract?.digest) return false;
  return receipt.contractDigest === contract.digest && receipt.contentDigest === computeContentDigest(manifest);
}

/** Read-only evidence predicate shared by dispatch/recovery and static gates. */
export function receiptIsValid(receipt, contract, manifest) {
  return Boolean(receipt?.schemaVersion === 1 && receipt.pass === true && Array.isArray(receipt.runs) && receipt.runs.length > 0
    && receipt.runs.every(run => run.exitCode === 0 && run.inspection?.ok === true
      && run.cleanupComplete === true && !run.cancelled && !run.timedOut && !run.spawnError)
    && receiptMatches(receipt, contract, manifest));
}
