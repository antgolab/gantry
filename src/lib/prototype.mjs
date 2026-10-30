/** Optional throwaway exploration. It is never a stage or shipping receipt. */
import { existsSync, readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { parseTasks } from './tasks.mjs';

const FIELDS = ['Question', 'Artifact', 'Run', 'Verdict', 'Decision'];
const unresolved = value => !value || /<[^>]+>|\b(?:TODO|TBD)\b/.test(value);
function pathExists(path) { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
const safePath = value => typeof value === 'string' && value.trim() === value && value.length > 0
  && !isAbsolute(value) && !value.includes('\\') && !value.includes('\0')
  && !/[*?\[\]]/.test(value) && !value.split('/').some(part => ['', '.', '..', '.git'].includes(part));
function contained(root, target) {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith('../');
}
function validateArtifact(root, path) {
  if (!safePath(path)) return false;
  let probe = resolve(root, path);
  while (!pathExists(probe) && probe !== resolve(root)) probe = resolve(probe, '..');
  return contained(realpathSync(root), realpathSync(probe));
}
function fields(text) {
  const result = {};
  const expression = /^##\s+(Question|Artifact|Run|Verdict|Decision|Task)\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm;
  for (const match of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(expression)) {
    if (Object.hasOwn(result, match[1])) throw new Error(`duplicate ${match[1]}`);
    result[match[1]] = match[2].trim();
  }
  return result;
}
export function readPrototypeNotes(specsDir) {
  const files = [];
  if (existsSync(join(specsDir, 'PROTOTYPE.md'))) files.push(join(specsDir, 'PROTOTYPE.md'));
  const dir = join(specsDir, 'prototypes');
  if (existsSync(dir)) {
    if (lstatSync(dir).isSymbolicLink()) throw new Error('prototype note directory may not be a symlink');
    for (const name of readdirSync(dir).sort()) if (name.endsWith('.md')) files.push(join(dir, name));
  }
  return files.map(path => {
    if (lstatSync(path).isSymbolicLink()) throw new Error('prototype note may not be a symlink');
    return { path, ...fields(readFileSync(path, 'utf8')) };
  });
}
export function checkPrototypeGate(specsDir, projectRoot, { validateTask } = {}) {
  try {
    const notes = readPrototypeNotes(specsDir);
    if (!notes.length) return { passed: true, skipped: true };
    const tasks = parseTasks(join(specsDir, 'TASKS.md'));
    for (const note of notes) {
      for (const field of FIELDS) if (unresolved(note[field])) return { passed: false, reason: `prototype: ${note.path} missing/unresolved ${field}` };
      const artifacts = note.Artifact.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
      if (!artifacts.length || artifacts.some(path => !validateArtifact(projectRoot, path))) return { passed: false, reason: 'prototype: unsafe Artifact path' };
      if (note.Decision === 'Continue') return { passed: false, reason: 'prototype: Continue exploration must be resolved before delivery' };
      if (!['Delete', 'Absorb'].includes(note.Decision)) return { passed: false, reason: 'prototype: Decision must be Delete, Absorb, or Continue' };
      if (artifacts.some(path => pathExists(resolve(projectRoot, path)))) return { passed: false, reason: 'prototype: throwaway Artifact still exists; delete the shell before delivery' };
      if (note.Decision === 'Absorb') {
        const task = tasks.find(task => task.id === note.Task);
        if (!task || task.status !== 'done' || !task.verify?.trim() || !task.done?.trim() || !task.writeFiles.length) return { passed: false, reason: 'prototype: Absorb requires a completed formal Task with verify, done, and production write_files' };
        if (typeof validateTask !== 'function' || validateTask(task) !== true) return { passed: false, reason: 'prototype: Absorb requires current formal task verification receipt' };
        if (task.writeFiles.some(path => artifacts.includes(path) || /(?:^|[./_-])prototype(?:[./_-]|$)/i.test(path))
          || artifacts.some(path => task.verify.includes(path))) return { passed: false, reason: 'prototype: formal verification cannot use the throwaway artifact as delivery evidence' };
      }
    }
    return { passed: true, skipped: false, notes: notes.map(note => ({ path: note.path, decision: note.Decision, taskId: note.Task ?? null })) };
  } catch (error) { return { passed: false, reason: `prototype: ${error.message}` }; }
}
