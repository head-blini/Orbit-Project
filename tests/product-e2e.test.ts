/**
 * PRODUCT P8 / A16 / AX07: fake-only product journeys through the real HTTP handler,
 * Controller, SQLite, planning, workers, CQG, verification and integration services.
 * Proves request/material/depth/question/approval binding, parallel general roots,
 * graph/worker/queue and P7 view-model agreement, P4/P5 bytes/history, P6 completion,
 * CSRF/Origin rejection, mock non-success and preservation of unrelated fixture data.
 * Native-shaped observations, where explicitly enabled, use trusted reader seams cited
 * below; they are NOT live evidence. Local commands run only in disposable projects.
 * Live CLI/model identity, independent semantic review, browser interactions and full
 * A16/AX07 acceptance still require separately approved live runs. No listener/network.
 * Observed product gaps (asserted, not patched): uploaded/general inherited inputs can
 * fail WORKER_INPUTS_CHANGED (CQG-6B-CTL); general candidate semantic evidence is required
 * (GENERAL-ACCEPT-B); refreshed execution approval is required after PLAN_CHANGED;
 * code material/download APIs require GENERAL_PROJECT_REQUIRED;
 * code candidates reach CQG but source artifactDigest binding still mismatches.
 * General integrated versions have no producing run/task, so P6 omits their references.
 * No-upload general continuations are separate scenarios, not a passed material journey.
 * Local command categories are a synthetic host policy, not production lint/build/E2E proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {productFixture,until,type ProductFixture} from './product-e2e-fixture.ts';
import {outcome} from './claude-task-fixture.ts';
import {Studio} from '../server/studio.ts';
import {trustedGit} from '../server/git-process.ts';
import {completionView,plainStatus,verifiedTaskCount} from '../web/project-work-model.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {ProjectProgress} from '../shared/project-progress.ts';

const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
// Missing producer capture is distinct from a missing current task binding.
const mockGeneralReasons=[
  'CQG_AI_NATIVE_REQUIRED',
  ...['acceptanceDigest','artifactDigest','artifactId','artifactScope','configDigest','contractDigest','graphRevision','inputSnapshotDigest','planningContentHash','planningVersionId','policyDigest','projectId','runId','taskId'].map(key=>'CQG_BINDING_MISSING:'+key),
  'CQG_EXECUTION_NOT_OBSERVED_COMPLETE','CQG_GATE_EVIDENCE_MISSING','CQG_INDEPENDENT_REVIEW_REQUIRED',
  'CQG_MODEL_OBSERVATION_REQUIRED','CQG_PRODUCER_RUN_MISMATCH','CQG_REVIEW_MISSING','CQG_SEMANTIC_REVIEW_REQUIRED',
  'EXECUTION_MOCK','EXECUTION_OBSERVATION_UNAVAILABLE','QUALITY_EVIDENCE_MISSING',
].sort();

async function planAndSubmit(f:ProductFixture,count:number,upload=false){
  const {base,post,get,store,controller}=f,studio=new Studio(store);
  const other=f.projects.createProject({requestId:randomUUID(),name:'Existing unrelated data',kind:'general'}).project;
  writeFileSync(join(other.path,'existing.txt'),'preserve existing bytes');
  const old=studio.mutate(other.id,'plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Existing',goal:'Preserve data',requirements:[{id:'OLD',description:'Keep data',acceptance_criteria:['Unchanged']}],constraints:[],open_questions:[]})}});
  const storedOther=store.projects().find(p=>p.id===other.id);
  const unchanged=()=>{assert.deepEqual(store.projects().find(p=>p.id===other.id),storedOther);assert.deepEqual(studio.read(other.id,'plans'),[old]);assert.equal(readFileSync(join(other.path,'existing.txt'),'utf8'),'preserve existing bytes');assert.equal(store.runs().filter(r=>r.projectId===other.id).length,0);};
  if(f.project.kind==='general'&&upload){
    const materials=await post(base+'/materials',{files:[{name:'source.txt',text:'Source count: 42\n'}]});
    assert.deepEqual(await get(base+'/materials'),materials);assert.equal(readFileSync(join(f.project.path,'inputs/source.txt'),'utf8'),'Source count: 42\n');
  }else if(f.project.kind==='code'){
    // Current material upload is general-only; preserve the gap, supply code context in the request.
    const rejected=await f.request('POST',base+'/materials',{files:[{name:'source.txt',text:'Source count: 42\n'}]});
    assert.equal(rejected.status,409);assert.equal(rejected.body.error,'GENERAL_PROJECT_REQUIRED');
  }
  await post(base+'/ai-preferences',{expectedRevision:0,planning:'claude-code',execution:f.project.kind==='code'?'codex':'claude-code'});
  const text='Source count: 42. Use the supplied source count to produce an offline evidence report. Preserve existing data.';
  const preview=await post(base+'/planning-suggestions/preview',{text,...(f.workspace?{workspaceId:f.workspace.id}:{})});
  const input={requestId:randomUUID(),text,expectedPreviewDigest:preview.previewDigest,confirmed:true,...(f.workspace?{workspaceId:f.workspace.id}:{})};
  const started=await post(base+'/planning-suggestions/start',input);
  assert.equal((await post(base+'/planning-suggestions/start',input)).id,started.id);
  await until(()=>f.planners.length===1,'fake planner dispatch');
  const proposal={schema_version:'1.0',title:'Evidence report',goal:text,depth:'detailed',depth_reason:'Trace source and result',risks:['Source may be incomplete'],
    requirements:Array.from({length:count},(_,i)=>({id:'R'+(i+1),description:i===2?'Summarize dependent evidence':'Write evidence '+(i+1),acceptance_criteria:['Cite evidence']})),
    constraints:['Local files only'],non_goals:['Publish externally'],decisions:[],open_questions:['Which format?']};
  f.planners[0].finish(outcome('completed',{response:JSON.stringify(proposal)}));await controller.planningSuggestions.settle();
  const suggestion=controller.planningSuggestions.record(started.id);assert.equal(suggestion.execution,'completed');
  assert.deepEqual(studio.read(f.project.id,'plans'),[]);
  const draft:PlanningVersion=await post(base+'/planning-suggestions/'+started.id+'/save',{expectedOutputDigest:suggestion.outputDigest,...(f.workspace?{workspaceId:f.workspace.id}:{})});
  assert.equal(draft.draft.depth,'detailed');assert.deepEqual(draft.draft.openQuestions,['Which format?']);assert.deepEqual(await get(base+'/plans'),studio.read(f.project.id,'plans'));
  // Answer via the existing revision API; preserve the unanswered proposal as history.
  const revised:PlanningVersion=await post(base+'/plans/'+draft.id+'/revisions',{requestId:randomUUID(),expectedRevision:1,input:{format:'json',source:'manual',text:JSON.stringify({...proposal,open_questions:[],decisions:[{topic:'Which format?',decision:'Use Markdown',rationale:'Readable offline'}]})}});
  const approved:PlanningVersion=await post(base+'/plans/'+revised.id+'/approve',{expectedRevision:2});
  assert.equal(approved.state,'approved');assert.notEqual(approved.contentHash,draft.contentHash);
  assert.deepEqual((await get(base+'/plans')).find((p:PlanningVersion)=>p.id===draft.id),{...draft,state:'superseded'});
  const tasks:SavedTask[]=await post(base+'/plans/'+approved.id+'/task-drafts',{});
  assert.equal(tasks.length,count);assert.deepEqual(await get(base+'/tasks'),studio.read(f.project.id,'tasks'));
  const graph=await post(base+'/task-graphs/'+approved.id+'/revisions',{contentHash:approved.contentHash,expectedRevision:0,nodes:tasks.map(t=>({taskId:t.id,...(f.project.kind==='code'?{impactScope:{files:['result.txt'],resources:[]}}:{})})),edges:count===3?[{taskId:tasks[2].id,dependsOn:tasks[0].id}]:[]});
  assert.equal(graph.revision,1);
  const goal=await post(base+'/goals',{requestId:randomUUID(),planningVersionId:approved.id,expectedPlanningHash:approved.contentHash});
  const plans=[];
  for(const task of tasks){
    const route=await post(base+'/capability-routes',{requestId:randomUUID(),taskId:task.id,text:f.project.kind==='code'?'코드 구현':'문서 작성'});
    const acceptance=f.workspace?(await get(base+'/tasks/'+task.id+'/verification-preview?workspaceId='+f.workspace.id)).preview:null;
    const execution=await post(base+'/capability-executions',{requestId:randomUUID(),routeId:route.id,...(f.workspace?{workspaceId:f.workspace.id,expectedAcceptanceDigest:acceptance.digest}:{})});
    plans.push(execution);
  }
  const batch=await post(base+'/worker-batches',{requestId:randomUUID(),planningVersionId:approved.id,graphRevision:1,planningHash:approved.contentHash,confirmed:true,executions:plans.map(p=>({executionId:p.id,expectedPlanDigest:p.planDigest}))});
  const request={requestId:randomUUID()};await post(base+'/worker-batches/'+batch.id+'/submit',request);
  await post(base+'/worker-batches/'+batch.id+'/submit',request);
  unchanged();return {approved,tasks,batch,goal,unchanged};
}
async function views(f:ProductFixture,flow:Awaited<ReturnType<typeof planAndSubmit>>){
  const before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const progress:ProjectProgress=await f.get(f.base+'/progress'),graph=await f.get(f.base+'/task-graphs/'+flow.approved.id+'/state');
  const workers=await f.get(f.base+'/worker-batches/'+flow.batch.id),queue=await f.get(f.base+'/integration-queue');
  assert.deepEqual(workers,JSON.parse(JSON.stringify(f.controller.workerBatch(f.project.id,flow.batch.id))));
  assert.deepEqual(queue,JSON.parse(JSON.stringify(f.controller.workerIntegrationQueue(f.project.id))));
  assert.deepEqual(graph,f.controller.progress.graph(f.project.id,flow.approved.id).state);
  for(const task of progress.tasks){
    assert.deepEqual(task.completion,f.controller.progress.read(f.project.id,{}).tasks.find(t=>t.id===task.id)!.completion);
    assert.equal(completionView(task)!.done,task.completion!.verifiedDone);
    assert.equal(plainStatus(task).tone==='good',task.completion!.verifiedDone);
    for(const run of task.runs)assert.equal(run.execution,f.store.getRun(run.id)!.execution);
  }
  assert.equal(verifiedTaskCount(progress),progress.tasks.filter(t=>t.completion!.verifiedDone).length);
  for(const reservation of workers.reservations)assert.deepEqual(reservation,JSON.parse(String(f.store.db.prepare('SELECT body FROM worker_reservations WHERE id=?').get(reservation.reservationId)!.body)));
  for(const item of queue.items)assert.deepEqual(item,JSON.parse(String(f.store.db.prepare('SELECT body FROM integration_queue WHERE id=?').get(item.id)!.body)));
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before,'GET/view models must not write or dispatch');
  flow.unchanged();return {progress,graph,workers,queue};
}

test('P8 general: parallel fake Claude roots stay unverified; candidate, dependent, goals and downloads tell the truth',async t=>{
  const f=await productFixture('general');try{
    const flow=await planAndSubmit(f,3),running=await views(f,flow);
    assert.equal(f.runners.length,2,JSON.stringify(running.workers));assert.equal(running.workers.reservations.length,2);
    assert.ok(running.workers.reservations.every((r:any)=>r.state==='running'));
    assert.ok(running.workers.reasons.some((r:any)=>r.code==='WORKER_DEPENDENCIES_WAITING'));
    for(let i=0;i<2;i++)writeFileSync(join(running.workers.spaces[i].path,`output/report-${i+1}.md`),'Evidence: 42\n');
    for(const runner of f.runners)runner.finish(outcome('completed',{response:'Wrote evidence report'}));
    await until(()=>f.controller.workerIntegrationQueue(f.project.id).items.length===2&&f.controller.workerIntegrationQueue(f.project.id).items.every(i=>['refused','blocked'].includes(i.status)),'general candidate gates');
    const result=await views(f,flow);
    assert.equal(f.runners.length,2,'dependent cannot dispatch on mock completion');
    for(const task of result.progress.tasks.slice(0,2)){
      assert.equal(task.completion!.verifiedDone,false);
      assert.deepEqual(task.completion!.reasonCodes,mockGeneralReasons);
      assert.ok(task.completion!.reasonCodes.includes('CQG_EXECUTION_NOT_OBSERVED_COMPLETE'));
      assert.ok(task.completion!.gates.find(g=>g.id==='semantic_review')!.blockers.includes('CQG_SEMANTIC_REVIEW_REQUIRED'));
    }
    assert.deepEqual(result.queue.items.map((i:any)=>i.reason),['INTEGRATION_COMPLETION_EVIDENCE_REQUIRED','INTEGRATION_COMPLETION_EVIDENCE_REQUIRED']);
    assert.equal(existsSync(join(f.project.path,'output/report-1.md')),false);
    const goals=await f.get(f.base+'/goals');assert.equal(goals[0].verifiedDone,false);assert.equal(goals[0].goal.id,flow.goal.id);
    assert.deepEqual(goals[0].taskCompletions.map((v:any)=>v.completion),result.progress.tasks.map(v=>v.completion));
    t.diagnostic('general mock: INTEGRATION_COMPLETION_EVIDENCE_REQUIRED; CQG_SEMANTIC_REVIEW_REQUIRED; mock/model/binding gates remain blocked');
  }finally{await f.close();}
});

for(const nativeFixture of [false,true])test(`P8 code: real local checks and dev-only candidate gate (${nativeFixture?'trusted native-shaped identity fixture':'mock/unknown identity'})`,async t=>{
  const f=await productFixture('code',nativeFixture);try{
    const protectedHead=trustedGit(f.project.path,['rev-parse','main']).toString().trim(),devBefore=trustedGit(f.project.path,['rev-parse','dev']).toString().trim();
    const flow=await planAndSubmit(f,1),running=await views(f,flow),space=running.workers.spaces[0];
    assert.equal(running.workers.reservations.length,1);assert.equal(f.codex.reduce((n,r)=>n+r.starts,0),1,JSON.stringify({workers:running.workers,dispatchErrors:f.dispatchErrors}));
    writeFileSync(join(space.path,'result.txt'),'Evidence: 42\n');
    let checkId='',checkError:unknown;
    // Start the ordinary trusted Controller verification on terminal observation, before
    // the scheduled queue drain. The real VerificationService serializes both checks.
    f.store.on('event',event=>{if(event.kind!=='run.completed'||!event.runId)return;
      try{const view=f.controller.verification.view(space.workspaceId,event.runId);checkId=f.controller.startVerification({requestId:randomUUID(),workspaceId:space.workspaceId,runId:event.runId,commandId:'full',expectedSourceDigest:view.sourceDigest!,expectedConfigDigest:view.commands[0].configDigest}).id;}catch(e){checkError=e;}
    });
    f.codex.find(r=>r.starts)!.finish();
    await until(()=>!!checkId||!!checkError,'source verification launch');assert.ifError(checkError);
    await f.controller.verification.settle();
    await until(()=>f.controller.workerIntegrationQueue(f.project.id).items.some(i=>['applied','refused','blocked'].includes(i.status)),'code candidate gate');
    const result=await views(f,flow),item=result.queue.items[0],task=result.progress.tasks[0];
    const check=JSON.parse(String(f.store.db.prepare('SELECT body FROM verification_checks WHERE id=?').get(checkId)!.body));
    assert.equal(check.verdict,'passed');assert.equal(check.exitCode,0);
    assert.match(String(f.store.getRun(task.latestRunId!)!.acceptanceDigest),/^[a-f0-9]{64}$/);
    const candidateChecks=f.store.db.prepare('SELECT body FROM integration_checks').all().map(row=>JSON.parse(String(row.body))).filter(c=>c.integrationId===item.id);
    assert.equal(candidateChecks.length,1);assert.equal(candidateChecks[0].result.status,'passed');assert.equal(candidateChecks[0].result.exitCode,0);
    assert.equal(candidateChecks[0].sourceDigest,item.candidateDigest);
    assert.equal(candidateChecks[0].result.finishedDigest,item.candidateDigest);
    const httpCheck=await f.get(`/api/workspaces/${space.workspaceId}/verification?runId=${task.latestRunId}`);
    assert.deepEqual(httpCheck.checks.find((c:any)=>c.id===checkId),check);
    assert.equal(trustedGit(f.project.path,['rev-parse','main']).toString().trim(),protectedHead);
    t.diagnostic('code observed reasons: '+JSON.stringify({queue:item.reason,completion:task.completion!.reasonCodes}));
    assert.equal(task.completion!.verifiedDone,nativeFixture);
    if(!nativeFixture)for(const code of ['CQG_AI_NATIVE_REQUIRED','CQG_EXECUTION_NOT_OBSERVED_COMPLETE','CQG_MODEL_OBSERVATION_REQUIRED','EXECUTION_MOCK'])assert.ok(task.completion!.reasonCodes.includes(code),code);
    const run=f.store.getRun(task.latestRunId!)!;
    assert.equal(run.projectId,f.project.id);assert.equal(run.taskId,flow.tasks[0].id);assert.equal(run.runtime,'codex');
    if(nativeFixture)await t.test('code integration source finds the dispatch run and refuses other project/task/workspace ownership',()=>{
      const read=()=>Reflect.get(f.controller,'readIntegrationSource').call(f.controller,item);
      const before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
      assert.equal(read()?.binding.runId,run.id);
      assert.equal(read()?.verifiedDone,true);
      assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);
      for(const patch of [{projectId:randomUUID()},{taskId:randomUUID()},{workspaceId:randomUUID()}]){
        f.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify({...run,...patch}),run.id);
        assert.equal(read(),null);
      }
      f.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(run),run.id);
      assert.equal(read()?.binding.runId,run.id);
    });
    assert.equal(item.status,'refused');
    assert.equal(item.completion.verifiedDone,false);
    assert.ok(item.completion.reasonCodes.includes('CQG_SOURCE_BINDING_MISMATCH:artifactDigest'));
    assert.notEqual(item.manifest.sourceDigest,task.completion!.binding.artifactDigest);
    if(nativeFixture)assert.equal(item.reason,'INTEGRATION_COMPLETION_REFUSED:CQG_SOURCE_BINDING_MISMATCH:artifactDigest');
    else{
      assert.match(item.reason,/^INTEGRATION_COMPLETION_REFUSED:/);
      for(const code of ['CQG_SOURCE_NOT_VERIFIED_DONE','CQG_AI_NATIVE_REQUIRED','CQG_EXECUTION_NOT_OBSERVED_COMPLETE','CQG_MODEL_OBSERVATION_REQUIRED','EXECUTION_MOCK'])assert.ok(item.completion.reasonCodes.includes(code),code);
    }
    assert.equal(trustedGit(f.project.path,['rev-parse','dev']).toString().trim(),devBefore);
    assert.equal(existsSync(join(f.project.path,'result.txt')),false);
    const goal=(await f.get(f.base+'/goals'))[0];assert.equal(goal.verifiedDone,nativeFixture);assert.deepEqual(goal.taskCompletions[0].completion,task.completion);
    // P4/P5 is currently general-only; do not invent a code download route.
    const download=await f.request('GET',f.base+'/deliverables');assert.equal(download.status,409);t.diagnostic('code deliverables gap: '+JSON.stringify(download.body));
  }finally{await f.close();}
});

for(const semantic of [false,true])test(`P8 general: native-shaped review fixture, candidate semantic gate ${semantic?'present':'missing'}`,async t=>{
  const f=await productFixture('general',true,semantic);try{
    // Separate no-upload continuation: uploaded-material admission is tested below without bypass.
    const flow=await planAndSubmit(f,1),running=await views(f,flow);
    assert.equal(f.runners.length,1);
    writeFileSync(join(running.workers.spaces[0].path,'output/report-1.md'),'Evidence: 42\n');
    f.runners[0].finish(outcome('completed',{response:'Report written'}));
    await until(()=>f.controller.workerIntegrationQueue(f.project.id).items.some(i=>['applied','refused','blocked'].includes(i.status)),'general fixture candidate');
    const result=await views(f,flow),item=result.queue.items[0];
    t.diagnostic('general fixture observed reasons: '+JSON.stringify({queue:item.reason,completion:result.progress.tasks[0].completion!.reasonCodes}));
    assert.equal(item.status,semantic?'applied':'refused',item.reason);
    if(!semantic){assert.ok(item.reason.includes('CQG_SEMANTIC_REVIEW_REQUIRED'));assert.equal(existsSync(join(f.project.path,'output/report-1.md')),false);return;}
    const goal=(await f.get(f.base+'/goals'))[0];assert.equal(goal.verifiedDone,true);
    const list=await f.get(f.base+'/deliverables'),file=list.items.find((i:any)=>i.path==='output/report-1.md');assert.ok(file);
    assert.equal(file.sha256,hash(readFileSync(join(f.project.path,file.path))));assert.equal(file.checks.meaning,'unverified');
    const path=f.base+'/deliverables/'+file.id;
    assert.equal((await f.request('GET',path+'/download',undefined,{cookie:''})).status,401);
    assert.equal((await f.request('GET',path+'/download',undefined,{origin:'http://evil.invalid'})).status,403);
    const download=await f.request('GET',path+'/download');assert.equal(download.status,200);assert.equal(download.bytes.toString(),'Evidence: 42\n');assert.equal(download.headers['x-content-type-options'],'nosniff');
    await f.post(f.base+'/deliverables/observe',{});
    const first=await f.get(path+'/versions');assert.equal(first.length,1);assert.equal(first[0].sha256,hash(download.bytes));
    assert.deepEqual(first,f.controller.deliverableHistory(f.project.id,file.id));
    assert.equal((await f.request('GET',path+'/versions/'+first[0].id+'/download')).bytes.toString(),'Evidence: 42\n');
    // P5 stores observations, not archived bytes: old versions become unavailable after edits.
    writeFileSync(join(f.project.path,file.path),'Evidence: 42\nRevision two\n');await f.post(f.base+'/deliverables/observe',{});
    const history=await f.get(path+'/versions');assert.equal(history.length,2);assert.deepEqual(history,f.controller.deliverableHistory(f.project.id,file.id));
    assert.equal((await f.request('GET',path+'/versions/'+first[0].id+'/download')).status,409);
    assert.equal((await f.request('GET',path+'/download')).bytes.toString(),'Evidence: 42\nRevision two\n');
    // Completion observer runs before integration copies worker files; explicit observe
    // carries no producing run. P6 must omit unbound files instead of inventing provenance.
    assert.ok(history.every((v:any)=>v.runId===null&&v.taskId===null));
    assert.deepEqual((await f.get(f.base+'/goals'))[0].deliverables,[]);
    t.diagnostic('P6 gap: integrated general output history has null runId/taskId; goal deliverables omitted');
    flow.unchanged();
  }finally{await f.close();}
});

test('P8 general uploaded material: Controller input-hash admission gap never dispatches or fabricates success',async t=>{
  const f=await productFixture('general');try{
    const flow=await planAndSubmit(f,3,true),result=await views(f,flow);
    assert.equal(f.runners.length,0);assert.equal(f.store.runs().length,0);assert.equal(result.queue.items.length,0);
    assert.ok(result.workers.reservations.every((r:any)=>r.state==='released'&&r.evidence.kind==='not_dispatched'));
    assert.ok(result.progress.tasks.every(task=>!task.completion!.verifiedDone));
    const executions=await f.get(f.base+'/capability-executions');
    assert.equal(executions.records.filter((e:any)=>e.issue==='EXECUTION_DISPATCH_UNCONFIRMED').length,2);
    assert.deepEqual(f.dispatchErrors,['WORKER_INPUTS_CHANGED','WORKER_INPUTS_CHANGED']);
    t.diagnostic('uploaded material gap: WORKER_INPUTS_CHANGED before native dispatch');
    assert.equal((await f.get(f.base+'/goals'))[0].verifiedDone,false);
  }finally{await f.close();}
});

test('P8 general dependent: applied native-shaped predecessor fixtures do not bypass Controller input hashes',async t=>{
  const f=await productFixture('general',true);try{
    const flow=await planAndSubmit(f,3),running=await views(f,flow);
    assert.equal(f.runners.length,2);
    for(let i=0;i<2;i++)writeFileSync(join(running.workers.spaces[i].path,`output/report-${i+1}.md`),'Evidence: 42\n');
    for(const runner of f.runners)runner.finish(outcome('completed'));
    await until(()=>f.controller.workerIntegrationQueue(f.project.id).items.length===2&&f.controller.workerIntegrationQueue(f.project.id).items.every(i=>i.status==='applied'),'predecessor fixture integration');
    const ready=await views(f,flow);assert.equal(ready.graph.nodes.find((n:any)=>n.taskId===flow.tasks[2].id)!.state,'ready');
    await f.post(f.base+'/worker-batches/'+flow.batch.id+'/submit',{requestId:randomUUID()});
    const result=await views(f,flow);
    assert.equal(f.runners.length,2);
    assert.ok(result.workers.reasons.some((r:any)=>r.code==='PLAN_CHANGED'));
    // Recorded mock capability evidence changes the registry binding. Obtain a fresh
    // user-approved execution plan before testing the independent inherited-input gate.
    const route=await f.post(f.base+'/capability-routes',{requestId:randomUUID(),taskId:flow.tasks[2].id,text:'문서 작성'});
    const execution=await f.post(f.base+'/capability-executions',{requestId:randomUUID(),routeId:route.id});
    const batch=await f.post(f.base+'/worker-batches',{requestId:randomUUID(),planningVersionId:flow.approved.id,graphRevision:1,planningHash:flow.approved.contentHash,confirmed:true,executions:[{executionId:execution.id,expectedPlanDigest:execution.planDigest}]});
    await f.post(f.base+'/worker-batches/'+batch.id+'/submit',{requestId:randomUUID()});
    assert.equal(f.runners.length,2);assert.deepEqual(f.dispatchErrors,['WORKER_INPUTS_CHANGED']);
    assert.equal(result.queue.items.length,2);assert.equal(result.progress.tasks.find(t=>t.id===flow.tasks[2].id)!.completion!.verifiedDone,false);
    assert.equal((await f.get(f.base+'/goals'))[0].verifiedDone,false);
    t.diagnostic('CQG-6B-CTL gap: WORKER_INPUTS_CHANGED on inherited predecessor materials; no dependent runtime launched');
  }finally{await f.close();}
});
