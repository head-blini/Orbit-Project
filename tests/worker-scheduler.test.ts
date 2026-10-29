import {ProjectProgressService} from '../server/project-progress.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {chmodSync,readFileSync,rmSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {claudeFixture,FakeClaudeRun,outcome,tick,planningInput} from './claude-task-fixture.ts';
import {CapabilityExecutionService} from '../server/capability-execution.ts';
import {CapabilityRoutingService} from '../server/capability-routing.ts';
import {discoverCapabilities} from '../server/capability-adapters.ts';
import {TaskGraphService} from '../server/task-graph.ts';
import {WorkerScheduler} from '../server/worker-scheduler.ts';
import {generalAttemptPath,resolveWorkerPath} from '../server/worker-spaces.ts';
import type {ApprovedExecutionBatch,WorkerResourceClaim} from '../shared/parallel-workers.ts';
import type {SavedTask} from '../shared/parallel.ts';

function setup(barrier?:Promise<void>){
 const runners:FakeClaudeRun[]=[],paths:string[]=[],guards:(()=>void)[]=[];
 const f=claudeFixture({runnerFactory:config=>{config.beforeDispatch();guards.push(config.beforeDispatch);paths.push(config.cwd);const runner=new FakeClaudeRun();const start=runner.start.bind(runner);runner.start=(...args)=>{const result=start(...args);return barrier?Promise.all([result,barrier]).then(([outcome])=>outcome):result;};runners.push(runner);return runner;}});
 const input=JSON.parse(planningInput.text);input.requirements=[1,2,3].map(i=>({id:'R'+i,description:'Report '+i,acceptance_criteria:['Cite evidence']}));
 const {version}=f.plan({...planningInput,text:JSON.stringify(input)});
 const tasks=f.studio.read(f.project.id,'tasks') as SavedTask[];
 const graph=new TaskGraphService(f.store);graph.save(f.project.id,{planningVersionId:version.id,contentHash:version.contentHash,expectedRevision:0,nodes:tasks.map(t=>({taskId:t.id})),edges:[{taskId:tasks[2].id,dependsOn:tasks[0].id}]});
 const registry=discoverCapabilities({codexReady:true,probe:{checkedAt:new Date().toISOString(),codex:{status:'found',version:'0.165.0'},claude:{status:'found',version:'2.1.312'}}});
 const execution=new CapabilityExecutionService(f.store,f.controller,()=>registry),routing=new CapabilityRoutingService(f.store);
 const plans=tasks.map(t=>execution.plan(f.project.id,{requestId:randomUUID(),routeId:routing.recommend(f.project.id,{requestId:randomUUID(),taskId:t.id,text:'문서 작성'},registry).id}));
 const batch:ApprovedExecutionBatch={id:randomUUID(),projectId:f.project.id,planningVersionId:version.id,planningHash:version.contentHash,graphRevision:1,taskIds:tasks.map(t=>t.id),contractDigests:[],inputArtifactHashes:[],runtimeChoices:tasks.map(t=>({taskId:t.id,runtimeId:'claude-code'})),parallelLimit:2};
 const scheduler=new WorkerScheduler(f.store,f.projects,execution);
 const claims=(i:number):WorkerResourceClaim[]=>[{kind:'isolated_folder',host:'local',path:resolveWorkerPath(f.project.path,join(generalAttemptPath(f.project.path,plans[i].id),'output'),true)}];
 const submit=(i:number,s=scheduler)=>s.submit({batch,executionId:plans[i].id,approval:{confirmed:true,expectedPlanDigest:plans[i].planDigest},claims:claims(i)});
 return {...f,tasks,version,registry,plans,batch,execution,scheduler,runners,paths,guards,claims,submit,async close(){for(const r of runners)r.finish(outcome('interrupted'));await tick();const writable=(p:string)=>{chmodSync(p,0o700);for(const e of readdirSync(p,{withFileTypes:true}))if(e.isDirectory())writable(join(p,e.name));};writable(f.dir);await f.close();}};
}

test('AX01: two independent native-loop fakes overlap behind a barrier; dependent waits; output stays isolated',async()=>{
 let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 const f=setup(barrier);try{
  const [a,b]=await Promise.all([f.submit(0),f.submit(1)]);
  assert.equal(f.runners.length,2);assert.notEqual(f.paths[0],f.paths[1]);
  assert.equal(f.store.findRequest(a.attempt.dispatchRequestId)!.run.execution,'starting');
  assert.equal(f.store.findRequest(b.attempt.dispatchRequestId)!.run.execution,'starting');
  await assert.rejects(f.submit(2),/DEPENDENCIES_WAITING/);
  f.runners[0].emit({kind:'message',text:'first only'});f.runners[1].emit({kind:'message',text:'second only'});
  assert.equal(f.store.findRequest(a.attempt.dispatchRequestId)!.run.response,'first only');
  assert.equal(f.store.findRequest(b.attempt.dispatchRequestId)!.run.response,'second only');
  f.runners[0].finish();await tick();assert.equal(f.store.findRequest(a.attempt.dispatchRequestId)!.run.execution,'starting');
  release();await tick();f.scheduler.reconcile();
  assert.equal(f.scheduler.read(a.reservationId).state,'terminal_confirmed');
  await assert.rejects(f.submit(2),/DEPENDENCIES_WAITING/);
  assert.equal((await f.submit(0)).attempt.id,a.attempt.id);assert.equal(f.runners.length,2);
 }finally{release();await f.close();}
});

test('stale baseline after reservation refuses dispatch and releases with not-dispatched evidence',async()=>{
 const f=setup();try{
  f.store.on('event',event=>{if(event.kind==='worker.reserved')f.studio.mutate(f.project.id,'plans',f.version.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:planningInput});});
  await assert.rejects(f.submit(0),/STALE|CHANGED/);assert.equal(f.runners.length,0);
  assert.equal(f.scheduler.list().length,1);
  assert.equal(f.scheduler.list()[0].state,'released');assert.equal(f.scheduler.list()[0].evidence?.kind,'not_dispatched');
 }finally{await f.close();}
});

test('restart and GET-style reads never redispatch; lost and interrupt_requested keep claims',async()=>{
 const f=setup();try{
  const a=await f.submit(0);const run=f.store.findRequest(a.attempt.dispatchRequestId)!.run;
  await f.controller.interrupt(run.id);f.scheduler.reconcile();assert.notEqual(f.scheduler.read(a.reservationId).state,'released');
  const restarted=new WorkerScheduler(f.store,f.projects,f.execution);
  for(let i=0;i<3;i++){restarted.list();restarted.read(a.reservationId);await f.submit(0,restarted);}
  assert.equal(f.runners.length,1);assert.equal(restarted.read(a.reservationId).state,'lost_unknown');
  assert.throws(()=>restarted.release(a.reservationId),/TERMINAL/);
  f.runners[0].finish(outcome('unknown'));await tick();restarted.reconcile();assert.equal(restarted.read(a.reservationId).state,'lost_unknown');
  await f.submit(1,restarted);assert.equal(f.runners.length,2);
 }finally{await f.close();}
});

test('total and batch limits apply with unknown quota; exhausted quota never starts or auto resumes',async()=>{
 const f=setup();try{
  const graph=new TaskGraphService(f.store);graph.save(f.project.id,{planningVersionId:f.version.id,contentHash:f.version.contentHash,expectedRevision:1,nodes:f.tasks.map(t=>({taskId:t.id})),edges:[]});f.batch.graphRevision=2;
  await f.submit(0);await f.submit(1);await assert.rejects(f.submit(2),/TOTAL_LIMIT/);assert.equal(f.runners.length,2);
 }finally{await f.close();}
 const g=setup();try{g.batch.parallelLimit=1;await g.submit(0);await assert.rejects(g.submit(1),/BATCH_LIMIT/);}finally{await g.close();}
 const h=setup();try{
  let quota:'unknown'|'exhausted'='exhausted';const scheduler=new WorkerScheduler(h.store,h.projects,h.execution,()=>quota);
  await assert.rejects(h.submit(0,scheduler),/QUOTA_EXHAUSTED/);assert.equal(scheduler.list().length,0);
  quota='unknown';scheduler.list();scheduler.reconcile();assert.equal(h.runners.length,0);
  await h.submit(0,scheduler);assert.equal(h.runners.length,1);
 }finally{await h.close();}
});

test('reservation generations fence late pre-spawn callbacks and changed requests conflict',async()=>{
 const f=setup();try{
  const a=await f.submit(0);new WorkerScheduler(f.store,f.projects,f.execution);
  assert.throws(f.guards[0],/FENCE_STALE/);
  await assert.rejects(f.scheduler.submit({batch:{...f.batch,parallelLimit:1},executionId:f.plans[0].id,approval:{confirmed:true,expectedPlanDigest:f.plans[0].planDigest},claims:f.claims(0)}),/IDEMPOTENCY_CONFLICT/);
  assert.equal(f.scheduler.read(a.reservationId).state,'lost_unknown');
 }finally{await f.close();}
});

for(const stage of ['worker.reserved','worker.dispatched','capability.execution','run.created','run.runtime_source','worker.running'] as const){
 test(`AX03: database reopen after ${stage} never redispatches the same attempt`,async()=>{
  const {Store}=await import('../server/store.ts'),{Projects}=await import('../server/projects.ts');
  const f=setup();let other:InstanceType<typeof Store>|undefined;
  try{
   let injected=false;
   f.store.on('event',event=>{if(!injected&&event.kind===stage){injected=true;throw Error('simulated crash');}});
   try{await f.submit(0);}catch{/* Intent survives even when the caller never receives an acknowledgement. */}
   assert.equal(injected,true);const original=f.scheduler.list()[0],before=f.runners.length;
   other=new Store(f.db);const projects=new Projects(other,f.managed,[],f.root);
   const execution=new CapabilityExecutionService(other,f.controller,()=>f.registry);
   const scheduler=new WorkerScheduler(other,projects,execution);
   const replay=await f.submit(0,scheduler);assert.equal(replay.attempt.id,original.attempt.id);assert.equal(replay.reservationId,original.reservationId);
   scheduler.list();scheduler.read(replay.reservationId);scheduler.reconcile();assert.equal(f.runners.length,before);assert.ok(before<=1);
  }finally{other?.close();await f.close();}
 });
}

test('terminal receipt survives restart; mismatched receipt cannot release claims',async()=>{
 const f=setup();try{
  const a=await f.submit(0);f.runners[0].finish();await tick();
  const scheduler=new WorkerScheduler(f.store,f.projects,f.execution);
  assert.equal(scheduler.read(a.reservationId).state,'terminal_confirmed');
  const run=f.store.findRequest(a.attempt.dispatchRequestId)!.run;
  f.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify({...run,planningContentHash:'f'.repeat(64)}),run.id);
  assert.throws(()=>scheduler.release(a.reservationId),/TERMINAL_REQUIRED/);
  f.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(run),run.id);
  assert.equal(scheduler.release(a.reservationId).state,'released');assert.equal(f.runners.length,1);
 }finally{await f.close();}
});

// General worker spaces live under the project folder, so an unconfirmed legacy run there may still reach them.
test('legacy lost run in the project folder blocks solo runs and worker attempts alike',async()=>{
 const f=setup();try{
  const legacy=f.store.createRun(randomUUID(),'legacy','legacy',undefined,{runtime:'claude-code',projectId:f.project.id,taskId:'old-task'});
  f.store.updateRun(legacy.id,{execution:'lost'},'run.lost');
  await assert.rejects(f.controller.submitTask(f.project.id,f.tasks[0].id,{requestId:randomUUID()}),/SOLO_RECOVERY_REQUIRED/);
  const r=await f.submit(0);assert.equal(f.runners.length,0);assert.equal(f.store.runs().length,1,'no Run recorded for the refused attempt');
  assert.equal(r.state,'released','a refusal before any Run record frees the reservation instead of leaking a slot');
 }finally{await f.close();}
});

test('code batch freezes approved workspace base, uses the existing single Codex channel and enforces Codex limit 1',async()=>{
 const {EventEmitter}=await import('node:events');
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('./temp.ts');
 const {Store}=await import('../server/store.ts'),{Projects}=await import('../server/projects.ts');
 const {Controller}=await import('../server/controller.ts'),{Studio}=await import('../server/studio.ts');
 const {repositoryIdentity}=await import('../server/repository-resource.ts');
 class FakeRpc extends EventEmitter {
  calls:{method:string;params:any}[]=[];
  async initialize(){} async close(){this.emit('closed');}
  async request(method:string,params:any):Promise<any>{
   this.calls.push({method,params});
   if(method==='account/read')return {account:{type:'chatgpt'}};
   if(method==='config/read')return {config:{mcp_servers:{}}};
   if(method==='mcpServerStatus/list')return {data:[]};
   if(method==='thread/start'||method==='thread/resume')return {thread:{id:'worker-thread',status:{type:'idle'}},approvalPolicy:params.approvalPolicy,approvalsReviewer:'user',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
   if(method==='turn/start')return {turn:{id:'worker-turn'}};return {};
  }
 }
 const dir=mkdtempSync(join(tmpdir(),'orbit-scheduler-code-')),store=new Store(join(dir,'db.sqlite')),projects=new Projects(store,join(dir,'managed'),[],join(dir,'projects'));
 const {project,workspace}=projects.createProject({requestId:randomUUID(),name:'Code worker',kind:'code'});
 const rpc=new FakeRpc();let channels=0;
 const controller=new Controller(store,dir,()=>{channels++;return rpc;},projects);
 try{
  await controller.selectWorkspace(workspace!.id);
  const studio=new Studio(store),input=JSON.parse(planningInput.text);input.requirements=[1,2].map(i=>({id:'R'+i,description:'Change file '+i,acceptance_criteria:['Keep existing behavior']}));
  const draft=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:{...planningInput,text:JSON.stringify(input)}}) as import('../shared/parallel.ts').PlanningVersion;
  const plan=studio.mutate(project.id,'plans',draft.id,'approve',{expectedRevision:1}) as typeof draft;
  const tasks=studio.mutate(project.id,'plans',plan.id,'task-drafts',{}) as SavedTask[];
  new TaskGraphService(store).save(project.id,{planningVersionId:plan.id,contentHash:plan.contentHash,expectedRevision:0,nodes:tasks.map(t=>({taskId:t.id})),edges:[]});
  const registry=discoverCapabilities({codexReady:true,probe:{checkedAt:new Date().toISOString(),codex:{status:'found',version:'0.165.0'},claude:{status:'found',version:'2.1.312'}}});
  const execution=new CapabilityExecutionService(store,controller,()=>registry),routing=new CapabilityRoutingService(store);
  const plans=tasks.map(t=>execution.plan(project.id,{requestId:randomUUID(),routeId:routing.recommend(project.id,{requestId:randomUUID(),taskId:t.id,text:'코드 구현'},registry).id,workspaceId:workspace!.id}));
  const scheduler=new WorkerScheduler(store,projects,execution),batch:ApprovedExecutionBatch={id:randomUUID(),projectId:project.id,planningVersionId:plan.id,planningHash:plan.contentHash,graphRevision:1,taskIds:tasks.map(t=>t.id),contractDigests:[],inputArtifactHashes:[],runtimeChoices:tasks.map(t=>({taskId:t.id,runtimeId:'codex'})),parallelLimit:2};
  const repositoryId=repositoryIdentity(join(project.path,'.git')).repositoryId;
  const submit=(i:number)=>scheduler.submit({batch,executionId:plans[i].id,approval:{confirmed:true,expectedPlanDigest:plans[i].planDigest},claims:[{kind:'repository_file',repositoryId,path:resolveWorkerPath(project.path,`file-${i}.txt`),mode:'write'}]});
  const a=await submit(0);assert.equal(a.state,'running');
  const run=store.findRequest(a.attempt.dispatchRequestId)!.run,worker=store.workspaces().find(w=>w.id===run.workspaceId)!;
  assert.notEqual(worker.id,workspace!.id);assert.equal(worker.baseSha,workspace!.baseSha);
  assert.equal(rpc.calls.find(c=>c.method==='turn/start')!.params.cwd,worker.path);assert.equal(channels,1);
  await assert.rejects(submit(1),/RUNTIME_LIMIT/);assert.equal(rpc.calls.filter(c=>c.method==='turn/start').length,1);
  const frozen=JSON.parse(String(store.db.prepare('SELECT body FROM worker_space_bases WHERE batch_id=?').get(batch.id)!.body));assert.equal(frozen.baseSha,workspace!.baseSha);
 }finally{await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a reserved attempt cannot escape through the ordinary execution approval endpoint',async()=>{
 const f=setup();try{
  f.store.on('event',event=>{if(event.kind==='worker.reserved')throw Error('crash before space');});
  await assert.rejects(f.submit(0),/crash before space/);
  await assert.rejects(f.execution.start(f.project.id,f.plans[0].id,{confirmed:true,expectedPlanDigest:f.plans[0].planDigest}),/WORKER_CONTEXT_REQUIRED/);
  assert.equal(f.runners.length,0);
 }finally{await f.close();}
});

test('lost attempt keeps conflicting claims while disjoint claims remain usable',async()=>{
 const f=setup();try{
  const a=await f.submit(0);f.runners[0].finish(outcome('unknown'));await tick();f.scheduler.reconcile();
  assert.equal(f.scheduler.read(a.reservationId).state,'lost_unknown');
  await assert.rejects(f.scheduler.submit({batch:f.batch,executionId:f.plans[1].id,approval:{confirmed:true,expectedPlanDigest:f.plans[1].planDigest},claims:f.claims(0)}),/RESOURCE_CONFLICT/);
  await f.submit(1);assert.equal(f.runners.length,2);
 }finally{await f.close();}
});

for(const state of ['creating','ready']){
 test(`AX03: crash while persisting space ${state} leaves the same attempt quarantined`,async()=>{
  const f=setup(),prepare=f.store.db.prepare.bind(f.store.db);let hit=false;
  try{
   f.store.db.prepare=((sql:string)=>{
    const statement=prepare(sql);
    if(!sql.startsWith('INSERT INTO worker_spaces'))return statement;
    const run=statement.run.bind(statement);
    statement.run=(...args)=>{const result=Reflect.apply(run,statement,args);if(!hit&&JSON.parse(String(args[1])).state===state){hit=true;throw Error('space crash');}return result;};return statement;
   }) as typeof f.store.db.prepare;
   await assert.rejects(f.submit(0),/space crash/);assert.equal(hit,true);assert.equal(f.runners.length,0);
   f.store.db.prepare=prepare;
   const original=f.scheduler.list()[0],scheduler=new WorkerScheduler(f.store,f.projects,f.execution);
   assert.equal((await f.submit(0,scheduler)).reservationId,original.reservationId);assert.equal(scheduler.read(original.reservationId).state,'lost_unknown');assert.equal(f.runners.length,0);
  }finally{f.store.db.prepare=prepare;await f.close();}
 });
}

test('late output path substitution is refused immediately before runtime dispatch',async()=>{
 const {rmSync,symlinkSync}=await import('node:fs');const f=setup();try{
  f.store.on('event',event=>{if(event.kind==='capability.execution'&&event.data.status==='dispatching'){
   const path=join(generalAttemptPath(f.project.path,f.plans[0].id),'output');rmSync(path,{recursive:true});symlinkSync(f.dir,path,'dir');
  }});
  const result=await f.submit(0);assert.equal(result.state,'lost_unknown');assert.equal(f.runners.length,0);
 }finally{await f.close();}
});

for(const scenario of [{staleAt:0,fault:''},{staleAt:2,fault:''},{staleAt:4,fault:''},{staleAt:0,fault:'not-integrated'},{staleAt:0,fault:'hash-changed'},{staleAt:0,fault:'input-missing'},{staleAt:0,fault:'unreleased'},{staleAt:0,fault:'refused'}])test(`fresh completion reader: stale at ${scenario.staleAt}, output ${scenario.fault||'valid'}`,async()=>{
 const {staleAt,fault}=scenario;
 const f=setup();try{
  const progress=new ProjectProgressService(f.store,f.studio),hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  mkdirSync(join(f.project.path,'output'),{recursive:true});writeFileSync(join(f.project.path,'output/report.txt'),'bound output');
  const manifest={files:[{path:'output/report.txt',status:'present',sha256:createHash('sha256').update('bound output').digest('hex'),outOfScope:false}],sourceDigest:'source',reservationId:'predecessor',inputsUnchanged:true,outOfScope:false};
  f.store.db.exec('CREATE TABLE IF NOT EXISTS integration_queue(body TEXT)');
  f.store.db.prepare('INSERT INTO integration_queue(body) VALUES(?)').run(JSON.stringify({id:'integration',released:fault!=='unreleased',projectId:f.project.id,status:fault==='not-integrated'?'queued':fault==='refused'?'refused':'applied',space:{attemptId:'predecessor',kind:'general'},manifest}));
  if(fault==='hash-changed')writeFileSync(join(f.project.path,'output/report.txt'),'changed');
  let reads=0;
  const reader={graph:(project:string,version:string)=>{
   const snapshot=progress.graph(project,version);reads++;
   if(fault==='input-missing'&&reads===3){const path=join(generalAttemptPath(f.project.path,f.plans[2].id),'inputs/output');chmodSync(path,0o755);rmSync(join(path,'report.txt'));}
   if(staleAt&&reads>=staleAt)return snapshot;
   const completion=snapshot.progress.tasks[0].completion!;
   completion.verifiedDone=true;completion.binding.artifactId='predecessor';completion.binding.artifactDigest=hash(manifest);
   snapshot.state.nodes=snapshot.state.nodes.map(n=>n.taskId===f.tasks[0].id?{taskId:n.taskId,state:'done'}:n.taskId===f.tasks[2].id?{taskId:n.taskId,state:'ready'}:n);
   return snapshot;
  }};
  const scheduler=new WorkerScheduler(f.store,f.projects,f.execution,undefined,reader);
  if(fault){await assert.rejects(f.submit(2,scheduler),/DEPENDENCY_OUTPUT_/);assert.equal(f.runners.length,0);
   if(fault==='input-missing'){assert.equal(scheduler.list()[0].state,'released');assert.equal(scheduler.list()[0].evidence?.kind,'not_dispatched');}
   else assert.equal(scheduler.list().length,0);
  }else if(staleAt){await assert.rejects(f.submit(2,scheduler),/DEPENDENCIES_WAITING/);assert.equal(f.runners.length,0);assert.equal(scheduler.list()[0].state,'released');assert.equal(scheduler.list()[0].evidence?.kind,'not_dispatched');}
  else{
   const result=await f.submit(2,scheduler);await f.submit(2,scheduler);assert.equal(f.runners.length,1);assert.ok(reads>=4);
   assert.equal(readFileSync(join(f.paths[0],'inputs/output/report.txt'),'utf8'),'bound output');
   const pinned=f.store.db.prepare('SELECT body FROM worker_space_handoffs WHERE attempt_id=?').get(f.plans[2].id);
   assert.ok(pinned);
   const restarted=new WorkerScheduler(f.store,f.projects,f.execution,undefined,reader);
   assert.equal((await f.submit(2,restarted)).reservationId,result.reservationId);assert.equal(f.runners.length,1);
   assert.equal(restarted.read(result.reservationId).state,'lost_unknown');
   assert.deepEqual(f.store.db.prepare('SELECT body FROM worker_space_handoffs WHERE attempt_id=?').get(f.plans[2].id),pinned);
  }
 }finally{await f.close();}
});

function appliedGeneral(f:ReturnType<typeof setup>,beforeRead?:(reads:number)=>void){
 const progress=new ProjectProgressService(f.store,f.studio),hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 mkdirSync(join(f.project.path,'output'),{recursive:true});writeFileSync(join(f.project.path,'output/report.txt'),'bound output');
 const manifest={files:[{path:'output/report.txt',status:'present',sha256:createHash('sha256').update('bound output').digest('hex'),outOfScope:false}],sourceDigest:'source',reservationId:'predecessor',inputsUnchanged:true,outOfScope:false};
 f.store.db.exec('CREATE TABLE IF NOT EXISTS integration_queue(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,input_digest TEXT NOT NULL,slot INTEGER UNIQUE CHECK(slot=1),body TEXT NOT NULL)');
 f.store.db.prepare('INSERT INTO integration_queue VALUES(?,?,?,NULL,?)').run('integration','integration','fixture',JSON.stringify({id:'integration',projectId:f.project.id,status:'applied',released:true,space:{attemptId:'predecessor',kind:'general'},manifest}));
 let reads=0;
 const reader={graph:(project:string,version:string)=>{
  beforeRead?.(++reads);const snapshot=progress.graph(project,version),completion=snapshot.progress.tasks[0].completion!;
  completion.verifiedDone=true;completion.binding.artifactId='predecessor';completion.binding.artifactDigest=hash(manifest);
  snapshot.state.nodes=snapshot.state.nodes.map(n=>n.taskId===f.tasks[2].id?{taskId:n.taskId,state:'ready'}:n);
  return snapshot;
 }};
 return new WorkerScheduler(f.store,f.projects,f.execution,undefined,reader);
}

for(const change of ['identical bytes','different bytes','unrelated file'] as const)test(`CQG-6b: general handoff revalidates ${change} after pinning`,async()=>{
 const f=setup();try{
  const scheduler=appliedGeneral(f,reads=>{if(reads===3)writeFileSync(join(f.project.path,'output',change==='unrelated file'?'unrelated.txt':'report.txt'),change==='identical bytes'?'bound output':'changed');});
  if(change==='different bytes'){
   await assert.rejects(f.submit(2,scheduler),/WORKER_DEPENDENCY_OUTPUT_CHANGED/);
   assert.equal(f.runners.length,0);assert.equal(scheduler.list()[0].evidence?.kind,'not_dispatched');
  }else{
   const r=await f.submit(2,scheduler);assert.equal(f.runners.length,1);
   const space=JSON.parse(String(f.store.db.prepare('SELECT body FROM worker_spaces WHERE reservation_id=?').get(r.reservationId)!.body));
   assert.equal(readFileSync(join(space.path,'inputs/output/report.txt'),'utf8'),'bound output');
   assert.deepEqual(space.inputManifest,[{path:'output/report.txt',sha256:createHash('sha256').update('bound output').digest('hex')}]);
  }
 }finally{await f.close();}
});

test('CQG-6b: consumed plan cannot redispatch after bytes recover; a new plan requires its own approval',async()=>{
 const f=setup();try{
  const scheduler=appliedGeneral(f,reads=>{if(reads===3)writeFileSync(join(f.project.path,'output/report.txt'),'changed');});
  await assert.rejects(f.submit(2,scheduler),/WORKER_DEPENDENCY_OUTPUT_CHANGED/);
  const consumed=scheduler.list()[0];assert.equal(consumed.state,'released');assert.equal(consumed.evidence?.kind,'not_dispatched');
  writeFileSync(join(f.project.path,'output/report.txt'),'bound output');
  assert.equal((await f.submit(2,scheduler)).reservationId,consumed.reservationId);assert.equal(f.runners.length,0);
  const fresh=f.execution.plan(f.project.id,{requestId:randomUUID(),routeId:f.plans[2].routeId});
  const input={batch:f.batch,executionId:fresh.id,approval:{confirmed:true as const,expectedPlanDigest:f.plans[2].planDigest},claims:[{kind:'isolated_folder' as const,host:'local',path:resolveWorkerPath(f.project.path,join(generalAttemptPath(f.project.path,fresh.id),'output'),true)}]};
  await assert.rejects(scheduler.submit(input),/WORKER_APPROVAL_REQUIRED/);assert.equal(f.runners.length,0);
  input.approval.expectedPlanDigest=fresh.planDigest;
  const result=await scheduler.submit(input);assert.notEqual(result.reservationId,consumed.reservationId);assert.equal(f.runners.length,1);
  await scheduler.submit(input);assert.equal(f.runners.length,1);
 }finally{await f.close();}
});

test('CQG-6b open item: controller batch input hash gate blocks general dependent dispatch',async()=>{
 const f=setup();try{
  f.controller.initializeWorkers(f.execution);
  const view=f.controller.createWorkerBatch(f.project.id,{requestId:randomUUID(),planningVersionId:f.version.id,graphRevision:1,planningHash:f.version.contentHash,confirmed:true,executions:f.plans.map(p=>({executionId:p.id,expectedPlanDigest:p.planDigest}))});
  Object.assign(f.batch,JSON.parse(String(f.store.db.prepare('SELECT body FROM worker_http_batches WHERE id=?').get(view.id)!.body)).batch);
  let dispatchFailure='';const submitTask=f.controller.submitTask.bind(f.controller);
  f.controller.submitTask=async(...args)=>{try{return await submitTask(...args);}catch(error){dispatchFailure=(error as Error).message;throw error;}};
  const scheduler=appliedGeneral(f),result=await f.submit(2,scheduler);
  assert.equal(dispatchFailure,'WORKER_INPUTS_CHANGED');assert.equal(f.runners.length,0);
  assert.equal(f.store.findRequest(result.attempt.dispatchRequestId),null);
  const space=JSON.parse(String(f.store.db.prepare('SELECT body FROM worker_spaces WHERE reservation_id=?').get(result.reservationId)!.body));
  assert.equal(readFileSync(join(space.path,'inputs/output/report.txt'),'utf8'),'bound output');
  assert.equal(space.inputManifest.length,1,'handoff remains visible to the input hash gate');
  assert.equal(f.execution.record(f.project.id,f.plans[2].id).status,'recovery_required');
  await f.submit(2,scheduler);assert.equal(f.runners.length,0);
 }finally{await f.controller.stopWorkers();await f.close();}
});
