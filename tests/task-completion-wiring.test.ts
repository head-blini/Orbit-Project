import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {claudeFixture,planningInput} from './claude-task-fixture.ts';
import {TaskGraphService} from '../server/task-graph.ts';
import {ProjectProgressService,defaultCompletionPolicy,readCompletionPolicies} from '../server/project-progress.ts';
import {CODE_GATES,type CompletionEvidence} from '../shared/task-completion.ts';
import type {SavedTask} from '../shared/parallel.ts';
import type {VerificationView} from '../shared/verification.ts';

function fixture(release:'quality_passed'|'wait'='quality_passed'){
 const f=claudeFixture();
 // Persisted native observations below are fixtures, never live provider evidence.
 const project={...f.project,kind:'code' as const};
 f.store.db.prepare("UPDATE projects SET kind='code',body=? WHERE id=?").run(JSON.stringify(project),project.id);
 const {version}=f.plan({...planningInput,text:JSON.stringify({...JSON.parse(planningInput.text),requirements:[{id:'R1',description:'Collect',acceptance_criteria:['correct']},{id:'R2',description:'Write',acceptance_criteria:['correct']}]})});
 const tasks=f.studio.read(project.id,'tasks') as SavedTask[];
 const graphs=new TaskGraphService(f.store),graph=graphs.save(project.id,{planningVersionId:version.id,contentHash:version.contentHash,expectedRevision:0,nodes:tasks.map(t=>({taskId:t.id})),edges:[{taskId:tasks[1].id,dependsOn:tasks[0].id}]});
 f.store.saveWorkspace({id:'workspace',projectId:project.id,path:project.path,branch:'dev',baseSha:'base',createdAt:new Date().toISOString(),status:'ready'});
 const run=f.store.createRun(randomUUID(),'digest','fixture','workspace',{projectId:project.id,taskId:tasks[0].id,planningVersionId:version.id,planningContentHash:version.contentHash});
 f.store.updateRun(run.id,{execution:'completed',turnId:'turn'},'run.completed');
 f.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify({...f.store.runs().find(r=>r.id===run.id)!,acceptanceDigest:'acceptance'}),run.id);
 f.store.append('run.runtime_source',run.id,{source:'native',interface:'codex.app_server'});
 const policy={...defaultCompletionPolicy('code'),dependencyRelease:release,gateCommandMap:Object.fromEntries(CODE_GATES.map(g=>[g,[g]]))};
 let evidence:CompletionEvidence|undefined;
 const view:VerificationView={workspaceId:'workspace',runId:run.id,commands:CODE_GATES.map(id=>({id,label:id,executable:'node',args:[],timeoutMs:1,configDigest:'command'})),sourceDigest:'artifact',sourceIssue:null,checks:[],quarantined:false,checkSetDigest:'set',canApprove:true,approval:null,approvalCurrent:false,scope:'fixture'};
 const progress=new ProjectProgressService(f.store,f.studio,{verification:()=>view,policy:()=>policy,evidence:base=>evidence??base});
 const binding=progress.read(project.id,{}).tasks[0].completion!.binding;
 const quality=progress.read(project.id,{}).tasks[0].quality!;
 evidence={quality,producer:{binding:{...binding},model:{providerId:'fixture',modelId:'producer',sessionId:'session',runId:run.id,source:'native_observed',evidenceSource:'native'}},bindings:{},commands:view.commands,checks:[],loops:[],gateResults:[],approvals:[]};
 for(const gate of CODE_GATES){
  evidence.bindings[gate]={...binding};
  quality.evidence.push({id:gate,kind:'verification_check',evidenceSource:'local',freshness:'current',recordedStatus:'passed',binding:{...binding},blockers:[]});
  evidence.checks.push({id:gate,requestId:gate,runId:run.id,projectId:project.id,workspaceId:'workspace',taskId:tasks[0].id,planningVersionId:version.id,planningContentHash:version.contentHash,acceptanceDigest:'acceptance',commandId:gate,configDigest:'command',baseSha:'base',sourceDigest:'artifact',finishedDigest:'artifact',createdAt:'2026-10-29T00:00:00Z',completedAt:'2026-10-29T00:01:00Z',execution:'completed',verdict:'passed',exitCode:0,durationMs:1,output:'',recoveredAt:null,evidenceSource:'local'});
 }
 return {...f,project,progress,policy,evidence,view,graph,graphs,tasks,version};
}

test('one read model releases graph dependent only on full bound quality pass; GET-style reads append nothing',async()=>{
 const f=fixture();try{
  const before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n,seq=f.store.lastSeq();
  const task=f.progress.read(f.project.id,{}).tasks[0];assert.equal(task.completion!.verifiedDone,true);
  assert.deepEqual(f.progress.graph(f.project.id,f.version.id).state.nodes.map(n=>n.state),['done','ready']);
  assert.equal(f.store.lastSeq(),seq);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);
 }finally{await f.close();}
});
for(const mutation of ['mock','unknown','format-only','artifact','revision','wait'] as const)test(`AX04: ${mutation} predecessor cannot release dependent`,async()=>{
 const f=fixture();try{
  assert.equal(f.progress.read(f.project.id,{}).tasks[0].completion!.verifiedDone,true);
  if(mutation==='mock')f.evidence.producer!.model.evidenceSource='mock';
  if(mutation==='unknown')f.evidence.producer!.model.modelId=null;
  if(mutation==='format-only')f.evidence.checks=[];
  if(mutation==='artifact')f.view.sourceDigest='changed';
  if(mutation==='revision')f.graphs.save(f.project.id,{planningVersionId:f.graph.planningVersionId,contentHash:f.graph.contentHash,nodes:f.graph.nodes,edges:f.graph.edges,expectedRevision:1});
  if(mutation==='wait')Object.assign(f.policy,{dependencyRelease:'wait'});
  assert.equal(f.progress.read(f.project.id,{}).tasks[0].completion!.verifiedDone,false);
  assert.equal(f.progress.graph(f.project.id,f.version.id).state.nodes[1].state,'waiting');
 }finally{await f.close();}
});
test('missing evidence is ready, not blocked; baseline staleness precedes all facts',async()=>{
 const f=fixture();try{
  assert.equal(f.progress.graph(f.project.id,f.version.id).state.nodes[1].state,'ready');
  f.studio.mutate(f.project.id,'plans',f.version.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:planningInput});
  assert.ok(f.progress.graph(f.project.id,f.version.id).state.nodes.every(n=>n.state==='stale'));
 }finally{await f.close();}
});
test('unset host policy waits; host configuration validates release and has no request-body facts',()=>{
 assert.equal(defaultCompletionPolicy('code').dependencyRelease,'wait');assert.deepEqual(readCompletionPolicies(undefined),[]);
 const entry={projectPath:'/project',policy:defaultCompletionPolicy('code')};
 assert.equal(readCompletionPolicies(JSON.stringify([entry]))[0].policy.requireIndependentReview,false);
 assert.throws(()=>readCompletionPolicies(JSON.stringify([{...entry,verifiedDoneIds:['forged']}])) ,/INVALID_COMPLETION_CONFIGURATION/);
});

test('wait policy with fully matching passing evidence keeps qualityPassed separate from verifiedDone',async()=>{
 const f=fixture('wait');try{
  const completion=f.progress.read(f.project.id,{}).tasks[0].completion!;
  assert.equal(completion.qualityPassed,true);assert.equal(completion.verifiedDone,false);
  assert.equal(f.progress.graph(f.project.id,f.version.id).state.nodes[1].state,'waiting');
 }finally{await f.close();}
});

test('configured policy changes stale captured gates and producer without releasing dependents',async()=>{
 const f=fixture();try{
  assert.equal(f.progress.read(f.project.id,{}).tasks[0].completion!.verifiedDone,true);
  f.policy.notApplicable.push({gate:'e2e',reason:'approved exception',approvedBy:'user',approvedAt:'2026-10-29T00:00:00Z'});
  const completion=f.progress.read(f.project.id,{}).tasks[0].completion!;
  assert.equal(completion.verifiedDone,false);
  assert.ok(completion.reasonCodes.includes('CQG_BINDING_CHANGED:policyDigest'));
  assert.ok(completion.gates.some(g=>g.freshness==='stale'));
  assert.equal(f.progress.graph(f.project.id,f.version.id).state.nodes[1].state,'waiting');
 }finally{await f.close();}
});

test('new verification captures policy and producer once; replay cannot rebind old checks',async()=>{
 const f=fixture();try{
  const {Controller}=await import('../server/controller.ts');
  const c=new Controller(f.store,f.dir,()=>{throw Error('NO_PROVIDER');},f.projects,[],[],{}, {}, {},{completion:{policy:()=>f.policy}});
  try{
   c.progress.read=f.progress.read.bind(f.progress);
   const runId=f.evidence.producer!.binding.runId!;
   f.store.append('run.identity',runId,{providerId:'fixture',modelId:'producer',sessionId:'session',modelEvidence:'assistant_message'});
   const source={...f.evidence.checks[0],requestId:randomUUID()};
   c.verification.start=()=>{
    const row=f.store.db.prepare('SELECT body FROM verification_checks WHERE request_id=?').get(source.requestId);
    if(row)return JSON.parse(String(row.body));
    f.store.db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run(source.id,source.requestId,JSON.stringify(source));return source;
   };
   const input={requestId:source.requestId,workspaceId:'workspace',runId,commandId:'lint',expectedSourceDigest:'artifact',expectedConfigDigest:'command'};
   const check=c['startBoundVerification'](input);
   assert.equal(check.completionBinding!.policyDigest,f.evidence.producer!.binding.policyDigest);
   const saved=JSON.parse(String(f.store.db.prepare('SELECT body FROM verification_checks WHERE id=?').get(check.id)!.body));
   assert.equal(saved.completionProducer.model.modelId,'producer');
   assert.equal(saved.completionProducer.binding.policyDigest,check.completionBinding!.policyDigest);
   f.policy.dependencyRelease='wait';
   assert.deepEqual(c['startBoundVerification'](input),saved);
  }finally{await c.close();}
 }finally{await f.close();}
});

test('quality receipts keep start-time policy binding and never retrofit legacy receipts',async()=>{
 const f=fixture();try{
  const {Controller}=await import('../server/controller.ts');
  const c=new Controller(f.store,f.dir,()=>{throw Error('NO_PROVIDER');},f.projects,[],[],{}, {}, {},{completion:{policy:()=>f.policy}});
  try{
   c.progress.read=f.progress.read.bind(f.progress);
   const run=f.store.getRun(f.evidence.producer!.binding.runId!)!;
   const context={loopId:'loop',stepId:'step',signal:new AbortController().signal,sourceRun:run,version:f.version,task:f.tasks[0],artifact:{id:'workspace',digest:'artifact'}};
   const oldDigest=f.evidence.producer!.binding.policyDigest;
   await c['captureQualityCompletion'](context,async()=>{
    f.policy.dependencyRelease='wait';
    f.store.db.prepare('INSERT INTO quality_native_receipts VALUES(?,?)').run('step',JSON.stringify({id:'step',loopId:'loop',sourceRunId:run.id,artifactDigest:'artifact'}));return 'done';
   });
   const saved=String(f.store.db.prepare('SELECT body FROM quality_native_receipts WHERE id=?').get('step')!.body);
   assert.equal(saved,JSON.stringify({id:'step',loopId:'loop',sourceRunId:run.id,artifactDigest:'artifact'}));
   const captured=String(f.store.db.prepare('SELECT body FROM quality_controller_receipts WHERE id=?').get('completion:step')!.body);
   const capture=JSON.parse(captured).completionCapture;
   assert.equal(capture.binding.policyDigest,oldDigest);
   assert.equal(capture.producer.binding.policyDigest,oldDigest);
   assert.equal(capture.records[0].evidenceId,'loop');
   await c['captureQualityCompletion'](context,async()=>null);
   assert.equal(String(f.store.db.prepare('SELECT body FROM quality_native_receipts WHERE id=?').get('step')!.body),saved);
   assert.equal(String(f.store.db.prepare('SELECT body FROM quality_controller_receipts WHERE id=?').get('completion:step')!.body),captured);
  }finally{await c.close();}
 }finally{await f.close();}
});

test('completion reader uses latest captured producer after policy revalidation',async()=>{
 const f=fixture();try{
  for(const [index,check] of f.evidence.checks.entries()){
   const producer=structuredClone(f.evidence.producer!);
   if(index===0)producer.binding.policyDigest='previous-policy';
   f.store.db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run(check.id,check.requestId,JSON.stringify({...check,completionBinding:f.evidence.bindings[check.id],completionProducer:producer}));
  }
  const progress=new ProjectProgressService(f.store,f.studio,{verification:()=>f.view,policy:()=>f.policy,evidence:base=>({...f.evidence,producer:base.producer})});
  assert.equal(progress.read(f.project.id,{}).tasks[0].completion!.verifiedDone,true);
 }finally{await f.close();}
});

test('artifact completion supplement preserves replay bytes and rejects a changed source record',async()=>{
 const f=fixture();try{
  const {Controller}=await import('../server/controller.ts');
  const c=new Controller(f.store,f.dir,()=>{throw Error('NO_PROVIDER');},f.projects,[],[],{}, {}, {},{completion:{policy:()=>f.policy}});
  try{
   c.progress.read=f.progress.read.bind(f.progress);
   const run=f.store.getRun(f.evidence.producer!.binding.runId!)!,binding=f.evidence.producer!.binding;
   const context={loopId:'loop',stepId:'artifact-check',signal:new AbortController().signal,sourceRun:run,version:f.version,task:f.tasks[0],artifact:{id:'workspace',digest:'artifact'}};
   const body=JSON.stringify({id:context.stepId,loopId:'loop',sourceRunId:run.id,projectId:f.project.id,taskId:f.tasks[0].id,planningVersionId:f.version.id,baselineDigest:f.version.contentHash,artifactId:'workspace',artifactDigest:'artifact',evidenceSource:'local',completionBinding:{...binding,policyDigest:null},formatStatus:'passed',result:{status:'passed',checkIds:[context.stepId],issue:null}});
   await c['captureQualityCompletion'](context,async()=>{
    f.store.db.exec('CREATE TABLE IF NOT EXISTS quality_artifact_checks(id TEXT PRIMARY KEY,loop_id TEXT NOT NULL,body TEXT NOT NULL)');
    f.store.db.prepare('INSERT INTO quality_artifact_checks VALUES(?,?,?)').run(context.stepId,'loop',body);
   });
   assert.equal(f.store.db.prepare('SELECT body FROM quality_artifact_checks WHERE id=?').get(context.stepId)!.body,body);
   let observed:CompletionEvidence|undefined;
   const progress=new ProjectProgressService(f.store,f.studio,{verification:()=>f.view,policy:()=>f.policy,evidence:base=>{observed=base;return f.evidence;}});
   progress.read(f.project.id,{});
   assert.equal(observed!.bindings[context.stepId].policyDigest,binding.policyDigest);
   assert.equal(observed!.producer!.binding.policyDigest,binding.policyDigest);
   f.store.db.prepare('UPDATE quality_artifact_checks SET body=? WHERE id=?').run(JSON.stringify({...JSON.parse(body),formatStatus:'failed'}),context.stepId);
   progress.read(f.project.id,{});
   assert.equal(observed!.bindings[context.stepId].policyDigest,null);
   assert.equal(observed!.producer,undefined);
  }finally{await c.close();}
 }finally{await f.close();}
});
