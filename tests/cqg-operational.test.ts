import test from 'node:test';
import assert from 'node:assert/strict';
import {CODE_GATES} from '../shared/task-completion.ts';
import {defaultCompletionPolicy,readCompletionPolicies} from '../server/project-progress.ts';
const policy=()=>({...defaultCompletionPolicy('code'),dependencyRelease:'quality_passed' as const,gateCommandMap:Object.fromEntries(CODE_GATES.map(g=>[g,['full']]))});
const parse=(p:unknown)=>readCompletionPolicies(JSON.stringify([{projectPath:'/project',policy:p}]),()=>[{id:'full'}]);
test('operational policy validates commands and preserves missing-policy wait',()=>{
 assert.deepEqual(readCompletionPolicies(undefined),[]);
 assert.equal(defaultCompletionPolicy('code').dependencyRelease,'wait');
 assert.equal(parse(policy())[0].policy.dependencyRelease,'quality_passed');
});
for(const defect of ['missing gate','unknown command','empty mapping','duplicate NA','general map','path control'] as const)test(`operational configuration rejects ${defect}`,()=>{
 const p=policy();
 if(defect==='missing gate')p.requiredGates.pop();
 if(defect==='unknown command')p.gateCommandMap.unit=['absent'];
 if(defect==='empty mapping')p.gateCommandMap.unit=[];
 if(defect==='duplicate NA')p.notApplicable=[{gate:'unit',reason:'approved exception',approvedBy:'user',approvedAt:'2026-10-29T00:00:00Z'},{gate:'unit',reason:'duplicate',approvedBy:'user',approvedAt:'2026-10-29T00:00:00Z'}];
 if(defect==='general map')Object.assign(p,{projectKind:'general',requiredGates:['artifact_format','numeric_source','semantic_review']});
 assert.throws(()=>defect==='path control'?readCompletionPolicies(JSON.stringify([{projectPath:'/project\n',policy:p}])):parse(p),/INVALID_COMPLETION_CONFIGURATION/);
});

for(const raw of ['not json','{}','null',JSON.stringify([{projectPath:'relative',policy:policy()}]),JSON.stringify([{projectPath:'/project',policy:{...policy(),verifiedDone:true}}])])test('malformed host configuration fails closed: '+raw.slice(0,25),()=>{
 assert.throws(()=>readCompletionPolicies(raw),/INVALID_COMPLETION_CONFIGURATION/);
});
test('NA needs approved reason and permits an unmapped category only with approval',()=>{
 const p=policy();delete p.gateCommandMap.e2e;
 p.notApplicable=[{gate:'e2e',reason:'No UI in this library',approvedBy:'user',approvedAt:'2026-10-29T00:00:00Z'}];
 assert.equal(parse(p)[0].policy.notApplicable.length,1);
 for(const key of ['reason','approvedBy','approvedAt'] as const){const invalid=structuredClone(p);invalid.notApplicable[0][key]='';assert.throws(()=>parse(invalid),/INVALID_COMPLETION_CONFIGURATION/);}
});

import {createHash} from 'node:crypto';
import {completionPolicyDigest,evaluateCandidateCompletion} from '../server/task-completion.ts';
import type {CandidateCompletionEvidence,CompletionBinding,TaskCompletion} from '../shared/task-completion.ts';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
for(const defect of ['none','source not done','candidate command missing','candidate stale'] as const)test(`operational candidate policy: ${defect}`,()=>{
 const p=parse(policy())[0].policy;
 const binding:CompletionBinding={projectId:'project',taskId:'task',runId:'run',planningVersionId:'plan',planningContentHash:'baseline',acceptanceDigest:'acceptance',artifactId:'candidate',artifactDigest:'candidate-hash',graphRevision:'1',contractDigest:'contracts',policyDigest:completionPolicyDigest(p),configDigest:hash([{id:'full',digest:'command'}]),artifactScope:'workspace',baseSha:'target',inputSnapshotDigest:null};
 const dimension={status:'not_run' as const,evidenceIds:[],blockers:[],nextAction:null};
 const evidence:CandidateCompletionEvidence={quality:{execution:{...dimension,status:'completed',evidenceSource:'local'},format:dimension,codeVerification:dimension,semantic:dimension,independentReview:dimension,repair:dimension,revalidation:dimension,userApproval:dimension,evidence:[{id:'check',kind:'verification_check',binding:{...binding},evidenceSource:'local',freshness:'current',recordedStatus:'passed',blockers:[]}]},bindings:{check:{...binding}},commands:[{id:'full',configDigest:'command'}],checks:[{id:'check',requestId:'check',runId:'run',projectId:'project',workspaceId:'candidate',taskId:'task',planningVersionId:'plan',planningContentHash:'baseline',acceptanceDigest:'acceptance',commandId:'full',configDigest:'command',baseSha:'target',sourceDigest:'candidate-hash',finishedDigest:'candidate-hash',createdAt:'2026-10-29T00:00:00Z',completedAt:'2026-10-29T00:00:01Z',execution:'completed',verdict:'passed',exitCode:0,durationMs:1000,output:'',recoveredAt:null,evidenceSource:'local'}],loops:[],gateResults:[],approvals:[]};
 // Trusted CQG-1 output fixture; task provenance matrix is tested separately.
 const sourceBinding={...binding,artifactId:'worker',artifactDigest:'worker-manifest',baseSha:'worker-base'};
 const decision={status:'blocked' as const,evidenceIds:[],source:'unknown' as const,freshness:'unavailable' as const,blockers:[]};
 const source:TaskCompletion={binding:sourceBinding,policyDigest:binding.policyDigest!,gates:[],qualityPassed:true,verifiedDone:defect!=='source not done',reasonCodes:[],independentReview:decision,userApproval:decision};
 if(defect==='candidate command missing')evidence.checks=[];
 if(defect==='candidate stale')evidence.bindings.check.configDigest='old';
 const result=evaluateCandidateCompletion(evidence,p,binding,{subject:'integration_candidate',producer:'orbit_merge',integrationId:'candidate',candidateDigest:'candidate-hash',targetDigest:'target',sourceBinding},source);
 assert.equal(result.verifiedDone,defect==='none');assert.equal(result.subject,'integration_candidate');assert.equal(result.producer,'orbit_merge');
 if(defect==='none')assert.ok(result.gates.every(g=>g.status==='passed'&&g.source==='local'&&g.freshness==='current'));
});

import {claudeFixture} from './claude-task-fixture.ts';
import {ParallelWorkerService} from '../server/parallel-workers.ts';
import {randomUUID} from 'node:crypto';
test('Controller source reader selects the exact dispatch attempt, re-reads completion, and writes nothing',async()=>{
 const f=claudeFixture();try{
  const {version,task}=f.plan(),requestId=randomUUID();
  const run=f.store.createRun(requestId,'digest','fixture',undefined,{projectId:f.project.id,taskId:task.id,planningVersionId:version.id,planningContentHash:version.contentHash});
  const workers=new ParallelWorkerService(f.store);
  const reservation=workers.reserve({requestId:randomUUID(),ownerIncarnation:'test',batch:{id:randomUUID(),projectId:f.project.id,planningVersionId:version.id,planningHash:version.contentHash,graphRevision:1,taskIds:[task.id],contractDigests:[],inputArtifactHashes:[],runtimeChoices:[{taskId:task.id,runtimeId:'claude-code'}],parallelLimit:1},attempt:{id:randomUUID(),taskId:task.id,runtimeId:'claude-code',dispatchRequestId:requestId},claims:[{kind:'isolated_folder',host:'local',path:{path:f.project.path,canonicalPath:f.project.path,aliasStatus:'verified_no_alias'}}]});
  const progress=f.controller.progress.read(f.project.id,{}),completion=progress.tasks[0].completion!;
  // Exercise routing with a trusted read-model fixture; evaluator rules are tested above.
  completion.verifiedDone=true;
  f.controller.progress.read=()=>structuredClone(progress);
  const item={projectId:f.project.id,fence:reservation,space:{workspaceId:null as string|null}};
  const read=()=>Reflect.get(f.controller,'readIntegrationSource').call(f.controller,item) as TaskCompletion|null;
  const seq=f.store.lastSeq(),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.equal(read()?.verifiedDone,true);
  completion.verifiedDone=false;assert.equal(read()?.verifiedDone,false);
  progress.tasks[0].latestRunId='different-attempt';assert.equal(read(),null);
  progress.tasks[0].latestRunId=run.id;item.space.workspaceId='different-workspace';assert.equal(read(),null);
  assert.equal(f.store.lastSeq(),seq);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
 }finally{await f.close();}
});

test('requiredTools host policy accepts exact item keys and rejects malformed or duplicate entries',()=>{
 const key={runtimeId:'codex',kind:'mcp',itemId:'a'.repeat(64)};
 assert.deepEqual(parse({...policy(),requiredTools:[key]})[0].policy.requiredTools,[key]);
 assert.deepEqual(parse({...policy(),requiredTools:[]})[0].policy.requiredTools,[]);
 for(const requiredTools of [null,{},[key,key],[{...key,command:'injected'}],[{...key,itemId:'free text'}],[{...key,runtimeId:'other'}]]){
  assert.throws(()=>parse({...policy(),requiredTools}),/INVALID_COMPLETION_CONFIGURATION/);
 }
});
