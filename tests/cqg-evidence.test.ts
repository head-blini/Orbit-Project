import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Studio} from '../server/studio.ts';
import {evidenceCheck,listDeliverables} from '../server/deliverables.ts';
import {generalCheckerDigest,generalEvidenceSnapshot,QualityProgressCollector} from '../server/quality-progress.ts';
import {qualityVerifyGeneral,qualityRunEvidence,createQualityNativePorts} from '../server/quality-loop-native.ts';
import {readVerificationConfiguration,verificationCommandPreviews,verificationGateCommandMap} from '../server/verification-configuration.ts';
import {VerificationService} from '../server/verification-service.ts';
import {generalAttemptPath} from '../server/worker-spaces.ts';
import {readWorkspaceSnapshot} from '../server/workspace-fingerprint.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {QualityStepContext} from '../shared/quality-loop-record.ts';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const command={projectPath:tmpdir(),id:'lint',label:'Arbitrary command',executable:process.execPath,args:['-e','process.exit(0)'],timeoutMs:5000};

test('categories are explicit, validated and part of the configuration digest',()=>{
 const configuration=(categories?:string[])=>readVerificationConfiguration(JSON.stringify([{...command,...(categories?{categories}:{})}]));
 const preview=(categories?:string[])=>verificationCommandPreviews(configuration(categories),tmpdir());
 assert.deepEqual(verificationGateCommandMap(configuration(),tmpdir()),{},'a command named lint is not a lint gate');
 assert.deepEqual(verificationGateCommandMap(configuration(['unit','contract']),tmpdir()),{unit:['lint'],contract:['lint']});
 assert.deepEqual(verificationGateCommandMap(configuration(['unit']),join(tmpdir(),'other-project')),{});
 assert.equal('categories' in preview(['unit'])[0],false,'execution previews remain compatible with strict Workflow commands');
 assert.notEqual(preview(['unit'])[0].configDigest,preview(['contract'])[0].configDigest);
 assert.equal(preview(['unit','contract'])[0].configDigest,preview(['contract','unit'])[0].configDigest);
 for(const categories of [['unknown'],['lint','lint'],[null]])assert.throws(()=>preview(categories as string[]),/INVALID_VERIFICATION_CONFIGURATION/);
});

test('changing only category invalidates a recorded check and approval',async()=>{
 const store=new Store(':memory:');
 const project={id:'project',name:'Code',path:tmpdir(),createdAt:'',writeEnabled:true};
 const workspace={id:'ws',projectId:project.id,path:project.path,baseSha:'a'.repeat(40),branch:'fixture',createdAt:'',status:'ready' as const};
 store.saveProject(project);store.saveWorkspace(workspace);
 let categories:['unit']|['contract']=['unit'];
 const projects={writable:()=>workspace,list:()=>[project],fingerprint:()=>'b'.repeat(64)} as unknown as Projects;
 const service=new VerificationService(store,projects,path=>verificationCommandPreviews([{...command,categories}],path));
 try{
  const run=store.createRun('run','c'.repeat(64),'test',workspace.id);store.updateRun(run.id,{execution:'completed'},'run.completed');
  const view=()=>service.view(workspace.id,run.id),before=view();
  service.start({requestId:'check',runId:run.id,workspaceId:workspace.id,commandId:command.id,expectedSourceDigest:before.sourceDigest!,expectedConfigDigest:before.commands[0].configDigest});await service.settle();
  assert.equal(view().canApprove,true);
  service.approve({requestId:'approve',runId:run.id,workspaceId:workspace.id,expectedSourceDigest:view().sourceDigest!,expectedCheckSetDigest:view().checkSetDigest!});
  categories=['contract'];assert.equal(view().canApprove,false);assert.equal(view().approvalCurrent,false);
 }finally{await service.close();store.close();}
});

test('per-number source results keep missing inputs and missing numbers unverified',()=>{
 assert.deepEqual(evidenceCheck('text/csv','name,value\na,1\nb,2',['1']).results,[{value:'1',status:'verified',inputIndexes:[0]},{value:'2',status:'needs_review',inputIndexes:[]}]);
 const absent=evidenceCheck('text/csv','name,value\na,1',[]);
 assert.equal(absent.status,'unverified');assert.equal(absent.results[0].status,'unverified');
 const empty=evidenceCheck('text/markdown','# Report',['1']);assert.equal(empty.status,'unverified');assert.deepEqual(empty.results,[]);
 assert.equal(evidenceCheck('text/csv','name,value\na,9',['1']).status,'needs_review');
});

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'orbit-cqg-')),store=new Store(':memory:'),studio=new Studio(store);
 const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects'));
 const {project}=projects.createProject({requestId:randomUUID(),name:'Report',kind:'general'});
 const draft=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Report',goal:'Report',requirements:[{id:'R1',description:'Report',acceptance_criteria:['Cite sources']}],constraints:[],open_questions:[]})}}) as PlanningVersion;
 const plan=studio.mutate(project.id,'plans',draft.id,'approve',{expectedRevision:1}) as PlanningVersion;
 const [task]=studio.mutate(project.id,'plans',plan.id,'task-drafts',{}) as SavedTask[];
 const created=store.createRun('dispatch','a'.repeat(64),'report',undefined,{runtime:'claude-code',projectId:project.id,taskId:task.id,planningVersionId:plan.id,planningContentHash:plan.contentHash});
 store.updateRun(created.id,{execution:'completed'},'run.completed');const run=store.getRun(created.id)!;
 writeFileSync(join(project.path,'report.md'),'# Report');
 const inventory=()=>listDeliverables(project.path,[]);
 const context:QualityStepContext={loopId:'loop',stepId:'check',sourceRun:run,version:plan,task,signal:new AbortController().signal,artifact:{id:project.id,digest:hash(inventory().items.map(i=>({path:i.path,digest:i.sha256})))}};
 const collector=(checkerDigest?:string)=>new QualityProgressCollector(store,{deliverables:inventory,checkerDigest});
 const read=(checkerDigest?:string)=>collector(checkerDigest).read(project.id,task,run,plan,true);
 return {dir,store,projects,project,plan,task,run,context,inventory,collector,read,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('general supplements expose separate numeric gate, inventory scope and unknown provenance without writes',async()=>{
 const f=fixture();try{
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  const changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const q=f.read(),e=f.collector().completionEvidence(q,f.run);
  assert.equal(q.format.status,'passed');assert.equal(q.evidence[0].artifactScope,'project_inventory');
  assert.equal(e.gateResults.find(g=>g.gate==='numeric_source')!.status,'unknown');
  assert.equal(e.bindings.check.artifactScope,null);assert.equal(e.bindings.check.policyDigest,null);assert.equal(e.taskManifest,null);
  assert.equal(qualityRunEvidence(f.store,f.run).source,'unknown');assert.equal(q.execution.evidenceSource,'unknown');
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
 }finally{f.close();}
});

test('checker and policy version changes stale general evidence; missing capture stays unavailable',async()=>{
 const f=fixture();try{
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  for(const digest of [generalCheckerDigest('cqg-general-v2'),generalCheckerDigest(undefined,'checker-v3')]){
   const q=f.read(digest);assert.equal(q.format.status,'stale');assert.ok(q.format.blockers.includes('QUALITY_CHECKER_CHANGED'));
  }
  const row=f.store.db.prepare('SELECT body FROM quality_artifact_checks').get()!;const saved=JSON.parse(String(row.body));
  delete saved.checkerDigest;delete saved.evidenceSource;f.store.db.prepare('UPDATE quality_artifact_checks SET body=?').run(JSON.stringify(saved));
  const q=f.read();assert.equal(q.evidence[0].freshness,'unavailable');assert.equal(q.evidence[0].evidenceSource,'unknown');assert.notEqual(q.format.status,'passed');
 }finally{f.close();}
});

function worker(f:ReturnType<typeof fixture>){
 const attemptId='attempt',reservationId='reservation',path=generalAttemptPath(f.project.path,attemptId);
 mkdirSync(join(path,'inputs'),{recursive:true});mkdirSync(join(path,'output'));
 writeFileSync(join(path,'inputs','source.csv'),'name,value\na,1');writeFileSync(join(path,'output','report.csv'),'name,value\na,1');
 const stat=lstatSync(path,{bigint:true});
 const listed=listDeliverables(path,[]),files=listed.items.map(i=>({path:i.path,mode:'100644'}));
 const source=readWorkspaceSnapshot(path,'0'.repeat(40),files);
 const space={reservationId,attemptId,projectId:f.project.id,kind:'general',path,workspaceId:null,repositoryId:null,baseSha:null,state:'ready',identity:`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,inputDigest:'i'.repeat(64),inputManifest:listed.items.filter(i=>i.role==='input').map(i=>({path:i.path.slice(7),sha256:i.sha256}))};
 const manifest={reservationId,files:listed.items.filter(i=>i.role==='output').map(i=>({path:i.path,status:'present',sha256:i.sha256,outOfScope:false})),inputsUnchanged:true,outOfScope:false,sourceDigest:source.sourceDigest};
 const reservation={reservationId,attempt:{id:attemptId,taskId:f.task.id,dispatchRequestId:'dispatch'},batch:{projectId:f.project.id,planningVersionId:f.plan.id,planningHash:f.plan.contentHash,graphRevision:3,contractDigests:[{id:'contract',digest:'c'.repeat(64)}]}};
 for(const [table,body] of [['worker_spaces',space],['worker_reservations',reservation],['integration_queue',{space,manifest}]] as const){f.store.db.exec(`CREATE TABLE ${table}(body TEXT NOT NULL)`);f.store.db.prepare(`INSERT INTO ${table} VALUES(?)`).run(JSON.stringify(body));}
 return {path,space,manifest};
}

test('worker evidence binds the saved attempt manifest and input snapshot, ignoring project-wide outputs',async()=>{
 const f=fixture();try{
  const w=worker(f),snapshot=generalEvidenceSnapshot(f.store,f.run,f.inventory);
  f.context.artifact={id:snapshot.artifactId,digest:snapshot.digest!};await qualityVerifyGeneral(f.store,f.projects,f.context);
  const q=f.read(),e=f.collector().completionEvidence(q,f.run);
  assert.equal(q.format.status,'passed');assert.equal(q.evidence[0].artifactScope,'task_manifest');
  assert.deepEqual(e.taskManifest,w.manifest);assert.equal(e.bindings.check.artifactDigest,hash(w.manifest));
  assert.equal(e.bindings.check.inputSnapshotDigest,w.space.inputDigest);assert.equal(e.bindings.check.graphRevision,'3');
  assert.equal(e.gateResults.find(g=>g.gate==='numeric_source')!.status,'passed');
  assert.deepEqual(q.evidence[0].numericSource![0].check.results,[{value:'1',status:'verified',inputIndexes:[0]}]);
  writeFileSync(join(f.project.path,'report.md'),'Unrelated change');assert.equal(f.read().format.status,'passed');
  writeFileSync(join(w.path,'output','report.csv'),'name,value\na,2');assert.notEqual(f.read().format.status,'passed');
 }finally{f.close();}
});

test('a worker without a saved manifest cannot fall back to project inventory',()=>{
 const f=fixture();try{
  worker(f);f.store.db.exec('DELETE FROM integration_queue');
  assert.throws(()=>generalEvidenceSnapshot(f.store,f.run,f.inventory),/QUALITY_TASK_MANIFEST_UNAVAILABLE/);
 }finally{f.close();}
});

test('native semantic receipts carry checker version and reject stale recovery',async()=>{
 const f=fixture();try{
  const ports=createQualityNativePorts({store:f.store,projects:f.projects,factory:()=>{throw Error('NO_PROVIDER');},guard(){},repair:async()=>{throw Error('NO_REPAIR');},verify:async()=>({status:'unknown',checkIds:[],issue:null}),findExecutable:()=>'/fake',
   claudeFactory:()=>({interrupt:()=> 'requested',async start(_text,onEvent){onEvent({kind:'session',sessionId:'session',model:'model',permissionMode:'plan',auth:'subscription',tools:[]});return {status:'completed',dispatch:'started',exit:'observed',exitCode:0,signal:null,forced:false,ignoredLines:0,sessionId:'session',response:JSON.stringify({verdict:'approve',baseline_respected:true,criteria:[{criterion:'Cite sources',status:'met',evidence:'Fixture'}],findings:[]}),identity:{providerId:'anthropic',modelId:'model',sessionId:'session',executionId:null,modelEvidence:'assistant_message'}};}})});
  await ports.review({baseline:{id:f.plan.id,digest:f.plan.contentHash,criteria:f.task.acceptanceCriteria},artifact:f.context.artifact,reviewer:{id:'reviewer',modelKey:'anthropic/model'},signal:f.context.signal},f.context,{id:'reviewer',providerId:'anthropic',modelId:'model'});
  const body=JSON.parse(String(f.store.db.prepare('SELECT body FROM quality_native_receipts').get()!.body));assert.equal(body.checkerDigest,generalCheckerDigest());
  body.checkerDigest=generalCheckerDigest('old');f.store.db.prepare('UPDATE quality_native_receipts SET body=?').run(JSON.stringify(body));
  await assert.rejects(ports.recover!({id:f.context.stepId,index:0,kind:'review',state:'intent',requestDigest:'digest',startedAt:'',finishedAt:null,issue:null,evidence:null,result:null},f.context),/QUALITY_RECEIPT_MISMATCH/);
 }finally{f.close();}
});


test('historical checks replay without adding version, per-number or ownership provenance',async()=>{
 const f=fixture();try{
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  const saved=JSON.parse(String(f.store.db.prepare('SELECT body FROM quality_artifact_checks').get()!.body));
  for(const key of ['checkerDigest','completionBinding','artifactScope','numericSource','formatStatus'])delete saved[key];
  for(const file of saved.files)delete file.checks.evidence;
  const body=JSON.stringify(saved);f.store.db.prepare('UPDATE quality_artifact_checks SET body=?').run(body);
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  assert.equal(f.store.db.prepare('SELECT body FROM quality_artifact_checks').get()!.body,body);
  assert.notEqual(f.read().format.status,'passed');
  const supplements=f.collector().completionEvidence(f.read(),f.run);
  assert.equal(supplements.bindings.check.configDigest,null);assert.equal(supplements.gateResults.find(g=>g.gate==='numeric_source')!.status,'unknown');
 }finally{f.close();}
});

test('numeric mismatch is explicit even when the format gate passes',async()=>{
 const f=fixture();try{
  mkdirSync(join(f.project.path,'inputs'));writeFileSync(join(f.project.path,'inputs','source.csv'),'name,value\na,1');
  writeFileSync(join(f.project.path,'report.md'),'| name | value |\n| a | 9 |');
  f.context.artifact.digest=hash(f.inventory().items.map(i=>({path:i.path,digest:i.sha256})));
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  const q=f.read(),supplements=f.collector().completionEvidence(q,f.run);
  assert.equal(q.format.status,'passed');assert.equal(q.evidence[0].recordedStatus,'passed');assert.equal(q.evidence[0].numericSource!.find(n=>n.path==='report.md')!.check.results[0].status,'needs_review');
  assert.equal(supplements.gateResults.find(g=>g.gate==='numeric_source')!.status,'failed');
 }finally{f.close();}
});

test('changed worker inputs invalidate the saved manifest without replacing its input snapshot',()=>{
 const f=fixture();try{
  const w=worker(f);writeFileSync(join(w.path,'inputs','source.csv'),'name,value\na,2');
  assert.throws(()=>generalEvidenceSnapshot(f.store,f.run,f.inventory),/QUALITY_ARTIFACT_CHANGED/);
 }finally{f.close();}
});
