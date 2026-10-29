import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {ParallelWorkerService} from '../server/parallel-workers.ts';
import {WorkerSpaces,generalAttemptPath} from '../server/worker-spaces.ts';
import {repositoryIdentity} from '../server/repository-resource.ts';
import {trustedGit} from '../server/git-process.ts';
import {VerificationService} from '../server/verification-service.ts';
import {MergeService} from '../server/merge-service.ts';
import {IntegrationQueue,readCandidateCompletion,type IntegrationItem,type IntegrationCompletionEvidence} from '../server/integration-queue.ts';
import {CODE_GATES,GENERAL_GATES,type CompletionPolicy,type CompletionEvidence} from '../shared/task-completion.ts';
import {completionPolicyDigest} from '../server/task-completion.ts';
import {readVerificationConfiguration,verificationCommandPreviews,verificationGateCommandMap} from '../server/verification-configuration.ts';
import type {QualityDimension} from '../shared/quality-progress.ts';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dimension=(status:QualityDimension['status']='not_run',evidenceIds:string[]=[]):QualityDimension=>({status,evidenceIds,blockers:[],nextAction:null});
// Native model/review observations are fixtures, never live provider evidence.
function candidateEvidence(item:IntegrationItem,store:Store,policy:CompletionPolicy,commands:CompletionEvidence['commands']):IntegrationCompletionEvidence {
 const reservation=new ParallelWorkerService(store).read(item.fence.reservationId);
 const binding={projectId:item.projectId,taskId:reservation.attempt.taskId,runId:'run-producer',planningVersionId:reservation.batch.planningVersionId,
  planningContentHash:item.approvedBaseline,acceptanceDigest:'acceptance',artifactId:item.id,artifactDigest:item.candidateDigest,
  graphRevision:String(reservation.batch.graphRevision),contractDigest:digest(reservation.batch.contractDigests),policyDigest:completionPolicyDigest(policy),configDigest:item.configDigest,
  artifactScope:item.space.kind==='code'?'workspace' as const:'task_manifest' as const,baseSha:item.target?.head??null,inputSnapshotDigest:item.space.inputDigest};
 const model=(id:string)=>({providerId:'provider',modelId:id,sessionId:'session-'+id,runId:'run-'+id,source:'native_observed' as const,evidenceSource:'native' as const});
 const evidence:CompletionEvidence={quality:{execution:{...dimension('completed'),evidenceSource:'native'},format:dimension(),codeVerification:dimension(),semantic:dimension(),independentReview:dimension(),repair:dimension(),revalidation:dimension(),userApproval:dimension(),evidence:[]},
  producer:{binding:{...binding},model:model('producer')},bindings:{},checks:[],commands,loops:[],gateResults:[],approvals:[]};
 const add=(id:string,kind:'verification_check'|'artifact_check'|'quality_loop',source:'local'|'native'='local')=>{
  evidence.bindings[id]={...binding};evidence.quality.evidence.push({id,kind,evidenceSource:source,freshness:'current',recordedStatus:'passed',binding:{...binding},blockers:[]});
 };
 if(item.space.kind==='code'){
  for(const row of store.db.prepare('SELECT id,body FROM integration_checks').all()){
   const check=JSON.parse(String(row.body)),r=check.result;
   if(check.integrationId!==item.id||check.sourceDigest!==item.candidateDigest||r?.baseSha!==item.target?.head)continue;
   const id=String(row.id);add(id,'verification_check');
   evidence.checks.push({id,requestId:id,runId:binding.runId,projectId:item.projectId,workspaceId:item.id,taskId:binding.taskId,planningVersionId:binding.planningVersionId,
    planningContentHash:binding.planningContentHash,acceptanceDigest:binding.acceptanceDigest,commandId:check.commandId,configDigest:commands.find(c=>c.id===check.commandId)!.configDigest,
    baseSha:r.baseSha,sourceDigest:r.sourceDigest,finishedDigest:r.finishedDigest,createdAt:r.startedAt,completedAt:new Date(Date.parse(r.startedAt)+r.durationMs).toISOString(),
    execution:'completed',verdict:r.status,exitCode:r.exitCode,durationMs:r.durationMs,output:r.output,recoveredAt:null,evidenceSource:'local'});
  }
 }else{
  for(const gate of ['artifact_format','numeric_source'] as const){const id=item.id+gate;add(id,'artifact_check');evidence.gateResults.push({gate,evidenceId:id,status:'passed'});}
  const id=item.id+'review';add(id,'quality_loop','native');evidence.quality.semantic=dimension('passed',[id]);evidence.quality.independentReview=dimension('completed',[id]);
  const artifact={id:item.id,digest:item.candidateDigest!},review={modelKey:'provider/reviewer',sessionId:'session-reviewer',baselineDigest:item.approvedBaseline,artifactDigest:item.candidateDigest!,criteria:[{criterion:'correct',status:'met' as const,evidence:'checked candidate'}],findings:[]};
  evidence.loops.push({id,projectId:item.projectId,taskId:binding.taskId,sourceRunId:binding.runId,baseline:{id:binding.planningVersionId,digest:item.approvedBaseline,criteria:['correct']},producer:model('producer'),reviewers:[{id:'reviewer',providerId:'provider',modelId:'reviewer'}],recoveryRequired:false,
   result:{status:'passed',issue:null,calls:1,repairs:0,artifact,rounds:[{number:1,artifact,reviews:[{reviewerId:'reviewer',result:review}],failures:[]}]},
   steps:[{id:'review-step',index:1,kind:'review',state:'completed',requestDigest:'request',startedAt:'start',finishedAt:'finish',issue:null,evidence:model('reviewer'),result:review}],verification:{status:'passed',checkIds:[],issue:null}});
 }
 return {subject:{integrationId:item.id,candidateDigest:item.candidateDigest!,targetDigest:item.target?.head??item.generalTargetDigest},binding,evidence};
}

test('candidate commands alone cannot apply without a completion policy and evidence',async()=>{
 const f=fixture();try{
  const projects=new Projects(f.store,join(f.root,'managed'),[f.repo]);
  const queue=new IntegrationQueue(f.store,projects,f.workers,f.spaces,f.verification,f.merge,()=>({approvedBaseline:f.policy.approvedBaseline,defaultBranch:'trunk',requiredChecks:['full']}));
  const w=f.worker('a.txt','A'),q=queue.enqueue({requestId:randomUUID(),fence:w.r,targetBranch:'dev'});
  await queue.drain();assert.equal(queue.get(q.id).status,'refused');assert.equal(queue.get(q.id).reason,'INTEGRATION_COMPLETION_POLICY_REQUIRED');assert.equal(f.git('rev-parse','HEAD'),f.base);
 }finally{f.store.close();}
});

function fixture(kind:'code'|'general'='code',args=['-e','process.exit(0)']){
  const root=mkdtempSync(join(tmpdir(),'orbit-integration-')),repo=join(root,'repo');mkdirSync(repo);
  const git=(...args:string[])=>trustedGit(repo,args,{identity:true}).toString().trim();
  if(kind==='code'){git('init','-b','dev');writeFileSync(join(repo,'a.txt'),'base\n');writeFileSync(join(repo,'b.txt'),'base\n');git('add','.');git('commit','-m','base');}
  const store=new Store(join(root,'state.sqlite')),projects=new Projects(store,join(root,'managed'),[repo],join(root,'created'));
  const project=kind==='code'?projects.register(repo):projects.createProject({requestId:randomUUID(),name:'General',kind}).project;
  const base=kind==='code'?git('rev-parse','HEAD'):'0'.repeat(40),workers=new ParallelWorkerService(store),spaces=new WorkerSpaces(store,projects,workers);
  const configuration=readVerificationConfiguration(JSON.stringify([{projectPath:project.path,id:'full',label:'Full regression',executable:process.execPath,args,timeoutMs:10000,categories:[...CODE_GATES]}]));
  const verification=new VerificationService(store,projects,configuration);
  const merge=new MergeService(store,projects,verification,()=>false);
  const completionPolicy:CompletionPolicy={projectKind:kind,requiredGates:[...(kind==='code'?CODE_GATES:GENERAL_GATES)],gateCommandMap:verificationGateCommandMap(configuration,project.path),notApplicable:[],requireIndependentReview:kind==='general',dependencyRelease:'quality_passed'};
  const policy={approvedBaseline:'a'.repeat(64),defaultBranch:'trunk',requiredChecks:['full'],completionPolicy};
  const completion={read:(item:IntegrationItem):IntegrationCompletionEvidence|null=>candidateEvidence(item,store,policy.completionPolicy,verificationCommandPreviews(configuration,project.path))};
  const makeQueue=()=>new IntegrationQueue(store,projects,workers,spaces,verification,merge,()=>policy,item=>completion.read(item));
  const queue=makeQueue();
  const worker=(file:string,content:string)=>{
    const attempt=randomUUID(),path=kind==='code'?file:join(generalAttemptPath(project.path,attempt),'output');
    const r=workers.reserve({requestId:randomUUID(),ownerIncarnation:'test',batch:{id:randomUUID(),projectId:project.id,planningVersionId:'approved',graphRevision:1,planningHash:policy.approvedBaseline,taskIds:[attempt],contractDigests:[],inputArtifactHashes:[],runtimeChoices:[{taskId:attempt,runtimeId:'claude-code'}],parallelLimit:2},attempt:{id:attempt,taskId:attempt,runtimeId:'claude-code',dispatchRequestId:randomUUID()},claims:[kind==='code'?{kind:'repository_file',repositoryId:repositoryIdentity(join(repo,'.git')).repositoryId,path:{path,canonicalPath:path,aliasStatus:'verified_no_alias'},mode:'write'}:{kind:'isolated_folder',host:'local',path:{path,canonicalPath:path,aliasStatus:'verified_no_alias'}}]});
    const space=spaces.create(r,kind==='code'?{batchId:r.batch.id,projectId:project.id,repositoryId:repositoryIdentity(join(repo,'.git')).repositoryId,baseSha:base}:undefined);
    writeFileSync(join(space.path,kind==='code'?file:'output/'+file),content);
    workers.transition(r,'dispatched');workers.confirmTerminal(r,{kind:'terminal_confirmed',dispatchRequestId:r.attempt.dispatchRequestId,evidenceId:'terminated'});
    return {r,space,enqueue:(targetBranch='dev')=>queue.enqueue({requestId:randomUUID(),fence:r,targetBranch:kind==='code'?targetBranch:null})};
  };
  return {root,repo,git,store,project,workers,spaces,verification,merge,policy,completion,queue,makeQueue,worker,base};
}
test('two workers integrate sequentially from their own base onto latest HEAD',async()=>{
 const f=fixture();try{const a=f.worker('a.txt','A\n'),b=f.worker('b.txt','B\n');const x=a.enqueue(),y=b.enqueue();await f.queue.drain();
 assert.equal(f.queue.get(x.id).status,'applied',f.queue.get(x.id).reason??'');assert.equal(f.queue.get(y.id).status,'applied',f.queue.get(y.id).reason??'');
 assert.equal(readFileSync(join(f.repo,'a.txt'),'utf8'),'A\n');assert.equal(readFileSync(join(f.repo,'b.txt'),'utf8'),'B\n');
 assert.equal(f.workers.read(a.r.reservationId).state,'released');assert.equal(f.git('rev-parse','HEAD~2'),f.base);
 }finally{f.store.close();}
});
test('conflict refuses without target writes',async()=>{const f=fixture();try{const w=f.worker('a.txt','worker\n'),q=w.enqueue();writeFileSync(join(f.repo,'a.txt'),'target\n');f.git('add','.');f.git('commit','-m','move');const head=f.git('rev-parse','HEAD');await f.queue.drain();assert.equal(f.queue.get(q.id).status,'refused');assert.equal(f.git('rev-parse','HEAD'),head);}finally{f.store.close();}});
test('undeclared changes refuse and release only terminal reservation',async()=>{const f=fixture();try{const w=f.worker('a.txt','A');writeFileSync(join(w.space.path,'b.txt'),'hidden');const q=w.enqueue();await f.queue.drain();assert.equal(f.queue.get(q.id).status,'refused');assert.equal(f.git('rev-parse','HEAD'),f.base);assert.equal(f.workers.read(w.r.reservationId).state,'released');}finally{f.store.close();}});
test('failed full verification never applies',async()=>{const f=fixture('code',['-e','process.exit(1)']);try{const q=f.worker('a.txt','A').enqueue();await f.queue.drain();assert.equal(f.queue.get(q.id).status,'refused');assert.equal(f.git('rev-parse','HEAD'),f.base);}finally{f.store.close();}});
test('missing required check blocks and retains reservation',async()=>{const f=fixture();try{f.policy.requiredChecks.push('missing');const w=f.worker('a.txt','A'),q=w.enqueue();await f.queue.drain();assert.equal(f.queue.get(q.id).status,'blocked');assert.equal(f.workers.read(w.r.reservationId).state,'terminal_confirmed');}finally{f.store.close();}});
test('protected branch names refuse',async()=>{for(const branch of ['main','master','trunk']){const f=fixture();try{const q=f.worker('a.txt','A').enqueue(branch);await f.queue.drain();assert.equal(f.queue.get(q.id).status,'refused');assert.equal(f.git('rev-parse','HEAD'),f.base);}finally{f.store.close();}}});
test('general output manifest integrates without Git and refuses existing output',async()=>{const f=fixture('general');try{const q=f.worker('result.txt','result').enqueue();await f.queue.drain();assert.equal(f.queue.get(q.id).status,'applied');assert.equal(readFileSync(join(f.project.path,'output/result.txt'),'utf8'),'result');const q2=f.worker('result.txt','replacement').enqueue();await f.queue.drain();assert.equal(f.queue.get(q2.id).status,'refused');assert.equal(readFileSync(join(f.project.path,'output/result.txt'),'utf8'),'result');}finally{f.store.close();}});

test('server-wide durable slot excludes another queue while verification is pending',async()=>{
 const f=fixture();try{
  const x=f.worker('a.txt','A').enqueue(),y=f.worker('b.txt','B').enqueue();
  const original=f.verification.verifyIntegration.bind(f.verification);let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(r=>enter=r),barrier=new Promise<void>(r=>release=r);let calls=0,active=0,max=0;
  f.verification.verifyIntegration=async input=>{calls++;active++;max=Math.max(max,active);if(calls===1){enter();await barrier;}try{return await original(input);}finally{active--;}};
  const first=f.queue.drain();await entered;
  const second=f.makeQueue();assert.equal(second.active,true);await second.drain();assert.equal(calls,1);assert.equal(second.get(y.id).status,'queued');
  assert.throws(()=>second.reconcile(x.id,true),/STOP_CONFIRMATION/);
  assert.throws(()=>f.merge.ensureAvailable(),/INTEGRATION_BUSY/);
  release();await first;assert.equal(max,1);assert.equal(second.get(y.id).status,'applied');
 }finally{f.store.close();}
});
test('target HEAD moved after candidate verification rebuilds and verifies again',async()=>{
 const f=fixture();try{
  const w=f.worker('a.txt','A'),q=w.enqueue(),original=f.verification.verifyIntegration.bind(f.verification);let calls=0;
  f.verification.verifyIntegration=async input=>{const result=await original(input);if(++calls===1){writeFileSync(join(f.repo,'b.txt'),'new target');f.git('add','.');f.git('commit','-m','move during verification');}return result;};
  await f.queue.drain();assert.equal(f.queue.get(q.id).status,'applied');assert.equal(calls,2);assert.equal(f.queue.get(q.id).attempts,2);
  assert.equal(readFileSync(join(f.repo,'b.txt'),'utf8'),'new target');assert.equal(readFileSync(join(w.space.path,'b.txt'),'utf8'),'base\n');
 }finally{f.store.close();}
});
test('candidate changed after verification rebuilds rather than applying unverified bytes',async()=>{
 const f=fixture();try{
  const q=f.worker('a.txt','A').enqueue(),original=f.verification.verifyIntegration.bind(f.verification);let calls=0;
  f.verification.verifyIntegration=async input=>{const result=await original(input);if(++calls===1)writeFileSync(join(input.context.cwd,'a.txt'),'tampered');return result;};
  await f.queue.drain();assert.equal(f.queue.get(q.id).status,'applied');assert.equal(calls,2);assert.equal(readFileSync(join(f.repo,'a.txt'),'utf8'),'A');
 }finally{f.store.close();}
});
test('restart after Git apply before queue receipt reconciles without a second apply',async()=>{
 const f=fixture();try{
  const q=f.worker('a.txt','A').enqueue(),original=f.merge.applyIntegration.bind(f.merge);let calls=0;
  f.merge.applyIntegration=(input,check)=>{calls++;original(input,check);throw new Error('simulated queue receipt loss');};
  await f.queue.drain();assert.equal(f.queue.get(q.id).status,'blocked');const head=f.git('rev-parse','HEAD');
  const restarted=f.makeQueue();assert.equal(restarted.reconcile(q.id,true).status,'applied');await restarted.drain();
  assert.equal(calls,1);assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(restarted.reconcile(q.id,true).status,'applied');
 }finally{f.store.close();}
});
test('unknown restart state remains blocked and never blindly reapplies',async()=>{
 const f=fixture();try{
  const q=f.worker('a.txt','A').enqueue();
  f.store.db.prepare('UPDATE integration_queue SET slot=1,body=? WHERE id=?').run(JSON.stringify({...q,status:'building'}),q.id);
  const restarted=f.makeQueue();assert.equal(restarted.reconcile(q.id,true).status,'blocked');await restarted.drain();assert.equal(f.git('rev-parse','HEAD'),f.base);
  assert.equal(f.workers.read(q.fence.reservationId).state,'terminal_confirmed');
 }finally{f.store.close();}
});
test('local remote HEAD protects repository default without a remote operation',async()=>{
 const f=fixture();try{f.git('symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/dev');const q=f.worker('a.txt','A').enqueue();await f.queue.drain();assert.equal(f.queue.get(q.id).reason,'INTEGRATION_TARGET_PROTECTED');assert.equal(f.git('rev-parse','HEAD'),f.base);}finally{f.store.close();}
});
test('queue request replay is idempotent and rejects changed payload',async()=>{
 const f=fixture();try{const w=f.worker('a.txt','A'),input={requestId:randomUUID(),fence:w.r,targetBranch:'dev'},q=f.queue.enqueue(input);assert.equal(f.queue.enqueue(input).id,q.id);assert.throws(()=>f.queue.enqueue({...input,targetBranch:'other'}),/IDEMPOTENCY_CONFLICT/);assert.equal(f.queue.list().length,1);}finally{f.store.close();}
});

test('closed Store restart reconciles a durable applying intent from Git',async()=>{
 const f=fixture();let reopened:Store|undefined;
 try{
  const q=f.worker('a.txt','A').enqueue(),original=f.merge.applyIntegration.bind(f.merge);let calls=0;
  f.merge.applyIntegration=(input,check)=>{
   calls++;const result=original(input,check);
   f.store.db.prepare('UPDATE merge_records SET body=? WHERE id=?').run(JSON.stringify({...result,status:'applying',completionBasis:null}),input.id);
   throw new Error('crash after Git before completion journal');
  };
  await f.queue.drain();const head=f.git('rev-parse','HEAD');f.store.close();
  reopened=new Store(join(f.root,'state.sqlite'));
  const projects=new Projects(reopened,join(f.root,'managed'),[f.repo],join(f.root,'created'));
  const workers=new ParallelWorkerService(reopened),spaces=new WorkerSpaces(reopened,projects,workers);
  const verification=new VerificationService(reopened,projects,[]),merge=new MergeService(reopened,projects,verification,()=>false);
  const queue=new IntegrationQueue(reopened,projects,workers,spaces,verification,merge,()=>f.policy);
  assert.equal(merge.record(q.id).status,'lost');assert.equal(queue.reconcile(q.id,true).status,'applied');await queue.drain();
  assert.equal(calls,1);assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(merge.record(q.id).completionBasis,'observed_after_recovery');
 }finally{if(reopened)reopened.close();else f.store.close();}
});
test('all configured checks execute on candidate even if required list names only one',async()=>{
 const f=fixture();try{
  const verification=new VerificationService(f.store,new Projects(f.store,join(f.root,'managed'),[f.repo]),['full','contract'].map(id=>({projectPath:f.repo,id,label:id,executable:process.execPath,args:['-e',id==='contract'?'process.exit(1)':'process.exit(0)'],timeoutMs:10000})));
  const projects=new Projects(f.store,join(f.root,'managed'),[f.repo]),merge=new MergeService(f.store,projects,verification,()=>false);
  const queue=new IntegrationQueue(f.store,projects,f.workers,f.spaces,verification,merge,()=>f.policy);
  const w=f.worker('a.txt','A'),q=queue.enqueue({requestId:randomUUID(),fence:w.r,targetBranch:'dev'});await queue.drain();
  assert.equal(queue.get(q.id).status,'refused');assert.equal(f.git('rev-parse','HEAD'),f.base);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM integration_checks').get()!.n,2);
 }finally{f.store.close();}
});
test('general out-of-scope files never enter output area',async()=>{
 const f=fixture('general');try{const w=f.worker('result.txt','result');writeFileSync(join(w.space.path,'undeclared.txt'),'outside');const q=w.enqueue();await f.queue.drain();assert.equal(f.queue.get(q.id).status,'refused');assert.equal(f.workers.read(w.r.reservationId).state,'released');}finally{f.store.close();}
});
test('worker cannot auto-promote a configured protected verification file',async()=>{
 const f=fixture();try{
  const projects=new Projects(f.store,join(f.root,'managed'),[f.repo]);
  const verification=new VerificationService(f.store,projects,[{projectPath:f.repo,id:'full',label:'full',executable:process.execPath,args:['-e','process.exit(0)'],timeoutMs:10000,protectedFiles:['a.txt']}]);
  const queue=new IntegrationQueue(f.store,projects,f.workers,f.spaces,verification,new MergeService(f.store,projects,verification,()=>false),()=>f.policy);
  const w=f.worker('a.txt','weakened verification'),q=queue.enqueue({requestId:randomUUID(),fence:w.r,targetBranch:'dev'});await queue.drain();
  assert.equal(queue.get(q.id).status,'refused');assert.equal(f.git('rev-parse','HEAD'),f.base);
 }finally{f.store.close();}
});
test('release failure preserves applied outcome and retries only reservation release',async()=>{
 const f=fixture('general');try{
  const q=f.worker('result.txt','result').enqueue(),original=f.workers.release.bind(f.workers);let calls=0;
  f.workers.release=(...args)=>{if(++calls===1)throw new Error('release unavailable');return original(...args);};
  await f.queue.drain();assert.equal(f.queue.get(q.id).status,'applied');assert.equal(f.queue.get(q.id).released,false);assert.equal(f.queue.active,true);
  assert.equal(f.queue.reconcile(q.id,true).released,true);assert.equal(f.queue.active,false);assert.equal(calls,2);
  assert.equal(readFileSync(join(f.project.path,'output/result.txt'),'utf8'),'result');
 }finally{f.store.close();}
});
test('declared Unicode path integrates without Git display quoting',async()=>{
 const f=fixture();try{const q=f.worker('결과.txt','approved').enqueue();await f.queue.drain();assert.equal(f.queue.get(q.id).status,'applied');assert.equal(readFileSync(join(f.repo,'결과.txt'),'utf8'),'approved');}finally{f.store.close();}
});
test('uncertain authoritative merge recovery retains queue and reservation',async()=>{
 const f=fixture();try{
  const q=f.worker('a.txt','A').enqueue(),original=f.merge.applyIntegration.bind(f.merge);
  f.merge.applyIntegration=(input,check)=>{original(input,check);throw new Error('receipt lost');};await f.queue.drain();
  f.merge.recover=()=>({...f.merge.record(q.id),status:'unknown',completionBasis:null});
  assert.equal(f.queue.reconcile(q.id,true).status,'blocked');assert.equal(f.workers.read(q.fence.reservationId).state,'terminal_confirmed');assert.equal(f.queue.active,true);
 }finally{f.store.close();}
});

for(const defect of ['worker','missing','unmapped','mock','unknown','semantic','subject','producer','policy'] as const){
 test(`candidate completion refuses ${defect} evidence before apply`,async()=>{
  const f=fixture(defect==='semantic'?'general':'code');try{
   if(defect==='unmapped')delete f.policy.completionPolicy.gateCommandMap.e2e;
   const read=f.completion.read;
   f.completion.read=item=>{
    const value=read(item)!;
    if(defect==='worker'){
     value.binding.artifactId=item.space.workspaceId;
     for(const b of Object.values(value.evidence.bindings))b.artifactId=item.space.workspaceId;
     for(const c of value.evidence.checks)c.workspaceId=item.space.workspaceId!;
     for(const e of value.evidence.quality.evidence)e.binding.artifactId=item.space.workspaceId;
    }
    if(defect==='missing')value.evidence.checks=[];
    if(defect==='mock'||defect==='unknown')for(const e of value.evidence.quality.evidence)e.evidenceSource=defect;
    if(defect==='semantic'){value.evidence.loops=[];value.evidence.quality.semantic=dimension();value.evidence.quality.independentReview=dimension();}
    if(defect==='subject')value.subject.targetDigest='old-head';
    if(defect==='producer')value.evidence.producer!.model.source='unknown';
    if(defect==='policy')f.policy.completionPolicy.requireIndependentReview=true;
    return value;
   };
   const q=f.worker('a.txt','A').enqueue();await f.queue.drain();
   assert.equal(f.queue.get(q.id).status,'refused');
   const reasons={worker:'INTEGRATION_COMPLETION_BINDING_MISMATCH',missing:'CQG_GATE_EVIDENCE_MISSING',unmapped:'CQG_GATE_COMMAND_MISSING',mock:'CQG_OBSERVED_EVIDENCE_REQUIRED',unknown:'CQG_OBSERVED_EVIDENCE_REQUIRED',semantic:'CQG_SEMANTIC_REVIEW_REQUIRED',subject:'INTEGRATION_COMPLETION_SUBJECT_MISMATCH',producer:'CQG_MODEL_OBSERVATION_REQUIRED',policy:'INTEGRATION_COMPLETION_BINDING_MISMATCH'};
   assert.ok(f.queue.get(q.id).reason?.includes(reasons[defect]),f.queue.get(q.id).reason??'missing refusal reason');
   if(defect==='semantic')assert.match(f.queue.get(q.id).reason!,/CQG_SEMANTIC_REVIEW_REQUIRED/);
   else assert.equal(f.git('rev-parse','HEAD'),f.base);
  }finally{f.store.close();}
 });
}
test('a passed return without candidate check records cannot reuse supplied passes',async()=>{
 const f=fixture();try{
  const original=f.verification.verifyIntegration.bind(f.verification);
  f.verification.verifyIntegration=async input=>{const result=await original(input),captured=f.completion.read(f.queue.get(input.id));f.completion.read=()=>captured;f.store.db.exec('DELETE FROM integration_checks');return result;};
  const q=f.worker('a.txt','A').enqueue();await f.queue.drain();assert.equal(f.queue.get(q.id).status,'refused');assert.equal(f.git('rev-parse','HEAD'),f.base);
 }finally{f.store.close();}
});

test('candidate evidence reader is required even when local commands pass',async()=>{
 const f=fixture('general');try{
  f.completion.read=()=>null;const q=f.worker('result.txt','result').enqueue();await f.queue.drain();
  assert.equal(f.queue.get(q.id).status,'refused');assert.equal(f.queue.get(q.id).reason,'INTEGRATION_COMPLETION_EVIDENCE_REQUIRED');
 }finally{f.store.close();}
});
for(const changed of ['candidate','target'] as const){
 test(`general ${changed} hash movement rebuilds and obtains fresh candidate evidence`,async()=>{
  const f=fixture('general');try{
   const q=f.worker('result.txt','result').enqueue(),verify=f.verification.verifyIntegration.bind(f.verification);let calls=0;
   f.verification.verifyIntegration=async input=>{
    const result=await verify(input);
    if(++calls===1){const path=changed==='candidate'?join(input.context.cwd,'output'):join(f.project.path,'output');mkdirSync(path,{recursive:true});writeFileSync(join(path,changed==='candidate'?'result.txt':'other.txt'),'changed');}
    return result;
   };
   await f.queue.drain();assert.equal(f.queue.get(q.id).status,'applied',f.queue.get(q.id).reason??'');assert.equal(calls,2);assert.equal(f.queue.get(q.id).attempts,2);
   assert.equal(readFileSync(join(f.project.path,'output/result.txt'),'utf8'),'result');
  }finally{f.store.close();}
 });
}
test('candidate movement while reading completion evidence rebuilds before apply',async()=>{
 const f=fixture('general');try{
  const read=f.completion.read;let reads=0;
  f.completion.read=item=>{const result=read(item);if(++reads===1)writeFileSync(join(item.candidatePath!,'output/result.txt'),'changed during evidence read');return result;};
  const q=f.worker('result.txt','result').enqueue();await f.queue.drain();
  assert.equal(f.queue.get(q.id).status,'applied',f.queue.get(q.id).reason??'');assert.equal(f.queue.get(q.id).attempts,2);
  assert.equal(readFileSync(join(f.project.path,'output/result.txt'),'utf8'),'result');
 }finally{f.store.close();}
});

for(const defect of ['none','missing category','worker only','wrong target','old policy','no provenance'] as const)test(`persisted candidate reader: ${defect}`,async()=>{
 const f=fixture();try{
  const verify=f.verification.verifyIntegration.bind(f.verification),fixtureReader=f.completion.read;
  f.verification.verifyIntegration=async input=>{
   const result=await verify(input),item=f.queue.get(input.id);
   const captured=fixtureReader(item)!;
   const {quality,producer,commands,bindings,loops,gateResults}=captured.evidence;
   const context={subject:captured.subject,binding:captured.binding,quality,producer,commands,bindings,loops,gateResults};
   if(defect==='wrong target')context.subject.targetDigest='wrong';
   if(defect==='old policy')context.binding.policyDigest='old';
   if(defect==='worker only'){
    f.store.db.exec('CREATE TABLE IF NOT EXISTS verification_checks(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL)');
    for(const check of captured.evidence.checks)f.store.db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run(check.id,check.id,JSON.stringify({...check,workspaceId:item.space.workspaceId,completionBinding:{...captured.binding,artifactId:item.space.workspaceId}}));
    f.store.db.exec('DELETE FROM integration_checks');
   }
   if(defect!=='worker only'&&defect!=='no provenance')for(const row of f.store.db.prepare('SELECT id,body FROM integration_checks').all()){
    const body=JSON.parse(String(row.body));body.completionContext=context;
    f.store.db.prepare('UPDATE integration_checks SET body=? WHERE id=?').run(JSON.stringify(body),String(row.id));
   }
   return result;
  };
  if(defect==='missing category')f.policy.completionPolicy.gateCommandMap.e2e=['absent'];
  f.completion.read=item=>readCandidateCompletion(f.store,item);
  const q=f.worker('a.txt','A').enqueue();await f.queue.drain();
  assert.equal(f.queue.get(q.id).status,defect==='none'?'applied':'refused');
 }finally{f.store.close();}
});

for(const defect of ['none','semantic missing'] as const)test(`persisted general candidate reader: ${defect}`,async()=>{
 const f=fixture('general');try{
  const verify=f.verification.verifyIntegration.bind(f.verification),fixtureReader=f.completion.read;
  f.verification.verifyIntegration=async input=>{
   const result=await verify(input),captured=fixtureReader(f.queue.get(input.id))!;
   const {quality,producer,commands,bindings,loops,gateResults}=captured.evidence;
   const context={subject:captured.subject,binding:captured.binding,quality,producer,commands,bindings,loops: defect==='semantic missing'?[]:loops,gateResults};
   for(const row of f.store.db.prepare('SELECT id,body FROM integration_checks').all()){
    f.store.db.prepare('UPDATE integration_checks SET body=? WHERE id=?').run(JSON.stringify({...JSON.parse(String(row.body)),completionContext:context}),String(row.id));
   }
   return result;
  };
  f.completion.read=item=>readCandidateCompletion(f.store,item);
  const q=f.worker('result.txt','result').enqueue();await f.queue.drain();
  assert.equal(f.queue.get(q.id).status,defect==='none'?'applied':'refused');
 }finally{f.store.close();}
});
