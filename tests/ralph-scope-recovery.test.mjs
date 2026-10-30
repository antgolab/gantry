import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {prepareTask,verifyAndComplete,getTaskReceiptStatus} from '../src/lib/task-cycle.mjs';
test('failed second task retains first task and staged/dirty user changes, with owner diagnosis',async t=>{
  const root=mkdtempSync(join(tmpdir(),'gantry-owner-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dir=join(root,'.gantry/specs/demo');mkdirSync(dir,{recursive:true});
  writeFileSync(join(root,'one.txt'),'one');writeFileSync(join(root,'two.txt'),'bad');writeFileSync(join(root,'user.txt'),'original');
  writeFileSync(join(root,'verify.mjs'),"import{readFileSync}from'node:fs';if(readFileSync('two.txt','utf8')!=='good')process.exit(1);");
  writeFileSync(join(dir,'TASKS.md'),'<task id="T01" status="pending"><write_files>one.txt</write_files><verify>true</verify><done>first</done></task>\n<task id="T02" status="pending"><write_files>two.txt</write_files><verify>node verify.mjs</verify><done>second</done><depends_on>T01</depends_on></task>');
  execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});
  writeFileSync(join(root,'user.txt'),'user staged');execFileSync('git',['add','user.txt'],{cwd:root});
  const opts={changeId:'demo'};await prepareTask(root,'T01',opts);assert.equal((await verifyAndComplete(root,'T01',opts)).kind,'completed');
  await prepareTask(root,'T02',opts);const failure=await verifyAndComplete(root,'T02',opts);
  assert.equal(failure.failure.category,'task-defect');assert.equal(failure.recovery.ownerTaskId,'T02');assert.equal(failure.recovery.revertWave,false);
  assert.equal(getTaskReceiptStatus(root,'T01',opts).valid,true);
  assert.equal(readFileSync(join(root,'user.txt'),'utf8'),'user staged');
  assert.match(execFileSync('git',['diff','--cached','--name-only'],{cwd:root,encoding:'utf8'}),/user.txt/);
  assert.match(readFileSync(join(dir,'TASKS.md'),'utf8'),/id="T01" status="done"/);
});

test('explicit recheck detects unchanged-source success-to-failure as flaky, without repair dispatch',async t=>{
  const root=mkdtempSync(join(tmpdir(),'gantry-flaky-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dir=join(root,'.gantry/specs/demo');mkdirSync(dir,{recursive:true});writeFileSync(join(root,'app.txt'),'stable');
  writeFileSync(join(dir,'TASKS.md'),'<task id="T01" status="pending"><write_files>app.txt</write_files><verify>node -e "process.exit(process.env.GANTRY_FLAKY_PROBE === \'1\' ? 1 : 0)"</verify><done>works</done></task>');
  execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});
  const opts={changeId:'demo'}; await prepareTask(root,'T01',opts);assert.equal((await verifyAndComplete(root,'T01',opts)).kind,'completed');
  const prior=process.env.GANTRY_FLAKY_PROBE;process.env.GANTRY_FLAKY_PROBE='1';
  try {
    const r=await verifyAndComplete(root,'T01',{...opts,forceRecheck:true});
    assert.equal(r.kind,'blocked');assert.equal(r.failure.category,'flaky-test');assert.equal(r.record.repairsUsed,0);assert.equal(getTaskReceiptStatus(root,'T01',opts).valid,false);
  } finally {if(prior===undefined)delete process.env.GANTRY_FLAKY_PROBE;else process.env.GANTRY_FLAKY_PROBE=prior;}
});

test('loop repairs unchanged-source flaky failure instead of returning the first gate error',async t=>{
  const {convergeTask}=await import('../src/lib/task-cycle.mjs');
  const root=mkdtempSync(join(tmpdir(),'gantry-flaky-loop-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dir=join(root,'.gantry/specs/demo');mkdirSync(dir,{recursive:true});writeFileSync(join(root,'app.txt'),'stable');
  writeFileSync(join(dir,'TASKS.md'),'<task id="T01" status="pending"><write_files>app.txt</write_files><verify>node -e "process.exit(process.env.GANTRY_FLAKY_LOOP_PROBE === \'1\' ? 1 : 0)"</verify><done>works</done></task>');
  execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});
  const opts={changeId:'demo'};await prepareTask(root,'T01',opts);assert.equal((await verifyAndComplete(root,'T01',opts)).kind,'completed');
  const prior=process.env.GANTRY_FLAKY_LOOP_PROBE;process.env.GANTRY_FLAKY_LOOP_PROBE='1';let calls=0;
  try {
    const result=await convergeTask(root,'T01',{...opts,forceRecheck:true,execute:async({record})=>{
      calls++;assert.match(record.failure.reason,/flaky-test/);delete process.env.GANTRY_FLAKY_LOOP_PROBE;return {exitCode:0};
    }});
    assert.equal(result.kind,'completed',result.reason);assert.equal(calls,1);assert.equal(result.record.repairsUsed,1);
  }finally{if(prior===undefined)delete process.env.GANTRY_FLAKY_LOOP_PROBE;else process.env.GANTRY_FLAKY_LOOP_PROBE=prior;}
});
