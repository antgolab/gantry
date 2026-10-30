import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runHook,listHooks,checkHook} from '../src/lib/hooks.mjs';

test('empty hook forms silently skip repeated calls and are absent from listing',async()=>{
 for(const def of [undefined,null,false,'','  ',{},[],{cmd:''},{cmd:'  '}]){
  const config={hooks:{'after:test':def}};
  for(let i=0;i<3;i++)assert.deepEqual(await runHook(config,'after:test',tmpdir()),{ok:true,skipped:true});
  assert.deepEqual(listHooks(config),{});
  assert.equal(checkHook(def,tmpdir()).skipped,true);
 }
});
test('configured hook runs each time even after the same event was empty',async t=>{
 const root=mkdtempSync(join(tmpdir(),'gantry-hook-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config={hooks:{}};await runHook(config,'after:test',root);
 config.hooks['after:test']='printf x >> calls';
 assert.equal((await runHook(config,'after:test',root)).ok,true);
 assert.equal((await runHook(config,'after:test',root)).ok,true);
 assert.equal(readFileSync(join(root,'calls'),'utf8'),'xx');
 assert.equal((await runHook({hooks:{'after:test':'exit 7'}},'after:test',root)).ok,false);
});
