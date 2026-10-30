/** Diagnosis is based on observed outcomes. Unknown failures never imply retry. */
export function classifyFailure({reason='',kind,run,priorOutcome,contentDigest,ownerTaskId=null}={}) {
  let category='blocked-human',retry='none';
  if(/dependency|unfinished-tasks/.test(reason)){category='dependency-invalid';retry='revalidate-dependency';}
  else if(run?.spawnError||[126,127].includes(run?.exitCode)||/preflight|command-unavailable|command-spawn-error/.test(reason)){category='environment-failure';retry='after-environment-fix';}
  else if(run?.cleanupComplete===false||run?.cancelled||run?.timedOut||/out-of-scope|weakened|contract|executor-failure|cleanup/.test(reason))category='blocked-human';
  else if(priorOutcome?.passed===true&&priorOutcome.contentDigest===contentDigest&&run?.exitCode!==0){category='flaky-test';retry='review-instability';}
  else if(kind==='failed'){category='task-defect';retry='repair-owned-task';}
  return {category,retry,ownerTaskId,reason};
}
export function recoveryPlan(failure,{writeFiles=[]}={}) {
  return {category:failure.category,ownerTaskId:failure.ownerTaskId,action:failure.retry,writeFiles:failure.category==='task-defect'?[...writeFiles]:[],preserveOtherTasks:true,preserveUserChanges:true,revertWave:false};
}
