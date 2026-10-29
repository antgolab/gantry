import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeState, readState, writeFence, readFence, approveStage, isStageApproved, transitionStage } from '../src/lib/state.mjs';
import { runLoop, validatePack, readLoopOptions } from '../src/loop/controller.mjs';

function fixture(stage='design') {
  const root = mkdtempSync(join(tmpdir(), 'ralph-stage-'));
  mkdirSync(join(root,'.gantry/specs/demo'),{recursive:true});
  mkdirSync(join(root,'.gantry/core/phases'),{recursive:true});
  for(const file of ['2-design.md','1-requirement.md','F-fast.md']) writeFileSync(join(root,'.gantry/core/phases',file),'phase fixture');
  writeState(root,{pipeline:'full',activeChange:'demo',currentStage:stage,maxStages:40,maxRetries:3});
  const adapter = join(root,'adapter.sh');
  writeFileSync(adapter,`#!/usr/bin/env bash\nset -eu\necho invocation >> "$PROJECT_ROOT/calls"\nnode -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(".gantry/planning/context-pack.json")); if(p.stage!==process.argv[1]||p.changeId!=="demo")process.exit(64)' "$1"\necho 'draft' > "$PROJECT_ROOT/.gantry/specs/demo/DESIGN.md"\necho client-output\n`);
  return {root,env:{...process.env,GANTRY_LOOP_DISPATCHER:adapter},clean:()=>rmSync(root,{recursive:true,force:true})};
}

test('approval is bound to bytes/change and survives ordinary state updates',()=>{
 const f=fixture();try {
  writeFileSync(join(f.root,'.gantry/specs/demo/DESIGN.md'),'approved');
  assert.equal(isStageApproved(f.root,'design'),false);
  approveStage(f.root,'design');
  writeState(f.root,{...readState(f.root),currentTask:'T01'});
  assert.equal(isStageApproved(f.root,'design'),true);
  assert.ok(readFence(f.root).approvals.design.digest);
  writeFileSync(join(f.root,'.gantry/specs/demo/DESIGN.md'),'changed');
  assert.equal(isStageApproved(f.root,'design'),false);
  assert.throws(()=>approveStage(f.root,'integration'),/mismatch/);
 } finally{f.clean();}
});
test('missing primary artifact cannot be approved',()=>{
 const f=fixture();try{assert.throws(()=>approveStage(f.root,'design'),/artifact/);}finally{f.clean();}
});
test('real CLI: fresh design executes matching pack then stops at approval',async()=>{
 const f=fixture();try{
  let stdout='',stderr='';
  const rc=await runLoop({root:f.root,client:'codex',env:f.env,onOutput:x=>stdout+=x,onError:x=>stderr+=x});
  assert.equal(rc,2,stderr);
  assert.equal(readState(f.root).currentStage,'design');
  assert.equal(readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').length,1);
  assert.match(stdout,/client-output/);
  assert.ok(existsSync(join(f.root,'.gantry/specs/demo/DESIGN.md')));
  assert.equal(existsSync(join(f.root,'.gantry/planning/ralph.lock')),false);
 }finally{f.clean();}
});
test('existing unapproved draft is not rewritten on restart',async()=>{
 const f=fixture();try{
  writeFileSync(join(f.root,'.gantry/specs/demo/DESIGN.md'),'review me');
  const rc=await runLoop({root:f.root,client:'claude',env:f.env,onOutput:()=>{},onError:()=>{}});
  assert.equal(rc,2);
  assert.equal(existsSync(join(f.root,'calls')),false);
  assert.equal(readFileSync(join(f.root,'.gantry/specs/demo/DESIGN.md'),'utf8'),'review me');
 }finally{f.clean();}
});
test('idle cannot silently create change; token mismatch cannot dispatch',async()=>{
 for(const stage of ['idle','design']){
  const f=fixture(stage);try{
   if(stage==='design')writeFence(f.root,{nextStep:'gantry-test'});
   assert.equal(await runLoop({root:f.root,client:'codex',env:f.env,onOutput:()=>{},onError:()=>{}}),2);
   assert.equal(existsSync(join(f.root,'calls')),false);
  }finally{f.clean();}
 }
});
test('pack validator rejects phase/stage/task/change mismatch',()=>{
 const state={currentStage:'dev',activeChange:'demo',pipeline:'full'};
 const pack={stage:'dev',changeId:'demo',pipeline:'full',taskId:'T01',loadOrder:[{kind:'phase-prompt',path:'.gantry/core/phases/4-dev.md'}]};
 assert.equal(validatePack(pack,state,'T01'),pack);
 assert.throws(()=>validatePack({...pack,stage:'test'},state,'T01'));
 assert.throws(()=>validatePack({...pack,taskId:'T02'},state,'T01'));
 assert.throws(()=>validatePack({...pack,loadOrder:[]},state,'T01'));
});
test('invalid or malformed run deadlines fail before dispatch',async()=>{
 const f=fixture();try{
  for(const config of ['{',JSON.stringify({ralph:{runTimeoutMs:0}}),JSON.stringify({ralph:{executorTimeoutMs:Infinity}}),JSON.stringify({ralph:{maxRepairs:4}})]){
   writeFileSync(join(f.root,'.gantry/planning/config.json'),config);
   assert.equal(await runLoop({root:f.root,client:'codex',env:f.env,onOutput:()=>{},onError:()=>{}}),64);
  }
  assert.equal(existsSync(join(f.root,'calls')),false);
 }finally{f.clean();}
});
test('quiet keeps client output in run log',async()=>{
 const f=fixture();try{
  let out='';
  assert.equal(await runLoop({root:f.root,client:'codex',env:f.env,quiet:true,onOutput:x=>out+=x,onError:()=>{}}),2);
  assert.doesNotMatch(out,/client-output/);
  assert.match(readFileSync(join(f.root,'.gantry/loop/last-dispatch.log'),'utf8'),/client-output/);
 }finally{f.clean();}
});

test('real DEV controller converges three dependent tasks, refreshes repair packs and commits once', async () => {
 const {execFileSync} = await import('node:child_process');
 const {readTaskRecord} = await import('../src/lib/task-record.mjs');
 const f=fixture('dev');
 const git=(...args)=>execFileSync('git',args,{cwd:f.root,encoding:'utf8'}).trim();
 try {
  git('init','-b','release/controller-test');git('config','user.name','Ralph');git('config','user.email','ralph@example.com');
  writeFileSync(join(f.root,'.gitignore'),'.gantry/\n');
  mkdirSync(join(f.root,'src'));
  for(const id of ['T01','T02','T03'])writeFileSync(join(f.root,`src/${id}.txt`),'0');
  writeFileSync(join(f.root,'.gantry/specs/demo/TASKS.md'),['T01','T02','T03'].map((id,i)=>`<task id="${id}" status="pending"><read_files>src/${id}.txt</read_files><write_files>src/${id}.txt</write_files><verify>node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('src/${id}.txt','utf8'),'1')"</verify><depends_on>${i ? `T0${i}` : ''}</depends_on><done>value is one</done></task>`).join('\n'));
  git('add','.');git('commit','-m','baseline');
  const initial=Number(git('rev-list','--count','HEAD'));
  const calls=[];const packs=[];let errors="";
  const rc=await runLoop({root:f.root,client:'codex',env:{...f.env,GANTRY_LOOP_MAX_STEPS:'1'},onOutput:()=>{},onError:x=>errors+=x,executeCandidate:async({task,attempt,packPath})=>{
   const pack=JSON.parse(readFileSync(packPath,'utf8'));packs.push(pack);
   assert.equal(pack.taskId,task.id);assert.equal(pack.attemptId,attempt.id);
   calls.push(`${task.id}:${attempt.repairOrdinal}`);
   if(task.id!=='T02'||attempt.repairOrdinal===1)writeFileSync(join(f.root,`src/${task.id}.txt`),'1');
   return {exitCode:0,cleanupComplete:true};
  }});
  if(rc!==3) {
   const {captureManifest,checkTaskScope}=await import('../src/lib/task-evidence.mjs');
   const current=captureManifest(f.root,{includePaths:['.gantry/specs/demo/TASKS.md','.gantry/planning/config.json']});
   errors+=JSON.stringify({calls,scopes:['T01','T02','T03'].map(id=>{const r=readTaskRecord(f.root,'demo',id);return r?{id,scope:checkTaskScope(r.baseline,current,['src/T01.txt','src/T02.txt','src/T03.txt'])}:null;})});
  }
  assert.equal(rc,3,errors);
  assert.deepEqual(calls,['T01:0','T02:0','T02:1','T03:0']);
  assert.equal(packs[2].retryHistory.count,1);
  assert.ok(packs[2].retryHistory.lastFailure);
  assert.equal(readState(f.root).currentStage,'test');
  assert.equal(Number(git('rev-list','--count','HEAD')),initial+1);
  for(const id of ['T01','T02','T03'])assert.equal(readTaskRecord(f.root,'demo',id).receipt.pass,true);
  assert.equal(readTaskRecord(f.root,'demo','T02').repairsUsed,1);
  assert.equal(existsSync(join(f.root,'.gantry/planning/ralph.lock')),false);
 }finally{f.clean();}
});

test('non-DEV failed artifact gate retries are bounded independently of task repairs',async()=>{
 const f=fixture('task');try{
  writeFileSync(join(f.root,'adapter.sh'),'#!/usr/bin/env bash\necho invocation >> "$PROJECT_ROOT/calls"\n');
  writeFileSync(join(f.root,'.gantry/planning/config.json'),JSON.stringify({autonomous:{maxRetries:2}}));
  let stderr='';
  const rc=await runLoop({root:f.root,client:'codex',env:f.env,onOutput:()=>{},onError:x=>stderr+=x});
  assert.equal(rc,1,stderr);
  assert.equal(readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').length,3);
  assert.equal(readState(f.root).currentStage,'task');
  assert.match(stderr,/retry: task gate 2\/2/);
 }finally{f.clean();}
});

test('light controller keeps its existing fast gate and archive flow outside task-cycle',async()=>{
 const {execFileSync,spawnSync}=await import('node:child_process');
 const f=fixture('idle');
 const cli=new URL('../src/cli.mjs',import.meta.url).pathname;
 const git=(...args)=>execFileSync('git',args,{cwd:f.root,encoding:'utf8'}).trim();
 try{
  writeState(f.root,{...readState(f.root),activeChange:null,currentStage:'idle'});
  git('init','-b','release/light-controller');git('config','user.name','Ralph');git('config','user.email','ralph@example.com');
  mkdirSync(join(f.root,'src'));writeFileSync(join(f.root,'src/value.txt'),'0');writeFileSync(join(f.root,'.gitignore'),'.gantry/\n');
  writeFileSync(join(f.root,'adapter.sh'),'#!/usr/bin/env bash\necho -n 1 > src/value.txt\n');
  git('add','.');git('commit','-m','baseline');
  const start=spawnSync(process.execPath,[cli,'change','--tier','light','--id','small-fix','--scope','src/value.txt','--verify',`node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('src/value.txt','utf8'),'1')"`,'small fix'],{cwd:f.root,encoding:'utf8'});
  assert.equal(start.status,0,start.stderr);
  let errors='';
  const rc=await runLoop({root:f.root,client:'codex',env:f.env,onOutput:()=>{},onError:x=>errors+=x,cycleModule:{get selectReadyTask(){throw new Error('light must not enter full task-cycle');}}});
  assert.equal(rc,0,errors);
  assert.equal(readState(f.root).currentStage,'idle');
  assert.equal(existsSync(join(f.root,'.gantry/specs/_archive/small-fix')),true);
 }finally{f.clean();}
});

test('both adapters enforce frozen pack identity before launching the model',async()=>{
 const {spawnSync}=await import('node:child_process');
 const f=fixture('dev');try{
  const bin=join(f.root,'bin');mkdirSync(bin);
  const packPath=join(f.root,'frozen pack.json');
  writeFileSync(join(f.root,'.gantry/core/phases/4-dev.md'),'task phase');
  writeFileSync(join(f.root,'.gantry/planning/context-pack.json'),JSON.stringify({stage:'test',taskId:'WRONG'}));
  for(const client of ['claude','codex']){
   const marker=join(f.root,`${client}.called`);
   writeFileSync(join(bin,client),`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},process.argv.slice(2).join('\\n'));\n`,{mode:0o755});
   const adapter=new URL(`../src/loop/dispatch-${client}.sh`,import.meta.url).pathname;
   const env={...process.env,PATH:`${bin}:${process.env.PATH}`,PROJECT_ROOT:f.root,GANTRY_RALPH_ATTEMPT_ID:'attempt-1'};
   writeFileSync(packPath,JSON.stringify({stage:'dev',taskId:'T01',attemptId:'attempt-1'}));
   const valid=spawnSync('bash',[adapter,'dev','T01','--pack',packPath],{cwd:f.root,env,encoding:'utf8'});
   assert.equal(valid.status,0,valid.stderr);
   assert.match(readFileSync(marker,'utf8'),/frozen pack\.json/);
   rmSync(marker);
   writeFileSync(packPath,JSON.stringify({stage:'dev',taskId:'T01',attemptId:'old-attempt'}));
   const invalid=spawnSync('bash',[adapter,'dev','T01','--pack',packPath],{cwd:f.root,env,encoding:'utf8'});
   assert.equal(invalid.status,64);assert.match(invalid.stderr,/identity mismatch/);assert.equal(existsSync(marker),false);
  }
 }finally{f.clean();}
});


test('new change clears previous convergence and approval metadata',()=>{
 const f=fixture();try{
  writeFileSync(join(f.root,'.gantry/specs/demo/DESIGN.md'),'old draft');
  approveStage(f.root,'design');
  writeFence(f.root,{...readFence(f.root),nextStep:'done',lastStageResult:{ok:true}});
  writeState(f.root,{...readState(f.root),activeChange:'next-change',currentStage:'change'});
  assert.equal(readFence(f.root).nextStep,null);
  assert.deepEqual(readFence(f.root).approvals,{});
 }finally{f.clean();}
});


test('successful transition clears phase-local nextStep but preserves approved bytes',()=>{
 const f=fixture();try{
  writeFileSync(join(f.root,'.gantry/specs/demo/DESIGN.md'),'approved draft');approveStage(f.root,'design');
  writeFence(f.root,{...readFence(f.root),nextStep:'gantry-design',lastStageResult:{ok:true}});
  transitionStage(f.root,'design','task');
  assert.equal(readFence(f.root).nextStep,null);assert.equal(readFence(f.root).lastStageResult,null);
  assert.equal(isStageApproved(f.root,'design'),true);
 }finally{f.clean();}
});

test('cancelling the nested CLI checkpoint waits until its TERM-ignoring verifier stops writing',async()=>{
 const {execFileSync}=await import('node:child_process');
 const {prepareTask,verifyAndComplete}=await import('../src/lib/task-cycle.mjs');
 const f=fixture('dev');const git=(...args)=>execFileSync('git',args,{cwd:f.root,encoding:'utf8'}).trim();
 let poll;try{
  git('init','-b','release/nested-cleanup');git('config','user.name','Ralph');git('config','user.email','ralph@example.com');
  writeFileSync(join(f.root,'.gitignore'),'.gantry/\n');mkdirSync(join(f.root,'src'));writeFileSync(join(f.root,'src/value.txt'),'0');
  writeFileSync(join(f.root,'.gantry/planning/config.json'),JSON.stringify({ralph:{runTimeoutMs:10000,killGraceMs:40}}));
  writeFileSync(join(f.root,'verify.mjs'),`import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(fs.readFileSync('src/value.txt','utf8'),'1'); if(fs.existsSync('.gantry/loop/block-verify')){process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync('.gantry/loop/writes','x'),5);}`);
  writeFileSync(join(f.root,'.gantry/specs/demo/TASKS.md'),'<task id="T01" status="pending"><write_files>src/value.txt</write_files><verify>node verify.mjs</verify><done>one</done></task>');
  git('add','.');git('commit','-m','baseline');
  assert.equal((await prepareTask(f.root,'T01')).kind,'prepared');writeFileSync(join(f.root,'src/value.txt'),'1');
  assert.equal((await verifyAndComplete(f.root,'T01')).kind,'completed');
  mkdirSync(join(f.root,'.gantry/loop'),{recursive:true});writeFileSync(join(f.root,'.gantry/loop/block-verify'),'block');
  const abort=new AbortController();const path=join(f.root,'.gantry/loop/writes');
  poll=setInterval(()=>{if(existsSync(path))abort.abort();},10);
  const rc=await runLoop({root:f.root,client:'codex',env:f.env,signal:abort.signal,onOutput:()=>{},onError:()=>{}});
  assert.equal(rc,130);assert.equal(existsSync(path),true,'must reach the actual nested verifier');
  const snapshot=readFileSync(path,'utf8');await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(readFileSync(path,'utf8'),snapshot,'no descendant may keep writing after controller returns');
  assert.equal(existsSync(join(f.root,'.gantry/planning/ralph.lock')),false);
 }finally{clearInterval(poll);f.clean();}
});
