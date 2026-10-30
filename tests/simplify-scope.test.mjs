import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSimplification, checkSimplificationScope } from '../src/lib/simplify.mjs';
const diff = (path, lines) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`;
test('one-line edits and documentation skip the extra cleanup pass', () => {
  assert.equal(planSimplification(diff('src/version.mjs', ["export const version = '2';"])).trigger, false);
  assert.equal(planSimplification(diff('README.md', ['Lots of text', 'with more text', 'function example()', 'if example'])).trigger, false);
});
test('new multiline logic triggers four quality angles scoped to the diff', () => {
  const result = planSimplification(diff('src/cart.mjs', ['export function total(items) {', '  if (!items.length) return 0;', '  return items.reduce((sum, item) => sum + item.price, 0);', '}']));
  assert.equal(result.trigger, true);
  assert.deepEqual(result.files, ['src/cart.mjs']);
  assert.deepEqual(result.angles, ['reuse', 'simplification', 'efficiency', 'altitude']);
});
test('old deleted logic alone does not manufacture a new cleanup target', () => {
  const result = planSimplification('diff --git a/src/old.mjs b/src/old.mjs\n--- a/src/old.mjs\n+++ b/src/old.mjs\n@@ -1,3 +1 @@\n-function old() {\n- if (old) return true;\n-}\n+export const value = 1;\n');
  assert.equal(result.trigger, false);
});
test('cleanup outside target diff or task write scope routes to PATCH', () => {
  const within = checkSimplificationScope([{ file: 'src/cart.mjs', line: 3 }], ['src/**'], ['src/cart.mjs']);
  assert.equal(within.allowed, true);
  const out = checkSimplificationScope([{ file: 'src/shared.mjs', line: 1 }], ['src/cart.mjs'], ['src/cart.mjs']);
  assert.equal(out.allowed, false); assert.equal(out.action, 'PATCH');
  assert.deepEqual(out.outOfScope, ['src/shared.mjs']);
});
test('behavior-changing or malformed cleanup is skipped instead of silently applied', () => {
  for (const finding of [{ file: 'src/cart.mjs', line: 1, behaviorChanging: true }, { file: '../outside', line: 1 }, { file: 'src/cart.mjs', line: -1 }]) {
    assert.equal(checkSimplificationScope([finding], ['src/**'], ['src/cart.mjs']).allowed, false);
  }
});

test('clean worktree reviews the committed DEV logic instead of an empty diff', async t => {
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
  const {readReviewDiff}=await import('../src/lib/simplify.mjs');
  const root=mkdtempSync(join(tmpdir(),'gantry-clean-review-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
  git('init','-q');git('config','user.email','test@example.test');git('config','user.name','Test');
  writeFileSync(join(root,'app.mjs'),'export const value=0;\n');git('add','.');git('commit','-qm','baseline');
  writeFileSync(join(root,'app.mjs'),'export function compute(x) {\n  if (x) return 1;\n  return 0;\n}\n');git('add','.');git('commit','-qm','DEV');
  const result=planSimplification(readReviewDiff(root));assert.equal(result.trigger,true);assert.deepEqual(result.files,['app.mjs']);
});

test('context CLI routes an out-of-task cleanup to PATCH without modifying files', async t => {
  const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const {execFileSync,spawnSync}=await import('node:child_process');
  const {readState,writeState}=await import('../src/lib/state.mjs');
  const root=mkdtempSync(join(tmpdir(),'gantry-cleanup-cli-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
  mkdirSync(join(root,'.gantry/specs/demo'),{recursive:true});
  writeState(root,{...readState(root),activeChange:'demo',currentStage:'review'});
  writeFileSync(join(root,'.gantry/specs/demo/TASKS.md'),'<task id="T01" status="pending"><write_files>app.mjs</write_files></task>');
  writeFileSync(join(root,'app.mjs'),'export const value=0;\n');
  writeFileSync(join(root,'other.mjs'),'export const other=0;\n');
  git('init','-q');git('config','user.email','test@example.test');git('config','user.name','Test');git('add','.');git('commit','-qm','baseline');
  writeFileSync(join(root,'other.mjs'),'export const other=1;\n');
  const findings=join(root,'.gantry/specs/demo/findings.json');writeFileSync(findings,JSON.stringify([{file:'other.mjs',line:1}]));
  const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
  const run=spawnSync(process.execPath,[cli,'context','--task','T01','--simplify-findings',findings],{cwd:root,encoding:'utf8',timeout:15000});
  assert.equal(run.status,2,run.stderr);assert.equal(JSON.parse(run.stdout).action,'PATCH');
  assert.equal(readFileSync(join(root,'other.mjs'),'utf8'),'export const other=1;\n');
});
