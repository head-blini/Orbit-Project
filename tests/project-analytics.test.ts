import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Controller} from '../server/controller.ts';
import {projectAnalytics} from '../server/project-analytics.ts';
import type {RunMetrics} from '../shared/analytics.ts';

const at='2026-10-26T00:00:00.000Z';
function fixture(){
  const store=new Store(':memory:');new Controller(store,'/unused',()=>{throw new Error('NO_NATIVE_CALLS');});
  const projectId=randomUUID(),otherId=randomUUID(),workspaceId=randomUUID(),otherWorkspaceId=randomUUID();
  for(const id of [projectId,otherId])store.saveProject({id,name:'PRIVATE_PROJECT',path:'/PRIVATE_PATH',createdAt:at,writeEnabled:false});
  for(const [id,pid] of [[workspaceId,projectId],[otherWorkspaceId,otherId]])store.saveWorkspace({id,projectId:pid,path:'/PRIVATE_WORKSPACE',branch:'PRIVATE_BRANCH',baseSha:'a'.repeat(40),status:'ready',createdAt:at});
  const run=(ws:string|undefined=workspaceId)=>{const r=store.createRun(randomUUID(),'digest','PRIVATE_PROMPT',ws);store.updateRun(r.id,{execution:'completed',response:'PRIVATE_RESPONSE'},'run.completed');return r;};
  const insert=(table:string,value:Record<string,unknown>,pid=projectId)=>{
    const record={id:randomUUID(),projectId:pid,workspaceId,createdAt:at,finishedAt:at,execution:'completed',durationMs:5,...value};
    const args=table==='workflow_runs'?[record.id,pid,JSON.stringify(record)]:[record.id,randomUUID(),'digest',pid,JSON.stringify(record)];
    store.db.prepare(`INSERT INTO ${table} VALUES(${args.map(()=>'?').join(',')})`).run(...args);return record;
  };
  const metrics=(id:string,patch:Partial<RunMetrics>={})=>store.saveRunMetrics({runId:id,threadId:'PRIVATE_NATIVE_THREAD',turnId:'PRIVATE_NATIVE_TURN',modelAtStart:'fixture-model',modelProvider:'openai',modelChanged:false,tokens:{inputTokens:10,cachedInputTokens:2,cacheWriteInputTokens:0,outputTokens:5,reasoningOutputTokens:1,totalTokens:15},tokenStatus:'observed',tokenIssue:null,observedAt:at,finishedAt:at,durationMs:20,retryNotices:2,...patch});
  return {store,projectId,otherId,workspaceId,otherWorkspaceId,run,insert,metrics};
}
test('analytics counts canonical project records once and projects no private payloads or provider calls',()=>{
  const f=fixture();try{
    const r=f.run();f.metrics(r.id);f.run(f.otherWorkspaceId);f.run(undefined);
    // The default argument above targets this project; insert a truly unscoped legacy run separately.
    f.store.createRun(randomUUID(),'digest','UNSCOPED_PRIVATE_PROMPT');
    f.insert('model_hub_requests',{providerId:'local',model:'fixture-api',response:'PRIVATE_API_RESPONSE',endpoint:'PRIVATE_ENDPOINT',usage:{source:'provider',promptTokens:7,completionTokens:3,totalTokens:10}});
    f.insert('planning_suggestions',{proposal:{title:'PRIVATE_PROPOSAL'},execution:'timed_out'});
    f.insert('native_reviews',{response:'PRIVATE_REVIEW',execution:'stale'});
    f.insert('model_hub_requests',{providerId:'local',model:'other',usage:{source:'provider',totalTokens:9999}},f.otherId);
    f.store.append('duplicate.receipt',r.id,{run:r});f.store.append('duplicate.receipt',r.id,{run:r});
    const seq=f.store.lastSeq(),out=projectAnalytics(f.store,f.projectId);
    assert.equal(out.totals.records,5);assert.equal(out.totals.tokenSubtotal,25);assert.equal(out.totals.tokenKnownRecords,2);assert.equal(out.totals.tokenUnknownRecords,3);
    assert.equal(out.totals.timedOut,1);assert.equal(out.totals.stale,1);assert.equal(out.totals.durationKnownRecords,4);
    assert.equal(out.costUsd,null);assert.equal(out.source,'local_records');assert.equal(f.store.lastSeq(),seq);
    assert.doesNotMatch(JSON.stringify(out),/PRIVATE_|UNSCOPED|endpoint|threadId|response|proposal/);
  }finally{f.store.close();}
});
test('only actual owned checks count; completed and recorded are never inferred verification passes',()=>{
  const f=fixture();try{
    const r=f.run(),other=f.run(f.otherWorkspaceId);f.store.transaction(()=>f.store.markVerificationRecorded(r.id));
    for(const value of [
      {runId:r.id,projectId:f.projectId,workspaceId:f.workspaceId,verdict:'passed',execution:'completed'},
      {runId:r.id,projectId:f.projectId,workspaceId:f.workspaceId,verdict:'failed',execution:'completed'},
      {runId:r.id,projectId:f.projectId,workspaceId:f.workspaceId,verdict:'not_run',execution:'lost'},
      {runId:other.id,projectId:f.projectId,workspaceId:f.workspaceId,verdict:'passed',execution:'completed'},
      {runId:r.id,projectId:f.otherId,workspaceId:f.workspaceId,verdict:'passed',execution:'completed'}]){
      const id=randomUUID();f.store.db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run(id,randomUUID(),JSON.stringify({id,output:'PRIVATE_CHECK',...value}));
    }
    const out=projectAnalytics(f.store,f.projectId);assert.equal(out.totals.checks.total,3);assert.equal(out.totals.checks.passed,1);assert.equal(out.totals.checks.failed,1);assert.equal(out.totals.checks.lost,1);
    assert.deepEqual(out.records[0].checks,out.totals.checks);assert.equal(out.totals.tokenSubtotal,null);assert.equal(out.totals.durationSubtotalMs,null);
  }finally{f.store.close();}
});
test('workflow retries require matching explicit predecessor and never invent elapsed time from step sums',()=>{
  const f=fixture();try{
    const context={workspaceId:f.workspaceId,workflowId:randomUUID(),versionId:randomUUID(),sourceDigest:'a',configDigest:'b',steps:[{durationMs:100}],durationMs:undefined};
    const first=f.insert('workflow_runs',{...context,status:'failed',attempt:1,retryOfId:null});
    f.insert('workflow_runs',{...context,status:'passed',attempt:2,retryOfId:first.id});
    f.insert('workflow_runs',{...context,status:'failed',attempt:3,retryOfId:randomUUID()});
    const out=projectAnalytics(f.store,f.projectId);assert.equal(out.totals.workflowRetries,1);assert.ok(out.records.every(r=>r.durationMs===null));
    assert.equal(out.records.filter(r=>r.retryCount===1).length,1);assert.equal(out.records.filter(r=>r.retryCount===null).length,1);
  }finally{f.store.close();}
});
test('keyset pages are project-bound, deterministic across equal timestamps, and independent of totals',()=>{
  const f=fixture();try{
    for(let i=0;i<57;i++)f.insert('model_hub_requests',{providerId:'local',model:'m',usage:{source:'unknown'}});
    const seen=new Set<string>();let cursor:string|undefined;
    do {const out=projectAnalytics(f.store,f.projectId,{limit:10,cursor});assert.equal(out.totals.records,57);assert.ok(out.records.length<=10);for(const r of out.records){assert.equal(seen.has(r.id),false);seen.add(r.id);}cursor=out.nextCursor??undefined;}while(cursor);
    assert.equal(seen.size,57);const first=projectAnalytics(f.store,f.projectId,{limit:10});
    assert.throws(()=>projectAnalytics(f.store,f.otherId,{cursor:first.nextCursor!}),/INVALID_CURSOR/);
    for(const options of [{limit:0},{limit:51},{limit:1.5},{cursor:'garbage'}])assert.throws(()=>projectAnalytics(f.store,f.projectId,options),/INVALID_/);
    assert.throws(()=>projectAnalytics(f.store,randomUUID()),/PROJECT_NOT_FOUND/);
  }finally{f.store.close();}
});
test('zero is known, partial token fields stay missing, overflow is unknown and changed model is unattributed',()=>{
  const f=fixture();try{
    const r=f.run();f.metrics(r.id,{modelChanged:true,tokenStatus:'incomplete',tokens:null});
    f.insert('model_hub_requests',{providerId:'local',model:'m',usage:{source:'provider',promptTokens:0,completionTokens:null,totalTokens:null},durationMs:0});
    f.insert('model_hub_requests',{providerId:'local',model:'m',usage:{source:'provider',totalTokens:0},durationMs:0});
    let out=projectAnalytics(f.store,f.projectId);assert.equal(out.totals.tokenSubtotal,0);assert.equal(out.totals.tokenKnownRecords,1);assert.equal(out.totals.tokenIncompleteRecords,1);assert.equal(out.records.find(x=>x.id===r.id)?.model,null);
    f.insert('model_hub_requests',{providerId:'local',model:'m',usage:{source:'provider',totalTokens:Number.MAX_SAFE_INTEGER}});
    f.insert('model_hub_requests',{providerId:'local',model:'m',usage:{source:'provider',totalTokens:1}});
    out=projectAnalytics(f.store,f.projectId);assert.equal(out.totals.tokenSubtotal,null);assert.equal(out.totals.tokenKnownRecords,3);
  }finally{f.store.close();}
});
test('quarantine overlay exposes lost status and metrics updates do not mutate the terminal run',()=>{
  const f=fixture();try{
    const r=f.run(),before=f.store.getRun(r.id);f.metrics(r.id);assert.deepEqual(f.store.getRun(r.id),before);
    const p=f.insert('planning_suggestions',{execution:'running',durationMs:null,finishedAt:null});
    const out=projectAnalytics(f.store,f.projectId,{},id=>id===p.id?{execution:'lost',finishedAt:at,durationMs:null}:null);
    assert.equal(out.records.find(x=>x.id===p.id)?.execution,'lost');assert.equal(out.totals.lost,1);
  }finally{f.store.close();}
});
test('model identifiers cannot disclose URLs, filesystem locations, traversal or credentials',()=>{
  const f=fixture();try{
    for(const model of ['https://private.invalid/path','C:/Users/private/model','org/../private','person@example.test','sk-synthetic-credential'])f.insert('model_hub_requests',{providerId:'local',model,usage:{source:'unknown'}});
    f.insert('model_hub_requests',{providerId:'local',model:'org/model-v1:0',usage:{source:'unknown'}});
    const out=projectAnalytics(f.store,f.projectId);assert.equal(out.records.filter(r=>r.model===null).length,5);assert.equal(out.records.find(r=>r.model!==null)?.model,'org/model-v1:0');assert.doesNotMatch(JSON.stringify(out),/private|credential|example\.test/);
  }finally{f.store.close();}
});
test('three-attempt workflow chain counts two links and equal-time pagination crosses record kinds',()=>{
  const f=fixture();try{
    const context={workspaceId:f.workspaceId,workflowId:randomUUID(),versionId:randomUUID(),sourceDigest:'a',configDigest:'b',status:'failed'};
    const first=f.insert('workflow_runs',{...context,attempt:1,retryOfId:null}),second=f.insert('workflow_runs',{...context,attempt:2,retryOfId:first.id});f.insert('workflow_runs',{...context,status:'passed',attempt:3,retryOfId:second.id});
    f.insert('planning_suggestions',{});f.insert('native_reviews',{});f.insert('model_hub_requests',{providerId:'local',model:'m',usage:{source:'unknown'}});
    let cursor:string|undefined;const seen=new Set<string>();do {const out=projectAnalytics(f.store,f.projectId,{limit:1,cursor});assert.equal(out.totals.workflowRetries,2);assert.equal(out.totals.records,6);for(const row of out.records){assert.equal(seen.has(row.kind+row.id),false);seen.add(row.kind+row.id);}cursor=out.nextCursor??undefined;}while(cursor);assert.equal(seen.size,6);
  }finally{f.store.close();}
});
test('lost native execution suppresses stale metrics even if interruption occurred between recovery writes',()=>{
  const f=fixture();try{
    const r=f.store.createRun(randomUUID(),'digest','fixture',f.workspaceId);f.metrics(r.id);f.store.updateRun(r.id,{execution:'lost'},'run.lost');
    const row=projectAnalytics(f.store,f.projectId).records[0];assert.equal(row.tokenStatus,'incomplete');assert.equal(row.tokens.totalTokens,null);assert.equal(row.durationMs,null);
  }finally{f.store.close();}
});
