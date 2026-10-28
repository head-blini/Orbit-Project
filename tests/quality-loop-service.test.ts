import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {QualityLoopService} from '../server/quality-loop-service.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {QualityServicePorts,QualityModelEvidence,QualityLoopStart} from '../shared/quality-loop-record.ts';
const evidence=(modelId='writer',sessionId='producer'):QualityModelEvidence=>({providerId:'native',modelId,sessionId,runId:sessionId,source:'native_observed'});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-quality-')),path=join(dir,'db.sqlite'),store=new Store(path),studio=new Studio(store),projectId=randomUUID();
  store.saveProject({id:projectId,name:'Report',kind:'general',path:dir,createdAt:new Date().toISOString(),writeEnabled:true});
  const input={format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Report',goal:'Evidence report',requirements:[{id:'REQ-1',description:'Write report',acceptance_criteria:['Cite evidence','Show date']}],constraints:['Local only'],open_questions:[]})};
  const version=studio.mutate(projectId,'plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
  studio.mutate(projectId,'plans',version.id,'approve',{expectedRevision:1});
  const [task]=studio.mutate(projectId,'plans',version.id,'task-drafts',{}) as SavedTask[];
  const run=store.createRun(randomUUID(),'digest','task',undefined,{runtime:'claude-code',projectId,taskId:task.id,planningVersionId:version.id,planningContentHash:version.contentHash,requirementLabels:task.requirementLabels});
  store.updateRun(run.id,{execution:'completed'},'run.completed');
  const ports:QualityServicePorts={guard:()=>{},snapshot:()=>({artifact:{id:'report',digest:'b'.repeat(64)},producer:evidence()}),review:async req=>({review:{modelKey:req.reviewer.modelKey,sessionId:randomUUID(),baselineDigest:req.baseline.digest,artifactDigest:req.artifact.digest,criteria:req.baseline.criteria.map(criterion=>({criterion,status:'met',evidence:'Section 1'})),findings:[]},evidence:evidence('reader','temporary')}),repair:async req=>({artifact:{id:req.artifact.id,digest:'c'.repeat(64)},evidence:evidence('writer',randomUUID())}),verify:async()=>({status:'passed',checkIds:['local-check'],issue:null})};
  ports.review=async req=>{const sessionId=randomUUID();return {review:{modelKey:req.reviewer.modelKey,sessionId,baselineDigest:req.baseline.digest,artifactDigest:req.artifact.digest,criteria:req.baseline.criteria.map(criterion=>({criterion,status:'met',evidence:'Section 1'})),findings:[]},evidence:evidence('reader',sessionId)};};
  const service=new QualityLoopService(store,ports),reviewers=[{id:'reviewer',providerId:'native',modelId:'reader'}],limits={maxRepairs:2,maxCalls:8,timeoutMs:5000};
  const request=():QualityLoopStart=>({requestId:randomUUID(),projectId,sourceRunId:run.id,reviewers,limits,expectedPreviewDigest:service.preview(projectId,run.id,reviewers,limits).previewDigest,confirmed:true});
  return {store,studio,service,ports,projectId,run,version,path,request,close:async()=>{await service.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('durable service binds approved criteria, preserves steps and idempotently returns same execution',async()=>{
  const f=fixture();try{const request=f.request(),started=f.service.start(request),done=await f.service.settled(started.id);assert.equal(done.result.status,'passed');assert.deepEqual(done.baseline.criteria,['Cite evidence','Show date']);assert.equal(done.steps.length,2);assert.equal(done.verification.status,'passed');assert.equal(f.service.start(request).id,started.id);assert.equal(f.store.getRun(f.run.id)!.verification,'not_run');assert.throws(()=>f.service.start({...request,limits:{...request.limits,maxCalls:7}}),/IDEMPOTENCY_CONFLICT/);}finally{await f.close();}
});
test('unknown producer identity cannot claim independent verification or dispatch',async()=>{
  const f=fixture();try{f.ports.snapshot=()=>({artifact:{id:'report',digest:'b'.repeat(64)},producer:{...evidence(),modelId:null,source:'unknown'}});let calls=0;f.ports.review=async()=>{calls++;throw Error();};const record=f.service.start(f.request());assert.equal(record.result.issue,'QUALITY_PRODUCER_MODEL_UNKNOWN');assert.equal(record.result.status,'blocked');assert.equal(calls,0);}finally{await f.close();}
});
test('observed model mismatch is preserved and never passes',async()=>{
  const f=fixture();try{const original=f.ports.review;f.ports.review=async(...args)=>{const out=await original(...args);out.evidence.modelId='writer';return out;};const record=await f.service.settled(f.service.start(f.request()).id);assert.equal(record.result.status,'failed');assert.equal(record.result.issue,'QUALITY_MODEL_MISMATCH');assert.equal(record.steps[0].evidence!.modelId,'writer');}finally{await f.close();}
});
test('only failures reach repair and all mandatory checks repeat after correction',async()=>{
  const f=fixture();try{let checks=0,repairs=0;f.ports.verify=async()=>++checks===1?{status:'failed',checkIds:['failed-check'],issue:'LOCAL_CHECK_FAILED',failures:[{reviewerId:'local',criterion:'Cite evidence',status:'not_met',evidence:'citation missing'}]}:{status:'passed',checkIds:['passed-check'],issue:null};const original=f.ports.repair;f.ports.repair=async(req,ctx)=>{repairs++;assert.deepEqual(req.failures,[{reviewerId:'local',criterion:'Cite evidence',status:'not_met',evidence:'citation missing'}]);assert.deepEqual(req.baseline.criteria,['Cite evidence','Show date']);return original(req,ctx);};const done=await f.service.settled(f.service.start(f.request()).id);assert.equal(done.result.status,'passed');assert.equal(checks,2);assert.equal(repairs,1);assert.equal(done.result.rounds.length,2);}finally{await f.close();}
});
test('quota and permission denial retain distinct causes and quarantine unknown dispatches',async()=>{
  for(const code of ['RATE_LIMITED','PERMISSION_DENIED']){const f=fixture();try{f.ports.review=async()=>{throw Error(code);};const done=await f.service.settled(f.service.start(f.request()).id);assert.equal(done.result.issue,code);assert.equal(done.recoveryRequired,true);assert.equal(done.steps[0].state,'intent');await assert.rejects(f.service.resume(done.id),/QUALITY_PROCESS_STOP_UNCONFIRMED/);}finally{await f.close();}}
});
test('lost execution resumes only from observed original result without duplicate dispatch',async()=>{
  const f=fixture();try{let calls=0;const original=f.ports.review;let observed:Awaited<ReturnType<typeof original>>;f.ports.review=async(...args)=>{calls++;observed=await original(...args);throw Error('EXECUTION_LOST');};const record=await f.service.settled(f.service.start(f.request()).id);assert.equal(record.recoveryRequired,true);
    const reopened=new Store(f.path),recoveredPorts={...f.ports,recover:async()=>({result:observed!.review,evidence:observed!.evidence})},resumed=new QualityLoopService(reopened,recoveredPorts);
    try{assert.equal(resumed.record(record.id).result.issue,'QUALITY_RESTART_RECOVERY_REQUIRED');await resumed.resume(record.id);const done=await resumed.settled(record.id);assert.equal(done.result.status,'passed');assert.equal(calls,1);assert.equal(done.steps.length,2);}finally{await resumed.close();reopened.close();}
  }finally{await f.close();}
});
test('close aborts hung verification and late results cannot overwrite terminal journal',async()=>{
  const f=fixture();try{let finish!:(v:any)=>void;let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);f.ports.verify=async context=>{assert.equal(context.signal.aborted,false);entered();return new Promise(r=>finish=r);};const started=f.service.start(f.request());await ready;await f.service.close();const stopped=f.service.record(started.id);assert.equal(stopped.recoveryRequired,true);assert.equal(stopped.result.issue,'QUALITY_PROCESS_STOP_UNCONFIRMED');finish({status:'passed',checkIds:[],issue:null});await new Promise(r=>setImmediate(r));assert.deepEqual(f.service.record(started.id),stopped);}finally{await f.close();}
});
test('approved version mutation invalidates frozen preview',async()=>{
  const f=fixture();try{const request=f.request();const row=f.store.db.prepare('SELECT body FROM planning_versions WHERE id=?').get(f.version.id)!;const altered=JSON.parse(String(row.body));altered.draft.requirements[0].acceptanceCriteria=[];f.store.db.prepare('UPDATE planning_versions SET body=? WHERE id=?').run(JSON.stringify(altered),f.version.id);assert.throws(()=>f.service.start(request),/PLANNING_VERSION_INVALID/);assert.equal(f.service.records().length,0);}finally{await f.close();}
});

test('repair limit retains unresolved findings without another repair dispatch',async()=>{
  const f=fixture();try{const original=f.ports.review;f.ports.review=async(...args)=>{const out=await original(...args);out.review.criteria[0].status='not_met';return out;};let repairs=0;f.ports.repair=async()=>{repairs++;throw Error('MUST_NOT_RUN');};const request=f.request();request.limits={...request.limits,maxRepairs:0};request.expectedPreviewDigest=f.service.preview(request.projectId,request.sourceRunId,request.reviewers,request.limits).previewDigest;const done=await f.service.settled(f.service.start(request).id);assert.equal(done.result.status,'limit_reached');assert.equal(done.result.rounds[0].failures.length,1);assert.equal(repairs,0);}finally{await f.close();}
});
test('concurrent recovery requests cannot observe or replay the same intent twice',async()=>{
  const f=fixture();try{f.ports.review=async()=>{throw Error('EXECUTION_LOST');};const done=await f.service.settled(f.service.start(f.request()).id);let finish!:(v:null)=>void;f.ports.recover=async()=>new Promise(r=>finish=r);const pending=f.service.resume(done.id);await assert.rejects(f.service.resume(done.id),/QUALITY_LOOP_BUSY/);finish(null);await assert.rejects(pending,/QUALITY_PROCESS_STOP_UNCONFIRMED/);}finally{await f.close();}
});
test('preview rejects ambiguous provider identities, unknown aliases and unexpected fields',async()=>{
  const f=fixture();try{const request=f.request();for(const reviewer of [{...request.reviewers[0],providerId:'native/other'},{...request.reviewers[0],modelId:'UNKNOWN'},{...request.reviewers[0],secret:'value'}])assert.throws(()=>f.service.preview(request.projectId,request.sourceRunId,[reviewer],request.limits),/INVALID_FIELDS/);assert.throws(()=>f.service.preview(request.projectId,request.sourceRunId,request.reviewers,{...request.limits,extra:1} as any),/QUALITY_LIMITS_INVALID/);}finally{await f.close();}
});
test('synchronous created observers cannot start a second loop before pending registration',async()=>{
  const f=fixture();try{const request=f.request();let attempted=false;f.store.on('event',event=>{if(event.kind==='quality.created'){attempted=true;assert.throws(()=>f.service.start({...request,requestId:randomUUID()}),/QUALITY_LOOP_BUSY/);}});const done=await f.service.settled(f.service.start(request).id);assert.equal(attempted,true);assert.equal(done.result.status,'passed');assert.equal(f.service.records().length,1);}finally{await f.close();}
});
test('observed stopped quota failure releases quarantine without retry or paid fallback',async()=>{
  const f=fixture();try{let calls=0;f.ports.review=async()=>{calls++;throw Error('RATE_LIMITED');};f.ports.recover=async()=>({failureIssue:'RATE_LIMITED',processStopped:true});const done=await f.service.settled(f.service.start(f.request()).id);assert.equal(done.result.status,'failed');assert.equal(done.result.issue,'RATE_LIMITED');assert.equal(done.recoveryRequired,false);assert.equal(done.steps[0].state,'failed');assert.equal(calls,1);}finally{await f.close();}
});
test('explicit quality interrupt aborts active work without claiming process stop or quality success',async()=>{
 const f=fixture();try{let entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve);
 f.ports.review=async()=>{entered();return new Promise(()=>{});};
 const record=f.service.start(f.request());await ready;f.service.interrupt(record.id);
 const stopped=await f.service.settled(record.id);assert.equal(stopped.recoveryRequired,true);assert.notEqual(stopped.result.status,'passed');
 assert.throws(()=>f.service.interrupt('missing'),/QUALITY_LOOP_NOT_FOUND/);
 }finally{await f.close();}
});
