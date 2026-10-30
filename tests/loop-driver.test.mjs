/** Real shell compatibility entry + real CLI; only model invocation is a fake. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeState,readState } from '../src/lib/state.mjs';
const LOOP=join(dirname(fileURLToPath(import.meta.url)),'../src/loop/loop.sh');
function project(script,config={}){
 const root=mkdtempSync(join(tmpdir(),'ralph-driver-'));
 mkdirSync(join(root,'.gantry/specs/demo'),{recursive:true});
 mkdirSync(join(root,'.gantry/core/phases'),{recursive:true});
 writeFileSync(join(root,'.gantry/core/phases/2-design.md'),'design');
 writeState(root,{pipeline:'full',activeChange:'demo',currentStage:'design',maxStages:40,maxRetries:3});
 writeFileSync(join(root,'.gantry/planning/config.json'),JSON.stringify(config));
 const adapter=join(root,'client.sh');writeFileSync(adapter,'#!/usr/bin/env bash\nset -eu\n'+script);
 return {root,run:(flags=[],env={})=>spawnSync('bash',[LOOP,'codex',...flags],{cwd:root,encoding:'utf8',timeout:10000,env:{...process.env,GANTRY_LOOP_DISPATCHER:adapter,...env}}),clean:()=>rmSync(root,{recursive:true,force:true})};
}
test('compatibility shell validates usage and accepts verbose alias',()=>{
 for(const args of [[],['bogus'],['codex','--nope']]){
  const r=spawnSync('bash',[LOOP,...args],{encoding:'utf8',timeout:5000});assert.equal(r.status,64,r.stderr);
 }
 const r=spawnSync('bash',[LOOP,'--help'],{encoding:'utf8',timeout:5000});assert.equal(r.status,0);assert.match(r.stdout,/用法/);
});
test('real driver streams candidate, writes metric, stops at concrete design gate',()=>{
 const f=project('echo "candidate stream"\necho reviewed > .gantry/specs/demo/DESIGN.md\n');
 try{
  const r=f.run(['--verbose']);assert.equal(r.status,2,r.stderr);
  assert.match(r.stdout,/candidate stream/);assert.match(r.stdout,/token=gantry-design/);
  assert.equal(readState(f.root).currentStage,'design');
  const metric=JSON.parse(readFileSync(join(f.root,'.gantry/loop/metrics.jsonl'),'utf8').trim());
  assert.equal(metric.stage,'design');assert.equal(metric.attempt,1);
  assert.equal(existsSync(join(f.root,'.gantry/planning/ralph.lock')),false);
 }finally{f.clean();}
});
test('quiet keeps stream in log, unknown nonzero is blocked without dispatch retry',()=>{
 const f=project('echo candidate stream\necho call >> calls\nexit 1\n');
 try{
  const r=f.run(['-q']);assert.equal(r.status,2,r.stderr);assert.doesNotMatch(r.stdout,/candidate stream/);
  assert.equal(readFileSync(join(f.root,'calls'),'utf8'),'call\n');
  assert.match(readFileSync(join(f.root,'.gantry/loop/last-dispatch.log'),'utf8'),/candidate stream/);
 }finally{f.clean();}
});
test('run deadline cleans actual child writer before returning budget exit',async()=>{
 const f=project('node -e \'setInterval(()=>require("fs").appendFileSync("writes","x"),5)\' &\nwait\n',{ralph:{runTimeoutMs:180,killGraceMs:30}});
 try{
  const r=f.run();assert.equal(r.status,3,r.stderr);
  const path=join(f.root,'writes');const snapshot=existsSync(path)?readFileSync(path,'utf8'):'';
  await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(existsSync(path)?readFileSync(path,'utf8'):'',snapshot);
  assert.equal(existsSync(join(f.root,'.gantry/planning/ralph.lock')),false);
 }finally{f.clean();}
});
test('invalid stage limit rejects before model launch',()=>{
 const f=project('echo bad > called\n');try{
  const r=f.run([],{GANTRY_LOOP_MAX_STEPS:'0'});assert.equal(r.status,64);assert.equal(existsSync(join(f.root,'called')),false);
 }finally{f.clean();}
});
