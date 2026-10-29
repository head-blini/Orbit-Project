import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {Projects} from '../server/projects.ts';
import {ProjectProgressService} from '../server/project-progress.ts';
import {generalCheckerDigest,QualityProgressCollector} from '../server/quality-progress.ts';
import {qualityVerifyGeneral} from '../server/quality-loop-native.ts';
import {listDeliverables} from '../server/deliverables.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {QualityStepContext} from '../shared/quality-loop-record.ts';

const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'orbit-qg-')),path=join(dir,'state.sqlite'),store=new Store(path),studio=new Studio(store);
 const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects'));
 const {project}=projects.createProject({requestId:randomUUID(),name:'Research',kind:'general'});
 const draft=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Report',goal:'Research',requirements:[{id:'R1',description:'Report',acceptance_criteria:['Cite sources']}],constraints:[],open_questions:[]})}}) as PlanningVersion;
 const plan=studio.mutate(project.id,'plans',draft.id,'approve',{expectedRevision:1}) as PlanningVersion;
 const [task]=studio.mutate(project.id,'plans',plan.id,'task-drafts',{}) as SavedTask[];
 const run=store.createRun(randomUUID(),'a'.repeat(64),'Report',undefined,{runtime:'claude-code',projectId:project.id,taskId:task.id,planningVersionId:plan.id,planningContentHash:plan.contentHash,requirementLabels:task.requirementLabels});
 store.updateRun(run.id,{execution:'completed'},'run.completed');
 writeFileSync(join(project.path,'report.md'),'# Report\nSource listed.');
 const deliverables=()=>listDeliverables(project.path,[]);
 const context:QualityStepContext={loopId:'loop',stepId:'check',sourceRun:store.getRun(run.id)!,version:plan,task,signal:new AbortController().signal,artifact:{id:project.id,digest:hash(deliverables().items.map(i=>({path:i.path,digest:i.sha256})))}};
 const service=new ProjectProgressService(store,studio,{deliverables});
 return {dir,path,store,studio,projects,project,plan,task,run,context,deliverables,service,read:()=>service.read(project.id,{}).tasks[0].quality!,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('general format evidence is current but does not imply semantic review or approval',async()=>{
 const f=fixture();try{
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  const q=f.read();assert.equal(q.execution.status,'completed');assert.equal(q.format.status,'passed');
  assert.equal(q.semantic.status,'not_run');assert.equal(q.independentReview.status,'not_run');assert.equal(q.userApproval.status,'not_run');
  assert.equal(q.evidence[0].binding.taskId,f.task.id);assert.equal(q.evidence[0].binding.runId,f.run.id);
  assert.equal(q.evidence[0].freshness,'current');assert.equal(q.evidence[0].evidenceSource,'local');
  assert.equal(f.service.read(f.project.id,{}).totals.verifiedTasks,0);
 }finally{f.close();}
});
test('missing evidence and historical unbound checks never become passed',async()=>{
 const f=fixture();try{
  assert.equal(f.read().format.status,'not_run');await qualityVerifyGeneral(f.store,f.projects,f.context);
  const body=JSON.parse(String(f.store.db.prepare('SELECT body FROM quality_artifact_checks').get()!.body));
  delete body.projectId;delete body.taskId;delete body.planningVersionId;delete body.artifactId;delete body.evidenceSource;
  f.store.db.prepare('UPDATE quality_artifact_checks SET body=?').run(JSON.stringify(body));
  assert.notEqual(f.read().format.status,'passed');assert.equal(f.read().evidence[0].evidenceSource,'unknown');
 }finally{f.close();}
});
test('artifact changes invalidate evidence and a new check verifies repaired output',async()=>{
 const f=fixture();try{
  await qualityVerifyGeneral(f.store,f.projects,f.context);writeFileSync(join(f.project.path,'report.md'),'# Revised report');
  assert.equal(f.read().format.status,'stale');
  f.context.stepId='check-2';f.context.artifact.digest=hash(f.deliverables().items.map(i=>({path:i.path,digest:i.sha256})));
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  assert.equal(f.read().format.status,'passed');assert.equal(f.read().evidence.length,2);
 }finally{f.close();}
});
test('changed approved plan hash makes previously passed evidence stale',async()=>{
 const f=fixture();try{
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  f.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify({...f.context.sourceRun,planningContentHash:'b'.repeat(64)}),f.run.id);
  assert.equal(f.read().format.status,'stale');
 }finally{f.close();}
});
for(const field of ['projectId','taskId','sourceRunId'] as const)test(`${field} mismatch cannot verify a task`,async()=>{
 const f=fixture();try{
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  const body=JSON.parse(String(f.store.db.prepare('SELECT body FROM quality_artifact_checks').get()!.body));body[field]='wrong';
  f.store.db.prepare('UPDATE quality_artifact_checks SET body=?').run(JSON.stringify(body));
  assert.notEqual(f.read().format.status,'passed');
 }finally{f.close();}
});
test('progress reads do not write DB or files and survive server-store restart',async()=>{
 const f=fixture();let reopened:Store|undefined;try{
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  const seq=f.store.lastSeq(),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n,files=f.deliverables();
  const before=f.read();assert.deepEqual(f.read(),before);assert.equal(f.store.lastSeq(),seq);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);assert.deepEqual(f.deliverables(),files);
  f.store.close();reopened=new Store(f.path);
  const after=new ProjectProgressService(reopened,new Studio(reopened),{deliverables:f.deliverables}).read(f.project.id,{}).tasks[0].quality;
  assert.deepEqual(after,before);
 }finally{if(reopened){reopened.close();rmSync(f.dir,{recursive:true,force:true});}else f.close();}
});

import {QualityLoopService} from '../server/quality-loop-service.ts';
import type {QualityModelEvidence,QualityServicePorts} from '../shared/quality-loop-record.ts';
import {CodexModelTracker} from '../server/codex-model-attribution.ts';
import {VerificationService,readVerificationConfiguration} from '../server/verification-service.ts';
import {createHttpServer} from '../server/http.ts';
import type {Controller} from '../server/controller.ts';
import type {ProjectProgress} from '../shared/project-progress.ts';

async function loop(f:ReturnType<typeof fixture>,options:{unknown?:boolean;sameModel?:boolean;negative?:boolean;repair?:boolean;source?:'native'|'mock';formatFailure?:boolean}={}){
 let reviews=0;
 const evidence=(modelId:string|null,id:string):QualityModelEvidence=>({providerId:'fixture',modelId,sessionId:id,runId:id,source:modelId?'native_observed':'unknown',evidenceSource:options.source??'mock'});
 const ports:QualityServicePorts={guard(){},snapshot:()=>({artifact:f.context.artifact,producer:evidence(options.unknown?null:'writer',f.run.id)}),
  review:async request=>{reviews++;const id=`review-${reviews}`;return {evidence:evidence('reviewer',id),review:{modelKey:'fixture/reviewer',sessionId:id,baselineDigest:request.baseline.digest,artifactDigest:request.artifact.digest,criteria:request.baseline.criteria.map(criterion=>({criterion,status:options.negative||(options.repair&&reviews===1)?'not_met':'met',evidence:'Fixture opinion'})),findings:[]}};},
  repair:async()=>{writeFileSync(join(f.project.path,'report.md'),'# Repaired');const artifact={id:f.project.id,digest:hash(f.deliverables().items.map(i=>({path:i.path,digest:i.sha256})))};return {artifact,evidence:evidence('writer','repair')};},
  verify:async context=>options.formatFailure?{status:'failed',checkIds:[],issue:'FORMAT_FAILED'}:qualityVerifyGeneral(f.store,f.projects,context)};
 const service=new QualityLoopService(f.store,ports),reviewers=[{id:'reviewer',providerId:'fixture',modelId:options.sameModel?'writer':'reviewer'}],limits={maxRepairs:options.repair?1:0,maxCalls:6,timeoutMs:5000};
 const preview=service.preview(f.project.id,f.run.id,reviewers,limits);
 const record=service.start({projectId:f.project.id,sourceRunId:f.run.id,reviewers,limits,requestId:randomUUID(),confirmed:true,expectedPreviewDigest:preview.previewDigest});
 const settled=await service.settled(record.id);
 // Fake native review receipts capture the checker version, as the native bridge does.
 f.store.db.exec('CREATE TABLE IF NOT EXISTS quality_native_receipts(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
 for(const step of settled.steps.filter(s=>s.kind==='review'&&s.state==='completed')){
  const result=step.result as {artifactDigest:string};
  f.store.db.prepare('INSERT INTO quality_native_receipts VALUES(?,?)').run(step.id,JSON.stringify({id:step.id,loopId:settled.id,sourceRunId:f.run.id,baselineDigest:f.plan.contentHash,artifactDigest:result.artifactDigest,checkerDigest:generalCheckerDigest()}));
 }
 return settled;
}
test('independent-review blocker and unknown actual model remain explicit',async()=>{
 for(const unknown of [false,true]){const f=fixture();try{
  const record=await loop(f,{unknown,sameModel:!unknown});
  assert.equal(record.result.status,'blocked');assert.equal(f.read().independentReview.status,'blocked');
  assert.ok(f.read().independentReview.blockers.includes(unknown?'QUALITY_PRODUCER_MODEL_UNKNOWN':'INDEPENDENT_MODEL_REQUIRED'));
  assert.notEqual(f.read().semantic.status,'passed');
 }finally{f.close();}}
});
test('mock review completion is recorded evidence, never actual semantic success',async()=>{
 const f=fixture();try{await loop(f);const q=f.read();assert.equal(q.semantic.status,'recorded');assert.equal(q.independentReview.status,'recorded');assert.equal(q.format.status,'passed');assert.equal(q.userApproval.status,'not_run');}finally{f.close();}
});
test('completed independent review remains distinct from unmet semantic criteria',async()=>{
 const f=fixture();try{await loop(f,{negative:true,source:'native'});const q=f.read();assert.equal(q.semantic.status,'failed');assert.equal(q.independentReview.status,'completed');assert.equal(q.format.status,'passed');}finally{f.close();}
});
test('semantic opinion does not inherit failure of local format verification',async()=>{
 const f=fixture();try{await loop(f,{formatFailure:true,source:'native'});const q=f.read();assert.equal(q.semantic.status,'passed');assert.equal(q.independentReview.status,'completed');assert.notEqual(q.format.status,'passed');}finally{f.close();}
});
test('repair and revalidation refer to the new artifact and preserve prior checks',async()=>{
 const f=fixture();try{await loop(f,{repair:true,source:'native'});const q=f.read();assert.equal(q.repair.status,'completed');assert.equal(q.revalidation.status,'passed');assert.equal(q.format.status,'passed');assert.equal(q.evidence.filter(e=>e.kind==='artifact_check').length,2);assert.equal(q.evidence[0].freshness,'stale');}finally{f.close();}
});
test('stored Codex attribution never upgrades actual unknown from a loop model claim',async()=>{
 const f=fixture();try{await loop(f,{source:'native'});const tracker=new CodexModelTracker((id,v)=>f.store.saveCodexModelAttribution(id,v));tracker.connect('thread/start',{model:'configured',thread:{id:'thread'}});tracker.begin(f.run.id);assert.equal(f.read().semantic.status,'blocked');assert.ok(f.read().independentReview.blockers.includes('QUALITY_PRODUCER_MODEL_UNKNOWN'));}finally{f.close();}
});
test('existing code verification and explicit user approval are independent of AI review',async()=>{
 const f=fixture();let verification:VerificationService|undefined;try{
  const workspace={id:'ws',projectId:f.project.id,path:f.dir,branch:'fixture',baseSha:'a'.repeat(40),createdAt:'',status:'ready' as const};f.store.saveWorkspace(workspace);
  f.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify({...f.context.sourceRun,workspaceId:'ws'}),f.run.id);
  let digest='c'.repeat(64);const projects={writable:()=>workspace,list:()=>[{...f.project,path:f.dir}],fingerprint:()=>digest} as unknown as Projects;
  writeFileSync(join(f.dir,'check.mjs'),'process.exit(0);');
  verification=new VerificationService(f.store,projects,readVerificationConfiguration(JSON.stringify([{projectPath:f.dir,id:'check',label:'Local check',executable:process.execPath,args:[join(f.dir,'check.mjs')],timeoutMs:5000}])));
  const service=new ProjectProgressService(f.store,f.studio,{verification:(w,r)=>verification!.view(w,r)}),read=()=>service.read(f.project.id,{}).tasks[0];
  const initial=verification.view('ws',f.run.id);
  verification.start({requestId:randomUUID(),runId:f.run.id,workspaceId:'ws',commandId:'check',expectedSourceDigest:digest,expectedConfigDigest:initial.commands[0].configDigest});await verification.settle();
  assert.equal(read().stage,'verified');assert.equal(read().quality!.codeVerification.status,'passed');assert.equal(read().quality!.semantic.status,'not_run');assert.equal(read().quality!.userApproval.status,'not_run');
  const captured=f.store.db.prepare('SELECT id,body FROM verification_checks').get()!;
  const changed=JSON.parse(String(captured.body));changed.configDigest='f'.repeat(64);
  f.store.db.prepare('UPDATE verification_checks SET body=? WHERE id=?').run(JSON.stringify(changed),captured.id);
  assert.equal(read().quality!.evidence.find(e=>e.id===captured.id)?.freshness,'stale');
  f.store.db.prepare('UPDATE verification_checks SET body=? WHERE id=?').run(captured.body,captured.id);
  const view=verification.view('ws',f.run.id);verification.approve({requestId:randomUUID(),runId:f.run.id,workspaceId:'ws',expectedSourceDigest:digest,expectedCheckSetDigest:view.checkSetDigest!});
  assert.equal(read().quality!.userApproval.status,'passed');
  changed.configDigest=JSON.parse(String(captured.body)).configDigest;changed.projectId='foreign-project';
  f.store.db.prepare('UPDATE verification_checks SET body=? WHERE id=?').run(JSON.stringify(changed),captured.id);
  assert.notEqual(read().quality!.userApproval.status,'passed');
  f.store.db.prepare('UPDATE verification_checks SET body=? WHERE id=?').run(captured.body,captured.id);
  digest='d'.repeat(64);assert.equal(read().quality!.codeVerification.status,'stale');assert.equal(read().quality!.userApproval.status,'stale');
 }finally{await verification?.close();f.close();}
});
test('HTTP GET exposes quality without executing providers or changing stored evidence',async()=>{
 const f=fixture();let calls=0;
 const controller={store:f.store,snapshot:()=>({provider:'disconnected'}),claudeQuota:()=>null,deliverables:f.deliverables,submit:()=>{calls++;throw Error('FORBIDDEN');}} as unknown as Controller;
 const server=createHttpServer(controller,'unused');
 try{
  await qualityVerifyGeneral(f.store,f.projects,f.context);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0];
  const changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n,seq=f.store.lastSeq(),files=f.deliverables();
  for(let i=0;i<2;i++){const response=await fetch(origin+`/api/projects/${f.project.id}/progress`,{headers:{cookie}});assert.equal(response.status,200);const p=await response.json() as ProjectProgress;assert.equal(p.tasks[0].quality?.format.status,'passed');}
  assert.equal(calls,0);assert.equal(f.store.lastSeq(),seq);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);assert.deepEqual(f.deliverables(),files);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});

test('post-repair verification needs matching observed checks, not only loop status',async()=>{
 for(const mode of ['missing','mock','legacy']){const f=fixture();try{
  await loop(f,{repair:true,source:'native'});
  assert.equal(f.read().revalidation.status,'passed');
  if(mode==='missing')f.store.db.exec('DELETE FROM quality_artifact_checks');
  else for(const row of f.store.db.prepare('SELECT id,body FROM quality_artifact_checks').all()){
   const check=JSON.parse(String(row.body));if(mode==='mock')check.evidenceSource='mock';else delete check.evidenceSource;
   f.store.db.prepare('UPDATE quality_artifact_checks SET body=? WHERE id=?').run(JSON.stringify(check),row.id);
  }
  assert.notEqual(f.read().revalidation.status,'passed',mode);
 }finally{f.close();}}
});
test('superseded baseline and missing current artifact reader cannot claim current quality',async()=>{
 const f=fixture();try{
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  const unreadable=new ProjectProgressService(f.store,f.studio,{deliverables:()=>{throw Error('UNAVAILABLE');}});
  assert.equal(unreadable.read(f.project.id,{}).tasks[0].quality!.format.status,'unknown');
  f.store.db.prepare('UPDATE planning_heads SET version_id=? WHERE lineage_id=?').run('new-approved-version',f.plan.lineageId!);
  assert.equal(f.read().format.status,'stale');assert.ok(f.read().format.blockers.includes('QUALITY_BASELINE_CHANGED'));
 }finally{f.close();}
});

test('accepted round without matching review step evidence is unavailable, not semantic success',async()=>{
 const f=fixture();try{
  const record=await loop(f,{source:'native'});
  record.steps=record.steps.filter(s=>s.kind!=='review');
  f.store.db.prepare('UPDATE quality_loops SET body=? WHERE id=?').run(JSON.stringify(record),record.id);
  assert.equal(f.read().semantic.status,'unknown');assert.equal(f.read().independentReview.status,'unknown');
 }finally{f.close();}
});

test('GET request handler returns quality and authenticates without storage or provider side effects',async()=>{
 const f=fixture();let calls=0;
 const controller={store:f.store,snapshot:()=>({provider:'disconnected'}),claudeQuota:()=>null,deliverables:f.deliverables,submit:()=>{calls++;throw Error('FORBIDDEN');}} as unknown as Controller;
 const server=createHttpServer(controller,'unused');
 // Transport-only test double: the production request handler and session gate execute unchanged.
 server.address=()=>({address:'127.0.0.1',family:'IPv4',port:12345});
 const request=(url:string,cookie?:string)=>new Promise<{status:number;headers:Record<string,string>;body:ProjectProgress}>(resolve=>{
  const headers:Record<string,string>={};let status=0;
  server.emit('request',{method:'GET',url,headers:{host:'127.0.0.1:12345',...(cookie?{cookie}:{})}},
   {headersSent:false,setHeader:(name:string,value:string)=>{headers[name]=value;},writeHead:(value:number)=>{status=value;},end:(body:string)=>resolve({status,headers,body:JSON.parse(body)})});
 });
 try{
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  const path=`/api/projects/${f.project.id}/progress`;assert.equal((await request(path)).status,401);
  const session=await request('/api/session'),cookie=session.headers['Set-Cookie'].split(';')[0];
  const changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n,seq=f.store.lastSeq(),files=f.deliverables();
  for(let i=0;i<2;i++){const response=await request(path,cookie);assert.equal(response.status,200);assert.equal(response.body.tasks[0].quality?.format.status,'passed');}
  assert.equal(calls,0);assert.equal(f.store.lastSeq(),seq);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);assert.deepEqual(f.deliverables(),files);
 }finally{server.emit('close');f.close();}
});

test('legacy artifact-check replay preserves stored bytes and still rejects incomplete records',async()=>{
 const f=fixture();try{
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  const saved=JSON.parse(String(f.store.db.prepare('SELECT body FROM quality_artifact_checks').get()!.body));
  for(const key of ['projectId','taskId','planningVersionId','artifactId','evidenceSource'])delete saved[key];
  const legacy=JSON.stringify(saved);f.store.db.prepare('UPDATE quality_artifact_checks SET body=?').run(legacy);
  await qualityVerifyGeneral(f.store,f.projects,f.context);
  assert.equal(f.store.db.prepare('SELECT body FROM quality_artifact_checks').get()!.body,legacy);
  f.store.db.prepare('UPDATE quality_artifact_checks SET body=?').run('{}');
  await assert.rejects(qualityVerifyGeneral(f.store,f.projects,f.context),/QUALITY_CHECK_REPLAY_MISMATCH/);
 }finally{f.close();}
});


test('semantic evidence becomes stale after a checker change and unavailable without its receipt',async()=>{
 const f=fixture();try{
  await loop(f,{source:'native'});
  const collector=new QualityProgressCollector(f.store,{deliverables:f.deliverables,checkerDigest:generalCheckerDigest(undefined,'changed-checker')});
  const stale=collector.read(f.project.id,f.task,f.context.sourceRun,f.plan,true);
  assert.equal(stale.semantic.status,'stale');assert.ok(stale.semantic.blockers.includes('QUALITY_CHECKER_CHANGED'));
  f.store.db.exec('DELETE FROM quality_native_receipts');
  assert.equal(f.read().semantic.status,'unknown');assert.ok(f.read().semantic.blockers.includes('QUALITY_CHECKER_BINDING_MISSING'));
 }finally{f.close();}
});
