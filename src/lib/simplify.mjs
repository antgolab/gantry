/** Diff-scoped cleanup policy. Findings remain proposals for an executor. */
import { checkTaskScope } from './task-evidence.mjs';
import { execFileSync } from 'node:child_process';

export const SIMPLIFY_ANGLES = Object.freeze(['reuse', 'simplification', 'efficiency', 'altitude']);
const codeFile = path => /\.(?:[cm]?[jt]sx?|go|py|java|rs|rb|php|c|h|cpp|cs|swift|kt|vue|svelte)$/.test(path);
const logic = text => /\b(?:function|class|if|for|while|switch|try|catch|def|func|match)\b|=>/.test(text);

export function planSimplification(diff = '') {
  const files = []; let path = null; let added = [];
  const flush = () => {
    const meaningful = added.filter(line => line.trim() && !/^\s*(?:\/\/|#|\/\*|\*|import\b|from\b)/.test(line));
    if (path && codeFile(path) && ((meaningful.length >= 3 && logic(meaningful.join('\n'))) || meaningful.length >= 12)) files.push(path);
  };
  for (const line of String(diff).split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) { flush(); path = null; added = []; }
    else if (line.startsWith('+++ b/')) path = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
  }
  flush();
  return { trigger: files.length > 0, files: [...new Set(files)], angles: files.length ? [...SIMPLIFY_ANGLES] : [], reason: files.length ? 'new multiline logic in target diff' : 'no substantial new logic; skip extra cleanup' };
}

export function checkSimplificationScope(findings, writeFiles, changedFiles) {
  if (!Array.isArray(findings) || !Array.isArray(writeFiles) || !Array.isArray(changedFiles)) return { allowed: false, action: 'skip', outOfScope: [], reason: 'invalid cleanup input' };
  const malformed = findings.some(finding => !finding || typeof finding.file !== 'string' || !Number.isInteger(finding.line) || finding.line < 1 || finding.behaviorChanging === true);
  if (malformed) return { allowed: false, action: 'skip', outOfScope: [], reason: 'behavior-changing or malformed finding' };
  const unique = [...new Set(findings.map(finding => finding.file))];
  try {
    const before = { entries: [] };
    const after = { entries: unique.map(path => ({ path, worktreeHash: 'candidate', mode: '100644' })) };
    const checked = checkTaskScope(before, after, writeFiles);
    const outOfScope = [...new Set([...checked.outOfScope, ...unique.filter(path => !changedFiles.includes(path))])];
    return { allowed: outOfScope.length === 0, action: outOfScope.length ? 'PATCH' : 'executor', outOfScope,
      reason: outOfScope.length ? 'cleanup exceeds target diff or task boundary' : 'behavior-preserving proposal inside target diff' };
  } catch { return { allowed: false, action: 'skip', outOfScope: unique, reason: 'unsafe cleanup path' }; }
}

/** DEV commits precede REVIEW; include that commit when the worktree is clean. */
export function readReviewDiff(root) {
  const git = args => execFileSync('git', args, {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024});
  const working = git(['diff','HEAD','--']);
  if (working.trim()) return working;
  try { return git(['diff','HEAD^','HEAD','--']); }
  catch { return git(['show','--format=','--root','HEAD','--']); }
}
