import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import type {Projects} from '../server/projects.ts';
import {parsePlanningProposal} from '../server/planning/agent-input.ts';
import type {runCodexPlanning,NativePlanningResult} from '../server/codex-planning.ts';
const module=await import('../server/planning-agent-service.ts').catch(()=>null);
function fixture(){
  assert.ok(module,'planning service implementation required');const store=new Store(':memory:'),p=randomUUID(),w=randomUUID();let calls=0,busy=false;
  store.saveProject({id:p,name:'fixture',path:'/unused',createdAt:'',writeEnabled:false});store.saveWorkspace({id:w,projectId:p,path:process.platform==='win32'?'C:\\PlanningFixture':'/planning-fixture',branch:'orbit/'+w,baseSha:'b'.repeat(40),createdAt:'',status:'ready'});
  const projects={validate:(id:string)=>{assert.equal(id,w);return store.workspaces()[0];}} as unknown as Projects;
  const proposal=parsePlanningProposal(JSON.stringify({schema_version:'1.0',title:'Proposed plan',goal:'Preserve local state',requirements:[{id:'R1',description:'Keep state',acceptance_criteria:['Restore state']}],constraints:[],open_questions:[],decisions:[]}));
  const success=():NativePlanningResult=>({execution:'completed',threadId:'planning-thread',turnId:'planning-turn',proposal:structuredClone(proposal),issue:null,processStopped:true});
  let run:typeof runCodexPlanning=async input=>{input.onStarted?.({threadId:'planning-thread',turnId:'planning-turn'});return success();};
  const make=()=>new module.PlanningAgentService(store,projects,()=>{throw new Error('NO_NATIVE_CALL');},()=>busy,()=>{},async(input,factory)=>{calls++;return run(input,factory);});
  const service=make(),text='PRIVATE_REQUEST_MARKER Plan an offline workspace',input=()=>({requestId:randomUUID(),workspaceId:w,text,expectedPreviewDigest:service.preview(p,{workspaceId:w,text}).previewDigest,confirmed:true});
  return {store,service,make,p,w,text,input,success,get calls(){return calls;},setBusy:(v:boolean)=>{busy=v;},setRun:(v:typeof run)=>{run=v;}};
}
test('preview is inert, launch receipt does not repeat inference, and proposal save separately creates one unapproved draft',async()=>{
  const f=fixture();try{
    const input=f.input();assert.equal(f.calls,0);assert.throws(()=>f.service.start(f.p,{...input,confirmed:false}),/PLANNING_CONFIRMATION_REQUIRED/);
    const started=f.service.start(f.p,input);assert.equal(started.execution,'running');assert.equal(f.service.start(f.p,input).id,started.id);await f.service.settle();
    const result=f.service.record(started.id);assert.equal(result.execution,'completed');assert.equal(f.calls,1);
    const studio=new Studio(f.store);assert.deepEqual(studio.read(f.p,'plans'),[]);assert.equal(f.store.runs().length,0);
    assert.equal(f.service.start(f.p,Object.fromEntries(Object.entries(input).reverse()) as typeof input).id,result.id);assert.equal(f.calls,1);
    const save={workspaceId:f.w,expectedOutputDigest:result.outputDigest!};const draft=f.service.saveDraft(f.p,result.id,save);
    assert.equal(draft.state,'draft');assert.equal(draft.draft.title,'Proposed plan');assert.deepEqual(f.service.saveDraft(f.p,result.id,save),draft);
    assert.equal((studio.read(f.p,'plans') as unknown[]).length,1);assert.equal((studio.read(f.p,'tasks') as unknown[]).length,0);assert.equal(f.store.runs().length,0);
    assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT * FROM planning_suggestions').all())+JSON.stringify(f.store.eventsAfter(0)),/PRIVATE_REQUEST_MARKER/);
  }finally{await f.service.close();f.store.close();}
});
test('stale input, ownership, false consent, extra fields and busy state reject before inference',async()=>{
  const f=fixture();try{
    const input=f.input();assert.throws(()=>f.service.start(f.p,{...input,text:'Changed idea'}),/PLANNING_PREVIEW_STALE/);
    assert.throws(()=>f.service.start(f.p,{...input,approved:true} as any),/INVALID_FIELDS/);
    assert.throws(()=>f.service.preview(randomUUID(),{workspaceId:f.w,text:f.text}),/PROJECT_NOT_FOUND|WORKSPACE_MISMATCH/);
    f.setBusy(true);assert.throws(()=>f.service.start(f.p,input),/PLANNING_BUSY/);assert.equal(f.calls,0);
  }finally{await f.service.close();f.store.close();}
});
test('invalid sensitive runner proposals cannot be saved and unconfirmed closure quarantines until explicit recovery',async()=>{
  const f=fixture();try{
    f.setRun(async()=>{const result=f.success();result.proposal!.goal='person@example.invalid';return result;});const failed=f.service.start(f.p,f.input());await f.service.settle();
    assert.equal(f.service.record(failed.id).execution,'failed');assert.equal(f.service.record(failed.id).proposal,null);
    assert.doesNotMatch(JSON.stringify(f.store.db.prepare('SELECT * FROM planning_suggestions').all()),/person@example.invalid/);
    f.setRun(async()=>({...f.success(),processStopped:false}));const lost=f.service.start(f.p,f.input());await f.service.settle();
    assert.equal(f.service.record(lost.id).execution,'lost');assert.equal(f.service.record(lost.id).proposal,null);assert.throws(()=>f.service.ensureAvailable(f.w),/PLANNING_RECOVERY_REQUIRED/);
    assert.throws(()=>f.service.recover(f.p,{workspaceId:f.w,suggestionId:lost.id,confirmedStopped:false}),/PLANNING_STOP_CONFIRMATION_REQUIRED/);
    f.service.recover(f.p,{workspaceId:f.w,suggestionId:lost.id,confirmedStopped:true});assert.equal(f.service.view(f.p,f.w).recoveryRequired,false);assert.equal(f.service.record(lost.id).execution,'lost');
  }finally{await f.service.close();f.store.close();}
});
test('restart loses active work without replay and saving survives failure after Studio commits',async()=>{
  const f=fixture();try{
    const started=f.service.start(f.p,f.input());await f.service.settle();const result=f.service.record(started.id),body={workspaceId:f.w,expectedOutputDigest:result.outputDigest!};
    f.store.db.exec("CREATE TRIGGER fail_link BEFORE UPDATE ON planning_suggestions BEGIN SELECT RAISE(ABORT,'synthetic link failure'); END;");
    assert.throws(()=>f.service.saveDraft(f.p,result.id,body),/synthetic link failure/);
    f.store.db.exec('DROP TRIGGER fail_link');const saved=f.service.saveDraft(f.p,result.id,body);assert.equal((new Studio(f.store).read(f.p,'plans') as unknown[]).length,1);assert.equal(saved.state,'draft');
    f.store.db.prepare('UPDATE planning_suggestions SET body=? WHERE id=?').run(JSON.stringify({...f.service.record(result.id),execution:'running',processStopped:false}),result.id);
    const restored=f.make();assert.equal(restored.record(result.id).execution,'lost');assert.equal(f.calls,1);assert.equal(restored.view(f.p,f.w).recoveryRequired,true);await restored.close();
  }finally{await f.service.close();f.store.close();}
});
test('interrupt reaches only the owned suggestion and clears busy after observed completion',async()=>{
  const f=fixture();try{
    let ready!:()=>void;const begun=new Promise<void>(resolve=>{ready=resolve;});f.setRun(async input=>{ready();await new Promise<void>(resolve=>input.signal!.addEventListener('abort',()=>resolve(),{once:true}));return {...f.success(),execution:'interrupted',proposal:null,issue:'PLANNING_INTERRUPTED'};});
    const run=f.service.start(f.p,f.input());await begun;assert.equal(f.service.active,true);assert.throws(()=>f.service.interrupt(f.p,run.id,randomUUID()),/WORKSPACE_MISMATCH/);
    f.service.interrupt(f.p,run.id,f.w);await f.service.settle();assert.equal(f.service.active,false);assert.equal(f.service.record(run.id).execution,'interrupted');
  }finally{await f.service.close();f.store.close();}
});

test('durable launch rechecks its preview workspace and receipt identity before any native call',async()=>{
  const f=fixture();try{
    const input=f.input(),run=f.service.start(f.p,input);
    assert.throws(()=>f.service.start(f.p,{...input,text:'Different valid request'}),/IDEMPOTENCY_CONFLICT/);
    f.store.saveWorkspace({...f.store.workspaces()[0],baseSha:'c'.repeat(40)});await f.service.settle();
    assert.equal(f.calls,0);assert.equal(f.service.record(run.id).execution,'failed');assert.equal(f.service.record(run.id).processStopped,true);
  }finally{await f.service.close();f.store.close();}
});

test('proposal hash tampering and finite project history block saves and launches without producing work',async()=>{
  const f=fixture();try{
    const run=f.service.start(f.p,f.input());await f.service.settle();const complete=f.service.record(run.id);
    assert.throws(()=>f.service.saveDraft(f.p,run.id,{workspaceId:f.w,expectedOutputDigest:'0'.repeat(64)}),/PLANNING_PROPOSAL_STALE/);
    f.store.db.prepare('UPDATE planning_suggestions SET body=? WHERE id=?').run(JSON.stringify({...complete,outputDigest:'f'.repeat(64)}),run.id);
    assert.throws(()=>f.service.saveDraft(f.p,run.id,{workspaceId:f.w,expectedOutputDigest:'f'.repeat(64)}),/PLANNING_PROPOSAL_STALE/);
    for(let i=0;i<99;i++){const next={...complete,id:randomUUID(),requestId:randomUUID()};f.store.db.prepare('INSERT INTO planning_suggestions VALUES(?,?,?,?,?)').run(next.id,next.requestId,'fixture',f.p,JSON.stringify(next));}
    assert.throws(()=>f.service.start(f.p,f.input()),/PLANNING_HISTORY_QUOTA/);assert.equal(f.calls,1);
    assert.equal((new Studio(f.store).read(f.p,'plans') as unknown[]).length,0);assert.equal(f.store.runs().length,0);
  }finally{await f.service.close();f.store.close();}
});

test('background persistence failure is observed and quarantined in memory until explicit durable recovery',async()=>{
  const f=fixture();try{
    f.store.db.exec("CREATE TRIGGER fail_background BEFORE UPDATE ON planning_suggestions BEGIN SELECT RAISE(ABORT,'synthetic durable failure'); END;");
    const run=f.service.start(f.p,f.input());await assert.doesNotReject(f.service.settle());
    assert.equal(f.service.active,false);assert.equal(f.service.record(run.id).execution,'lost');assert.equal(f.service.record(run.id).proposal,null);
    assert.equal(f.service.view(f.p,f.w).recoveryRequired,true);assert.throws(()=>f.service.ensureAvailable(f.w),/PLANNING_RECOVERY_REQUIRED/);
    assert.throws(()=>f.service.recover(f.p,{workspaceId:f.w,suggestionId:run.id,confirmedStopped:true}),/synthetic durable failure/);
    assert.equal(f.service.view(f.p,f.w).recoveryRequired,true);
    f.store.db.exec('DROP TRIGGER fail_background');f.service.recover(f.p,{workspaceId:f.w,suggestionId:run.id,confirmedStopped:true});
    assert.equal(f.service.view(f.p,f.w).recoveryRequired,false);assert.equal(f.service.record(run.id).execution,'lost');
    const restored=f.make();assert.equal(restored.record(run.id).execution,'lost');assert.equal(restored.view(f.p,f.w).recoveryRequired,false);assert.equal(f.calls,1);await restored.close();
  }finally{await f.service.close();f.store.close();}
});
