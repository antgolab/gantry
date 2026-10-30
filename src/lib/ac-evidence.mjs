/** AC receipts are observations, never coverage declarations. Gates only read them. */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { captureManifest, inspectVerificationOutput } from './task-evidence.mjs';
import { parseTestCommands } from './test-commands.mjs';
import { extractAcIds } from './ac-coverage.mjs';
import { runShellCommand } from './process-runner.mjs';
import { acquireWorkspaceLock, releaseWorkspaceLock } from './task-record.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = path => existsSync(path) ? hash(readFileSync(path)) : null;
const reportNames = new Set(['TEST.md','REVIEW.md','UAT.md','JOURNEY-VERIFY.md','EXECUTION.md']);
function sourceDigest(root, dir) {
  const prefix = relative(root,dir).replaceAll('\\','/') + '/';
  const manifest = captureManifest(root,{includePaths:[`${prefix}SPEC.md`,`${prefix}TASKS.md`,'.gantry/loop/test-commands.yml','.gantry/planning/config.json']});
  // Reports and receipt files are outputs. SPEC, tasks, code, index and config
  // remain inputs, so writing the report cannot invalidate its own evidence.
  return hash(JSON.stringify(manifest.entries.filter(e=>!(e.path.startsWith(prefix) && reportNames.has(e.path.slice(prefix.length)))).map(e=>({path:e.path,worktreeHash:e.worktreeHash,indexHash:e.indexHash,mode:e.mode,permissions:e.permissions,indexMode:e.indexMode}))));
}
function location(root,dir) {
  root=realpathSync(root); dir=realpathSync(dir); const rel=relative(join(root,'.gantry/specs'),dir);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) throw new Error('AC evidence requires one active change directory');
  return join(dir,'execution','ac-evidence.json');
}
function load(root,dir) {
  const path=location(root,dir); if(!existsSync(path)) return {schemaVersion:1,entries:[]};
  const record=JSON.parse(readFileSync(path,'utf8')); if(record.schemaVersion!==1||!Array.isArray(record.entries)) throw new Error('AC evidence corrupt'); return record;
}
function save(root,dir,record) {const path=location(root,dir);mkdirSync(join(dir,'execution'),{recursive:true}); const tmp=`${path}.${randomUUID()}.tmp`;writeFileSync(tmp,JSON.stringify(record,null,2)+'\n');renameSync(tmp,path);}
function acIds(dir) { const path=join(dir,'SPEC.md');return existsSync(path)?extractAcIds(readFileSync(path,'utf8')):[]; }
function artifact(root,path) {
  if(typeof path!=='string'||isAbsolute(path)||path.split(/[\\/]/).includes('..'))throw new Error('invalid evidence path');
  const full=realpathSync(resolve(root,path));const rel=relative(realpathSync(root),full);
  if(rel.startsWith('..')||isAbsolute(rel))throw new Error('external evidence path');
  return {path,hash:fileHash(full)};
}
export function checkAcEvidence(root,dir) {
  const ids=acIds(dir);if(!ids.length)return {passed:true,skipped:true};
  try {
    const record=load(root,dir);const digest=sourceDigest(root,dir);const mapping=parseTestCommands(join(root,'.gantry/loop/test-commands.yml'))??{};
    const missing=ids.filter(id=>record.entries.some(e=>e.acId===id&&e.contentDigest===digest&&e.result!=='pass')||!record.entries.some(e=>{
      if(e.acId!==id||e.contentDigest!==digest||e.result!=='pass'||!e.verifiedAt||!e.steps)return false;
      if(e.kind==='command') {
        const configured=mapping[e.commandKey];return configured?.cmd===e.steps && configured.covers.some(ac=>ac===id||ac==='*') && e.exitCode===0 && e.run?.cleanupComplete===true && !e.run.cancelled&&!e.run.timedOut&&!e.run.spawnError && e.run.inspection?.ok===true;
      }
      if(!['manual','journey'].includes(e.kind)||!e.actual?.trim()||!e.evidencePath)return false;
      return artifact(root,e.evidencePath).hash===e.evidenceHash;
    }));
    return {passed:missing.length===0,missing,reason:missing.length?`ac-evidence: missing/stale ${missing.join(', ')}; run gantry verify-ac or record observed UAT evidence`:undefined};
  } catch(error) {return {passed:false,reason:`ac-evidence: ${error.message}; run gantry verify-ac`};}
}
export async function runAcVerification(root,dir,{signal,timeoutMs=600000,killGraceMs=5000,onOutput,ownerNonce}={}) {
  const lock=acquireWorkspaceLock(root,{ownerNonce});
  try {
    const mapping=parseTestCommands(join(root,'.gantry/loop/test-commands.yml'))??{}; const ids=acIds(dir);
    const contentDigest=sourceDigest(root,dir);const record=load(root,dir);const entries=record.entries.filter(e=>e.kind!=='command');
    // One execution per exact command in this invocation. Group aliases before
    // running so even a failure records every affected AC; never reuse across
    // invocations (remote state is not represented by the source digest).
    const groups=new Map();
    for(const [key,item] of Object.entries(mapping)) {
      const covers=ids.filter(id=>item.covers.includes(id)||item.covers.includes('*'));if(!covers.length)continue;
      if(!groups.has(item.cmd))groups.set(item.cmd,[]);
      groups.get(item.cmd).push({key,covers});
    }
    for(const [command,aliases] of groups) {
      const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
      const run=await runShellCommand(command,{cwd:root,env:childEnv,signal,timeoutMs,killGraceMs,onOutput});
      run.inspection=inspectVerificationOutput(`${run.stdout}\n${run.stderr}`);
      const stable=sourceDigest(root,dir)===contentDigest;
      const pass=run.exitCode===0&&run.cleanupComplete===true&&!run.cancelled&&!run.timedOut&&!run.spawnError&&run.inspection.ok&&stable;
      const verifiedAt=new Date().toISOString();
      for(const {key,covers} of aliases)for(const acId of covers)entries.push({acId,kind:'command',commandKey:key,steps:command,exitCode:run.exitCode,result:pass?'pass':'fail',contentDigest,verifiedAt,run});
      if(!pass){save(root,dir,{schemaVersion:1,entries});return {passed:false,reason:stable?'AC command failed':'AC verification mutated source',runs:entries};}
    }
    save(root,dir,{schemaVersion:1,entries});return checkAcEvidence(root,dir);
  }finally{releaseWorkspaceLock(root,lock);}
}
export function recordAcObservation(root,dir,entry,{ownerNonce}={}) {
  const lock=acquireWorkspaceLock(root,{ownerNonce});try {
    if(!acIds(dir).includes(entry.acId)||!['manual','journey'].includes(entry.kind)||!entry.steps?.trim()||!entry.actual?.trim()||!['pass','fail','caveat'].includes(entry.result)||!entry.evidencePath)throw new Error('manual evidence requires AC, steps, actual, result and evidencePath');
    const proof=artifact(root,entry.evidencePath);const record=load(root,dir);
    const observation={acId:entry.acId,kind:entry.kind,steps:entry.steps,actual:entry.actual,result:entry.result,evidencePath:proof.path,evidenceHash:proof.hash,contentDigest:sourceDigest(root,dir),verifiedAt:new Date().toISOString()};
    record.entries=record.entries.filter(e=>e.acId!==entry.acId||e.kind!==entry.kind);record.entries.push(observation);save(root,dir,record);return observation;
  }finally{releaseWorkspaceLock(root,lock);}
}
