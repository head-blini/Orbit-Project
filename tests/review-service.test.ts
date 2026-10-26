import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import type {Projects} from '../server/projects.ts';
import type {WorkspaceDiff} from '../shared/types.ts';
import type {NativeReviewResult,runCodexReview} from '../server/codex-review.ts';
import {ReviewService} from '../server/review-service.ts';

function fixture(w=randomUUID(),p=randomUUID()){
  const store=new Store(':memory:');let source='a'.repeat(64),busy=false,calls=0;
  const path=process.platform==='win32'?'C:\\Projects\\ReviewFixture':'/projects/review-fixture';
  store.saveProject({id:p,name:'Review fixture',path,createdAt:'',writeEnabled:true});store.saveWorkspace({id:w,projectId:p,path,branch:'orbit/review',baseSha:'b'.repeat(40),createdAt:'',status:'ready'});
  const diff:WorkspaceDiff={workspaceId:w,baseSha:'b'.repeat(40),files:[{path:'index.ts',status:'modified',patch:'diff --git a/index.ts b/index.ts\n--- a/index.ts\n+++ b/index.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n'}]};
  const projects={writable:(id:string)=>{assert.equal(id,w);return store.workspaces()[0];},fingerprint:()=>source,diff:()=>structuredClone(diff)} as unknown as Projects;
  const success=():NativeReviewResult=>({execution:'completed',threadId:'thread-fixture',turnId:'turn-fixture',response:'No concrete finding in the supplied diff.',issue:null,processStopped:true});
  let behavior:typeof runCodexReview=async input=>{input.onStarted?.({threadId:'thread-fixture',turnId:'turn-fixture'});return success();};
  function create(run?:typeof runCodexReview){return new ReviewService(store,projects,()=>{throw new Error('NO_NATIVE_PROCESS');},()=>busy,()=>{},async(input,factory)=>{calls++;return (run??behavior)(input,factory);});}
  const service=create(),input=()=>({requestId:randomUUID(),workspaceId:w,runId:null,expectedPreviewDigest:service.preview(w,null).previewDigest,confirmed:true});
  return {store,projects,service,create,input,success,diff,p,w,get calls(){return calls;},setSource:(value:string)=>{source=value;},setBusy:(value:boolean)=>{busy=value;},setBehavior:(value:typeof behavior)=>{behavior=value;}};
}

test('review preview is inert, explicit execution is source-bound and receipt replay creates no second review or verification',async()=>{
  const f=fixture();try{
    const preview=f.service.preview(f.w,null);assert.match(preview.instructions,/index\.ts/);assert.equal(f.calls,0);assert.equal(preview.turnLimit,1);
    const input=f.input();assert.throws(()=>f.service.start({...input,confirmed:false}),/REVIEW_CONFIRMATION_REQUIRED/);
    const record=f.service.start(input);assert.equal(record.execution,'running');assert.equal(f.service.start(input).id,record.id);await f.service.settle();
    const result=f.service.record(record.id);assert.equal(result.execution,'completed');assert.equal(result.processStopped,true);assert.equal(result.finishedDigest,preview.sourceDigest);assert.equal(f.calls,1);
    assert.equal(f.service.start(input).id,record.id);assert.equal(f.calls,1);assert.equal(f.store.runs().length,0);
    assert.equal(f.service.start(Object.fromEntries(Object.entries(input).reverse()) as typeof input).id,record.id,'receipt identity ignores JSON object key order');
    assert.throws(()=>f.service.start({...input,runId:randomUUID()}),/IDEMPOTENCY_CONFLICT/);
    const saved=JSON.stringify(f.store.db.prepare('SELECT body FROM native_reviews').all())+JSON.stringify(f.store.eventsAfter(0));assert.ok(!saved.includes('export const value'));
  }finally{await f.service.close();f.store.close();}
});

test('stale previews, changed diffs, unknown fields and busy state block before the native runner',async()=>{
  const f=fixture();try{
    const input=f.input();f.setSource('c'.repeat(64));assert.throws(()=>f.service.start(input),/REVIEW_PREVIEW_STALE/);f.setSource('a'.repeat(64));
    f.diff.files[0].patch+='ordinary additional line';assert.throws(()=>f.service.start(input),/REVIEW_PREVIEW_STALE/);
    assert.throws(()=>f.service.start({...f.input(),instructions:'override'} as any),/INVALID_FIELDS/);
    f.setBusy(true);assert.throws(()=>f.service.preview(f.w,null),/REVIEW_BUSY/);assert.equal(f.calls,0);
  }finally{await f.service.close();f.store.close();}
});

test('source identity remains in local preview binding when the outbound diff payload omits identifiers',async()=>{
  const f=fixture();try{
    const input=f.input(),before=f.service.preview(f.w,null);
    const baseSha='a01012345678'+'b'.repeat(28);
    f.store.saveWorkspace({...f.store.workspaces()[0],baseSha});f.diff.baseSha=baseSha;
    const after=f.service.preview(f.w,null);
    assert.equal(after.baseSha,baseSha);assert.equal(after.workspaceId,f.w);
    assert.equal(after.inputDigest,before.inputDigest);assert.equal(after.instructions,before.instructions);
    assert.notEqual(after.previewDigest,before.previewDigest);
    assert.ok(!after.instructions.includes(baseSha)&&!after.instructions.includes(f.w));
    assert.throws(()=>f.service.start(input),/REVIEW_PREVIEW_STALE/);assert.equal(f.calls,0);
  }finally{await f.service.close();f.store.close();}
});

test('identical outbound diffs cannot reuse approval across two workspaces in the same project',async()=>{
  const a=fixture(),b=fixture(randomUUID(),a.p);try{
    const first=a.service.preview(a.w,null),second=b.service.preview(b.w,null);
    assert.equal(first.projectId,second.projectId);assert.equal(first.baseSha,second.baseSha);assert.equal(first.sourceDigest,second.sourceDigest);
    assert.equal(first.inputDigest,second.inputDigest);assert.notEqual(first.previewDigest,second.previewDigest);
    assert.throws(()=>b.service.start({...b.input(),expectedPreviewDigest:first.previewDigest}),/REVIEW_PREVIEW_STALE/);
    assert.equal(a.calls,0);assert.equal(b.calls,0);
  }finally{await a.service.close();await b.service.close();a.store.close();b.store.close();}
});

test('source changes during review become stale and unknown process closure quarantines without replay',async()=>{
  const f=fixture();let restored:ReviewService|undefined;try{
    f.setBehavior(async()=>{f.setSource('c'.repeat(64));return f.success();});const first=f.service.start(f.input());await f.service.settle();assert.equal(f.service.record(first.id).execution,'stale');
    f.setBehavior(async()=>({...f.success(),execution:'lost',processStopped:false,response:'',issue:'REVIEW_PROCESS_UNCERTAIN'}));const lost=f.service.start(f.input());await f.service.settle();
    assert.equal(f.service.view(f.w,null).recoveryRequired,true);assert.throws(()=>f.service.ensureAvailable(f.w),/REVIEW_RECOVERY_REQUIRED/);
    assert.throws(()=>f.service.recover({reviewId:lost.id,confirmedStopped:false}),/REVIEW_STOP_CONFIRMATION_REQUIRED/);
    f.service.recover({reviewId:lost.id,confirmedStopped:true});assert.equal(f.service.record(lost.id).execution,'lost');assert.equal(f.service.view(f.w,null).recoveryRequired,false);
    f.store.db.prepare('UPDATE native_reviews SET body=? WHERE id=?').run(JSON.stringify({...f.service.record(first.id),execution:'running',processStopped:false}),first.id);
    const count=f.calls;restored=f.create();assert.equal(restored.record(first.id).execution,'lost');assert.equal(f.calls,count);assert.equal(restored.view(f.w,null).recoveryRequired,true);
  }finally{await restored?.close();await f.service.close();f.store.close();}
});

test('interrupt reaches the owned runner, and final source/response boundaries never fabricate completion',async()=>{
  const f=fixture();try{
    let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
    f.setBehavior(async input=>{started();await new Promise<void>(resolve=>{if(input.signal?.aborted)resolve();else input.signal?.addEventListener('abort',()=>resolve(),{once:true});});return {...f.success(),execution:'interrupted',response:'',issue:'REVIEW_INTERRUPTED'};});
    const record=f.service.start(f.input());await ready;assert.throws(()=>f.service.recover({reviewId:record.id,confirmedStopped:true}),/REVIEW_RECOVERY_UNAVAILABLE/);
    f.service.interrupt(f.w,record.id);await f.service.settle();assert.equal(f.service.record(record.id).execution,'interrupted');assert.equal(f.service.active,false);
    f.setBehavior(async()=>({...f.success(),response:'api_key=synthetic-secret'}));const redacted=f.service.start(f.input());await f.service.settle();assert.ok(!f.service.record(redacted.id).response.includes('synthetic-secret'));
    f.setBehavior(async()=>({...f.success(),response:''}));const empty=f.service.start(f.input());await f.service.settle();assert.equal(f.service.record(empty.id).execution,'failed');
  }finally{await f.service.close();f.store.close();}
});

test('an edit after durable intent but before native launch prevents the model call',async()=>{
  const f=fixture();try{
    const record=f.service.start(f.input());f.setSource('d'.repeat(64));await f.service.settle();
    const result=f.service.record(record.id);assert.equal(f.calls,0);assert.equal(result.execution,'stale');assert.equal(result.processStopped,true);assert.equal(result.threadId,null);
  }finally{await f.service.close();f.store.close();}
});

test('unresolved old review remains recoverable behind recent history and quota rejects before native launch',async()=>{
  const f=fixture();try{
    const first=f.service.start(f.input());await f.service.settle();const record=f.service.record(first.id);
    for(let i=0;i<99;i++){const next={...record,id:randomUUID(),requestId:randomUUID()};f.store.db.prepare('INSERT INTO native_reviews VALUES(?,?,?,?,?)').run(next.id,next.requestId,'fixture',next.projectId,JSON.stringify(next));}
    f.store.db.prepare('UPDATE native_reviews SET body=? WHERE id=?').run(JSON.stringify({...record,execution:'lost',processStopped:false}),record.id);
    assert.equal(f.service.view(f.w,null).records[0].id,record.id);assert.equal(f.service.view(f.w,null).records.length,20);
    f.service.recover({reviewId:record.id,confirmedStopped:true});const calls=f.calls;
    assert.throws(()=>f.service.start(f.input()),/REVIEW_HISTORY_QUOTA/);assert.equal(f.calls,calls);assert.equal(f.service.active,false);
  }finally{await f.service.close();f.store.close();}
});
