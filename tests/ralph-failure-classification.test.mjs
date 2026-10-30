import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyFailure,recoveryPlan} from '../src/lib/failure-classification.mjs';
test('defects, dependency, infrastructure, unsafe and instability outcomes have distinct recovery',()=>{
  assert.equal(classifyFailure({kind:'failed',reason:'command-failed',run:{exitCode:1}}).category,'task-defect');
  assert.equal(classifyFailure({reason:'dependency-receipt-invalid'}).category,'dependency-invalid');
  assert.equal(classifyFailure({reason:'command-unavailable',run:{exitCode:127}}).category,'environment-failure');
  assert.equal(classifyFailure({kind:'failed',run:{timedOut:true}}).category,'blocked-human');
  assert.equal(classifyFailure({reason:'unknown'}).retry,'none');
  assert.equal(classifyFailure({kind:'failed',run:{exitCode:1},contentDigest:'same',priorOutcome:{passed:true,contentDigest:'same'}}).category,'flaky-test');
});
test('recovery never authorizes wave revert or another owner files',()=>{
  const r=recoveryPlan(classifyFailure({kind:'failed',ownerTaskId:'T02'}),{writeFiles:['src/owned.mjs']});
  assert.equal(r.ownerTaskId,'T02');assert.deepEqual(r.writeFiles,['src/owned.mjs']);assert.equal(r.revertWave,false);assert.equal(r.preserveUserChanges,true);
});
