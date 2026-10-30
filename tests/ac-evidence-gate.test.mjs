import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runAcVerification, checkAcEvidence, recordAcObservation } from '../src/lib/ac-evidence.mjs';
import { checkGate } from '../src/lib/phases.mjs';
function fixture(t, cmd = 'node -e "console.log(123)"') {
  const root = mkdtempSync(join(tmpdir(), 'gantry-ac-proof-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dir = join(root, '.gantry/specs/demo'); mkdirSync(dir,{recursive:true}); mkdirSync(join(root,'.gantry/loop'),{recursive:true});
  writeFileSync(join(dir,'SPEC.md'),'# SPEC\n## AC-1 roundtrip\n');
  writeFileSync(join(dir,'REVIEW.md'),'# APPROVED\n'); writeFileSync(join(root,'app.txt'),'initial');
  writeFileSync(join(root,'.gantry/loop/test-commands.yml'),`smoke:\n  cmd: '${cmd}'\n  covers: ['*']\n`);
  execFileSync('git',['init','-q'],{cwd:root}); execFileSync('git',['add','.'],{cwd:root});
  return {root,dir};
}
test('wildcard coverage cannot pass without execution evidence; gate is read-only', t=>{
  const {root,dir}=fixture(t); const r=checkGate('integration',dir,{pipeline:'full'},null,root);
  assert.equal(r.passed,false); assert.match(r.reason,/verify-ac/);
});
test('actual execution passes, code/index/untracked changes invalidate it', async t=>{
  const {root,dir}=fixture(t); assert.equal((await runAcVerification(root,dir)).passed,true);
  assert.equal(checkGate('integration',dir,{},null,root).passed,true);
  writeFileSync(join(root,'new.txt'),'untracked'); assert.equal(checkAcEvidence(root,dir).passed,false);
});
test('nonzero, missing command and zero-test run are not valid evidence',async t=>{
  for (const cmd of ['node -e "process.exit(7)"','missing-gantry-ac-command','node -e "console.log(\'# tests 0\')"']) {
    const {root,dir}=fixture(t,cmd); assert.equal((await runAcVerification(root,dir)).passed,false);
    assert.equal(checkAcEvidence(root,dir).passed,false);
  }
});
test('acceptance command changes and verification mutations cannot preserve old success',async t=>{
  const {root,dir}=fixture(t); await runAcVerification(root,dir);
  writeFileSync(join(root,'.gantry/loop/test-commands.yml'),"smoke:\n  cmd: false\n  covers: ['*']\n");
  assert.equal(checkAcEvidence(root,dir).passed,false);
  writeFileSync(join(root,'.gantry/loop/test-commands.yml'),`smoke:\n  cmd: node -e "require('fs').writeFileSync('app.txt','changed')"\n  covers: ['*']\n`);
  assert.equal((await runAcVerification(root,dir)).passed,false);
});
test('manual evidence requires observed result and unchanged local artifact',t=>{
  const {root,dir}=fixture(t); writeFileSync(join(dir,'UAT.md'),'Observed API roundtrip persisted after reload');
  assert.throws(()=>recordAcObservation(root,dir,{acId:'AC-1',kind:'manual',steps:'reload',result:'pass'}),/evidence/);
  recordAcObservation(root,dir,{acId:'AC-1',kind:'manual',steps:'reload and fetch',result:'pass',actual:'saved value returned',evidencePath:'.gantry/specs/demo/UAT.md'});
  assert.equal(checkAcEvidence(root,dir).passed,true);
  writeFileSync(join(dir,'UAT.md'),'different evidence'); assert.equal(checkAcEvidence(root,dir).passed,false);
});
test('manual failed or caveated observations cannot pass and missing source retains skip',t=>{
  const {root,dir}=fixture(t); writeFileSync(join(dir,'UAT.md'),'failed');
  recordAcObservation(root,dir,{acId:'AC-1',kind:'journey',steps:'POST and GET',actual:'500',result:'fail',evidencePath:'.gantry/specs/demo/UAT.md'});
  assert.equal(checkAcEvidence(root,dir).passed,false);
  writeFileSync(join(dir,'SPEC.md'),'# SPEC no AC'); assert.equal(checkAcEvidence(root,dir).skipped,true);
});

test('real CLI verifies, then refuses forced archive after source changes',async t=>{
  const {root,dir}=fixture(t);
  const {writeState,readState}=await import('../src/lib/state.mjs');
  writeState(root,{...readState(root),activeChange:'demo',currentStage:'integration',pipeline:'full'});
  const {runProcess}=await import('../src/lib/process-runner.mjs');const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
  const run=(...args)=>runProcess(process.execPath,[cli,...args],{cwd:root,timeoutMs:15000,killGraceMs:100});
  const verify=await run('verify-ac','--json');assert.equal(verify.exitCode,0,verify.stderr);assert.equal(JSON.parse(verify.stdout).passed,true);
  writeFileSync(join(root,'app.txt'),'changed');
  const archive=await run('archive','--force','--skip-learning');assert.notEqual(archive.exitCode,0);assert.match(archive.stderr,/ac-evidence/);
  assert.equal(readState(root).activeChange,'demo');
});

function sharedMapping(root, command) {
  writeFileSync(join(root,'.gantry/specs/demo/SPEC.md'),'# SPEC\n## AC-1 save\n## AC-2 reload\n');
  writeFileSync(join(root,'.gantry/loop/test-commands.yml'),
    `save:\n  cmd: '${command}'\n  covers: ['AC-1']\nreload:\n  cmd: '${command}'\n  covers: ['AC-2']\nall:\n  cmd: '${command}'\n  covers: ['*']\n`);
}

test('shared AC command executes once per invocation and preserves every mapping', async t=>{
  const {root,dir}=fixture(t);
  const output=mkdtempSync(join(tmpdir(),'gantry-ac-count-')); t.after(()=>rmSync(output,{recursive:true,force:true}));
  const count=join(output,'runs');
  const command=`node -e "require('fs').appendFileSync(${"'"+count+"'"},'x'); console.log(123)"`;
  sharedMapping(root,command);
  assert.equal((await runAcVerification(root,dir)).passed,true);
  assert.equal(readFileSync(count,'utf8'),'x');
  const entries=JSON.parse(readFileSync(join(dir,'execution/ac-evidence.json'),'utf8')).entries;
  assert.deepEqual(entries.map(e=>[e.commandKey,e.acId]),[['save','AC-1'],['reload','AC-2'],['all','AC-1'],['all','AC-2']]);
  assert.equal(checkAcEvidence(root,dir).passed,true);
  assert.equal((await runAcVerification(root,dir)).passed,true);
  assert.equal(readFileSync(count,'utf8'),'xx','remote checks must not be cached across invocations');
});

test('failed shared command records failure for all mapped ACs',async t=>{
  const {root,dir}=fixture(t); sharedMapping(root,'node -e "process.exit(7)"');
  assert.equal((await runAcVerification(root,dir)).passed,false);
  const entries=JSON.parse(readFileSync(join(dir,'execution/ac-evidence.json'),'utf8')).entries;
  assert.equal(entries.length,4);
  assert.ok(entries.every(e=>e.result==='fail' && e.exitCode===7));
  assert.deepEqual(checkAcEvidence(root,dir).missing,['AC-1','AC-2']);
});

test('source mutation by shared command invalidates every mapped result',async t=>{
  const {root,dir}=fixture(t);
  sharedMapping(root,`node -e "require('fs').writeFileSync('app.txt','changed'); console.log(123)"`);
  const result=await runAcVerification(root,dir);
  assert.equal(result.passed,false); assert.match(result.reason,/mutated source/);
  assert.ok(JSON.parse(readFileSync(join(dir,'execution/ac-evidence.json'),'utf8')).entries.every(e=>e.result==='fail'));
  assert.equal(checkAcEvidence(root,dir).passed,false);
});

test('different commands are executed independently even with the same coverage',async t=>{
  const {root,dir}=fixture(t);
  writeFileSync(join(root,'.gantry/loop/test-commands.yml'),`first:\n  cmd: node -e "console.log(123)"\n  covers: ['*']\nsecond:\n  cmd: node -e "process.exit(9)"\n  covers: ['*']\n`);
  assert.equal((await runAcVerification(root,dir)).passed,false);
  const entries=JSON.parse(readFileSync(join(dir,'execution/ac-evidence.json'),'utf8')).entries;
  assert.deepEqual(entries.map(e=>e.exitCode),[0,9]);
  assert.equal(checkAcEvidence(root,dir).passed,false);
});
