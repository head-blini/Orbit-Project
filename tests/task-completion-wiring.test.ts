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
