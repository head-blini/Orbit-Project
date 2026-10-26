import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { MergeService } from '../server/merge-service.ts';
import type { Projects } from '../server/projects.ts';
import type { VerificationService } from '../server/verification-service.ts';
import type { VerificationView } from '../shared/verification.ts';

function fixture(db=':memory:'){
  const store=new Store(db),p='project-a',w=randomUUID(),sha='a'.repeat(40),source='b'.repeat(64);
  store.saveProject({id:p,name:'Fixture',path:'never-accessed',createdAt:'',writeEnabled:true});
  store.saveWorkspace({id:w,projectId:p,path:'never-accessed-worktree',branch:'orbit/'+w,baseSha:sha,createdAt:'',status:'ready'});
  const run=store.createRun(randomUUID(),'digest','PRIVATE_PROMPT',w);store.updateRun(run.id,{execution:'completed',response:'PRIVATE_RESPONSE'},'test');
  let currentSource=source,busy=false,prepareCalls=0,applyCalls=0,outcome:'applied'|'not_applied'|'unknown'='not_applied',failApply=false,changeOnPrepare=false,changeOnVerify=false;
  const target={branch:'main',head:sha,treeSha:'c'.repeat(40)};
  const approval={id:randomUUID(),requestId:randomUUID(),runId:run.id,workspaceId:w,sourceDigest:source,checkSetDigest:'d'.repeat(64),createdAt:''};
  const view:VerificationView={workspaceId:w,runId:run.id,sourceDigest:source,sourceIssue:null,commands:[],checks:[],quarantined:false,checkSetDigest:approval.checkSetDigest,canApprove:true,approval,approvalCurrent:true,scope:'test'};
  const projects={mergeContext:()=>({workspace:store.workspaces()[0],project:store.projects()[0],scratchRoot:'never-accessed-scratch'}),mergeProject:()=>store.projects()[0],snapshot:()=>({sourceDigest:currentSource,files:[{path:'safe.ts',mode:'100644',presence:'present' as const,bytes:Buffer.from('approved bytes')}]}),fingerprint:()=>currentSource} as unknown as Projects;
  const verification={view:()=>({...view,sourceDigest:currentSource,approvalCurrent:view.approvalCurrent&&currentSource===source}),active:false} as unknown as VerificationService;
  const git={inspectMergeTarget:()=>({...target}),prepareMergeCandidate:(_path:string,_base:string,_snapshot:unknown,id:string)=>{prepareCalls++;if(changeOnPrepare)currentSource='e'.repeat(64);return {commitSha:'f'.repeat(40),treeSha:'1'.repeat(40),branch:'orbit-snapshot/'+id};},verifyMergeCandidate:()=>{if(changeOnVerify)currentSource='e'.repeat(64);},applyMergeCandidate:()=>{applyCalls++;if(failApply)throw new Error('PRIVATE_GIT_ERROR');outcome='applied';target.head='f'.repeat(40);target.treeSha='1'.repeat(40);},observeMergeApplication:()=>outcome};
  const service=new MergeService(store,projects,verification,()=>busy,git);
  const prepare=()=>({requestId:randomUUID(),workspaceId:w,runId:run.id,expectedSourceDigest:source,expectedCheckSetDigest:approval.checkSetDigest,expectedApprovalId:approval.id,expectedTargetBranch:'main',expectedTargetHead:sha});
  return {store,service,projects,verification,git,view,p,w,run,target,prepare,counts:()=>({prepareCalls,applyCalls}),setSource:(value:string)=>{currentSource=value;},setBusy:(value:boolean)=>{busy=value;},setFailApply:()=>{failApply=true;},setOutcome:(value:typeof outcome)=>{outcome=value;},changeOnPrepare:()=>{changeOnPrepare=true;},changeOnVerify:()=>{changeOnVerify=true;}};
}
test('approved merge separates candidate preparation from explicit apply and idempotent replay never repeats Git writes',()=>{
  const f=fixture();try{
    assert.equal(f.service.view(f.w,f.run.id).canPrepare,true);const input=f.prepare(),candidate=f.service.prepare(input);
    assert.equal(candidate.status,'prepared');assert.equal(f.target.head,input.expectedTargetHead);assert.equal(f.counts().applyCalls,0);
    assert.equal(f.service.prepare(input).id,candidate.id);assert.equal(f.counts().prepareCalls,1);
    assert.throws(()=>f.service.prepare({...input,expectedTargetBranch:'other'}),/IDEMPOTENCY_CONFLICT/);
    const apply={requestId:randomUUID(),recordId:candidate.id,expectedCommitSha:candidate.candidate!.commitSha,confirmed:true};
    assert.throws(()=>f.service.apply({...apply,confirmed:false}),/MERGE_CONFIRMATION_REQUIRED/);assert.equal(f.counts().applyCalls,0);
    const result=f.service.apply(apply);assert.equal(result.status,'applied');assert.equal(result.completionBasis,'git_and_bytes');assert.equal(f.service.apply(apply).id,result.id);assert.equal(f.counts().applyCalls,1);
    assert.doesNotMatch(JSON.stringify(f.store.eventsAfter(0).filter(event=>event.kind.startsWith('merge.'))),/PRIVATE_|approved bytes|never-accessed/);
  }finally{f.store.close();}
});
test('missing/currently invalid approval, context overrides and busy state fail before any candidate Git write',()=>{
  const f=fixture();try{
    f.view.approvalCurrent=false;assert.equal(f.service.view(f.w,f.run.id).canPrepare,false);assert.throws(()=>f.service.prepare(f.prepare()),/MERGE_VERIFICATION_REQUIRED/);
    f.view.approvalCurrent=true;f.setBusy(true);assert.throws(()=>f.service.prepare(f.prepare()),/MERGE_BUSY/);f.setBusy(false);
    assert.throws(()=>f.service.prepare({...f.prepare(),path:'foreign'} as any),/INVALID_FIELDS/);
    assert.throws(()=>f.service.prepare({...f.prepare(),runId:randomUUID()}),/MERGE_CONTEXT_MISMATCH/);
    assert.throws(()=>f.service.prepare({...f.prepare(),expectedApprovalId:randomUUID()}),/MERGE_PREVIEW_STALE/);
    assert.equal(f.counts().prepareCalls,0);
  }finally{f.store.close();}
});
test('source or target changes invalidate preparation/apply without losing the retained candidate',()=>{
  const f=fixture();try{
    const record=f.service.prepare(f.prepare());f.setSource('e'.repeat(64));
    assert.throws(()=>f.service.apply({requestId:randomUUID(),recordId:record.id,expectedCommitSha:record.candidate!.commitSha,confirmed:true}),/MERGE_VERIFICATION_REQUIRED|MERGE_PREVIEW_STALE/);
    f.setSource('b'.repeat(64));f.target.head='9'.repeat(40);
    assert.throws(()=>f.service.apply({requestId:randomUUID(),recordId:record.id,expectedCommitSha:record.candidate!.commitSha,confirmed:true}),/MERGE_PREVIEW_STALE/);
    assert.equal(f.service.record(record.id).status,'prepared');assert.equal(f.counts().applyCalls,0);
  }finally{f.store.close();}
  const raced=fixture();try{
    raced.changeOnPrepare();const record=raced.service.prepare(raced.prepare());assert.equal(record.status,'failed');assert.ok(record.candidate);assert.equal(raced.counts().applyCalls,0);
  }finally{raced.store.close();}
  const lastCheck=fixture();try{
    const record=lastCheck.service.prepare(lastCheck.prepare());lastCheck.changeOnVerify();
    assert.throws(()=>lastCheck.service.apply({requestId:randomUUID(),recordId:record.id,expectedCommitSha:record.candidate!.commitSha,confirmed:true}),/MERGE_VERIFICATION_REQUIRED|MERGE_PREVIEW_STALE/);
    assert.equal(lastCheck.counts().applyCalls,0,'source changed during candidate object verification must be rechecked before target writes');
  }finally{lastCheck.store.close();}
});
test('uncertain apply is quarantined and recovery only observes after explicit process-stop attestation',()=>{
  const f=fixture();try{
    const record=f.service.prepare(f.prepare());f.setFailApply();const request={requestId:randomUUID(),recordId:record.id,expectedCommitSha:record.candidate!.commitSha,confirmed:true};
    const result=f.service.apply(request);assert.equal(result.status,'unknown');assert.equal(f.service.apply(request).status,'unknown');assert.equal(f.counts().applyCalls,1);
    const newer=f.store.createRun(randomUUID(),'another','synthetic later run',f.w);f.store.updateRun(newer.id,{execution:'completed'},'test');
    for(let index=0;index<21;index++){const extra={...record,id:randomUUID(),status:'prepared',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};f.store.db.prepare('INSERT INTO merge_records VALUES(?,?,?)').run(extra.id,extra.projectId,JSON.stringify(extra));}
    assert.equal(f.service.view(f.w,newer.id).records[0].id,record.id,'unresolved earlier-Run records remain visible before the latest 20 records so the UI can recover them');
    assert.throws(()=>f.service.ensureAvailable(f.w),/MERGE_RECOVERY_REQUIRED/);
    assert.throws(()=>f.service.recover({recordId:record.id,confirmedStopped:false}),/MERGE_CONFIRMATION_REQUIRED/);
    f.setOutcome('unknown');assert.equal(f.service.recover({recordId:record.id,confirmedStopped:true}).status,'unknown');
    f.setOutcome('applied');const recovered=f.service.recover({recordId:record.id,confirmedStopped:true});assert.equal(recovered.status,'applied');assert.equal(recovered.completionBasis,'observed_after_recovery');
    f.service.ensureAvailable(f.w);assert.equal(f.counts().applyCalls,1);assert.doesNotMatch(JSON.stringify(recovered),/PRIVATE_GIT_ERROR/);
  }finally{f.store.close();}
});
test('restart records interrupted apply as lost without automatically invoking Git or resending the request',()=>{
  const db=join(mkdtempSync(join(tmpdir(),'orbit-merge-service-')),'test.sqlite'),f=fixture(db);
  const input=f.prepare(),record=f.service.prepare(input);
  f.store.db.prepare('UPDATE merge_records SET body=? WHERE id=?').run(JSON.stringify({...record,phase:'apply',status:'applying'}),record.id);f.store.close();
  const reopened=new Store(db);try{
    const fail=()=>{throw new Error('restart must not call Git');};
    const service=new MergeService(reopened,f.projects,f.verification,()=>false,{...f.git,inspectMergeTarget:fail,prepareMergeCandidate:fail,applyMergeCandidate:fail,observeMergeApplication:fail});
    assert.equal(service.record(record.id).status,'lost');assert.equal(service.prepare(input).status,'lost');assert.throws(()=>service.ensureAvailable(f.w),/MERGE_RECOVERY_REQUIRED/);
    assert.equal(f.counts().applyCalls,0);
  }finally{reopened.close();}
});
