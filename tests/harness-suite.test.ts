import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../server/store.ts';
import {HarnessService} from '../server/harness-service.ts';
import {FailureCaseStore} from '../server/failure-cases.ts';
import {harnessV0} from '../server/harness-policy.ts';
import type {HarnessEvaluationRunner} from '../server/harness-evaluation.ts';
import type {ProjectProgress} from '../shared/project-progress.ts';
import type {CompletionDecision,TaskCompletion} from '../shared/task-completion.ts';

const P='project-1',at='2026-10-30T00:00:00.000Z',SECRET_PROMPT='do the private thing';
const ok:CompletionDecision={status:'not_applicable',evidenceIds:[],source:'local',freshness:'current',blockers:[]};
/** Test double of a CQG completion as ProjectProgressService would report it. Not real CQG evidence. */
function completion(runId:string,taskId:string,over:Partial<TaskCompletion>={},gate:Partial<CompletionDecision>={}):TaskCompletion{
  return {binding:{projectId:P,taskId,runId,planningVersionId:'plan',planningContentHash:'h',acceptanceDigest:'a',artifactId:'w',artifactDigest:'d'.repeat(64),
    graphRevision:null,contractDigest:null,policyDigest:'p'.repeat(64),configDigest:null,artifactScope:'workspace',baseSha:null,inputSnapshotDigest:null},
    policyDigest:'e'.repeat(64),gates:[{id:'lint',...ok,status:'passed',...gate}],qualityPassed:true,independentReview:ok,userApproval:ok,verifiedDone:true,reasonCodes:[],...over};
}

function setup(options:ConstructorParameters<typeof HarnessService>[1]={}){
  const store=new Store(':memory:');
  store.saveProject({id:P,name:'P',path:'/never-read',createdAt:at,writeEnabled:false});
  const run=(taskId:string,runtime:'claude-code'|'codex'='claude-code')=>{
    const r=store.createRun('req-'+taskId+runtime,'x',SECRET_PROMPT,undefined,{taskId,runtime,projectId:P,planningVersionId:'plan',planningContentHash:'h',requirementLabels:[]});
    return store.updateRun(r.id,{execution:'completed'},'run.completed');
  };
  const progress:{tasks:Map<string,{latestRunId:string;completion:TaskCompletion}>}={tasks:new Map()};
  const read=(projectId:string)=>({projectId,tasks:[...progress.tasks].map(([id,t])=>({id,...t}))}) as unknown as ProjectProgress;
  const service=new HarnessService(store,options);
  const passed=(taskId:string,runtime:'claude-code'|'codex'='claude-code')=>{const r=run(taskId,runtime);progress.tasks.set(taskId,{latestRunId:r.id,completion:completion(r.id,taskId)});return r;};
  const register=(requestId:string,runId:string,taskId:string,isProtected=false)=>
    service.registerSuiteCase(P,{requestId,runId,taskId,target:'claude_task',protected:isProtected,confirmed:true},read);
  return {store,service,run,progress,read,passed,register};
}
const rows=(s:Store)=>(s.db.prepare('SELECT count(*) AS n FROM harness_suite_events').get() as {n:number}).n;

test('registration refuses runs that are not verifiedDone, current and native right now',()=>{
  const t=setup();
  const r=t.passed('task-1');
  const reject=(code:RegExp,input:Record<string,unknown>={})=>assert.throws(()=>t.service.registerSuiteCase(P,
    {requestId:'reg-'+Math.random().toString(36).slice(2),runId:r.id,taskId:'task-1',target:'claude_task',protected:false,confirmed:true,...input} as never,t.read),code);
  for(const [gate,label] of [[{source:'mock'},'mock'],[{source:'unknown'},'unknown'],[{freshness:'stale'},'stale']] as const){
    t.progress.tasks.set('task-1',{latestRunId:r.id,completion:completion(r.id,'task-1',{},gate)});reject(/HARNESS_SUITE_RUN_NOT_VERIFIED/);void label;
  }
  t.progress.tasks.set('task-1',{latestRunId:r.id,completion:completion(r.id,'task-1',{verifiedDone:false})});reject(/HARNESS_SUITE_RUN_NOT_VERIFIED/);
  t.progress.tasks.set('task-1',{latestRunId:r.id,completion:completion(r.id,'task-1',{reasonCodes:['CQG_X']})});reject(/HARNESS_SUITE_RUN_NOT_VERIFIED/);
  t.progress.tasks.set('task-1',{latestRunId:r.id,completion:completion('other-run','task-1')});reject(/HARNESS_SUITE_RUN_NOT_VERIFIED/);
  t.progress.tasks.set('task-1',{latestRunId:'newer-run',completion:completion('newer-run','task-1')});reject(/HARNESS_SUITE_RUN_NOT_CURRENT/);
  t.progress.tasks.set('task-1',{latestRunId:r.id,completion:completion(r.id,'task-1')});
  reject(/HARNESS_SUITE_RUN_NOT_FOUND/,{taskId:'task-2'});
  reject(/HARNESS_SUITE_RUN_NOT_FOUND/,{runId:'missing'});
  reject(/HARNESS_APPROVAL_REQUIRED/,{confirmed:false});
  reject(/HARNESS_SUITE_INVALID/,{extra:1});
  reject(/HARNESS_EVAL_RUNTIME_UNSUPPORTED/,{target:'codex_brief'});
  const codex=t.passed('task-c','codex');
  reject(/HARNESS_EVAL_RUNTIME_UNSUPPORTED/,{runId:codex.id,taskId:'task-c'});
  const pending=t.store.createRun('req-pending','x','p',undefined,{taskId:'task-1',runtime:'claude-code',projectId:P,planningVersionId:'plan',planningContentHash:'h',requirementLabels:[]});
  reject(/HARNESS_SUITE_RUN_NOT_VERIFIED/,{runId:pending.id});
  assert.equal(rows(t.store),0);
  t.store.close();
});

test('registered case is a digest manifest with provenance; idempotent, duplicate-safe and append-only on removal',()=>{
  const t=setup();
  const r=t.passed('task-1');
  const c=t.register('reg-1',r.id,'task-1');
  assert.deepEqual(Object.keys(c).sort(),['artifactDigest','caseId','completionBindingDigest','digest','policyDigest','projectId','protected','registeredAt','requestId','runId','target','taskId']);
  assert.equal(c.runId,r.id);assert.equal(c.policyDigest,'e'.repeat(64));assert.match(c.completionBindingDigest,/^[a-f0-9]{64}$/);assert.match(c.digest,/^[a-f0-9]{64}$/);
  const stored=String((t.store.db.prepare('SELECT body FROM harness_suite_events').get() as {body:string}).body);
  assert.ok(!stored.includes(SECRET_PROMPT));
  // Replay returns the recorded case even after the run stopped being current; a changed request conflicts.
  t.progress.tasks.set('task-1',{latestRunId:'newer',completion:completion('newer','task-1')});
  assert.deepEqual(t.register('reg-1',r.id,'task-1'),c);
  assert.throws(()=>t.register('reg-1',r.id,'task-1',true),/HARNESS_REQUEST_CONFLICT/);
  t.progress.tasks.set('task-1',{latestRunId:r.id,completion:completion(r.id,'task-1')});
  assert.throws(()=>t.register('reg-2',r.id,'task-1',true),/HARNESS_SUITE_DUPLICATE/);
  const p=t.register('reg-3',t.passed('task-2').id,'task-2',true);
  const port=t.service.suite.port();
  assert.deepEqual(port.normalCases(P,'claude_task'),[{caseId:c.caseId,digest:c.digest}]);
  assert.deepEqual(port.protectedCases(P,'claude_task'),[{caseId:p.caseId,digest:p.digest}]);
  assert.deepEqual(port.normalCases(P,'repair'),[]);
  assert.throws(()=>t.service.removeSuiteCase(P,{requestId:'rm-1',caseId:c.caseId,confirmed:false as true}),/HARNESS_APPROVAL_REQUIRED/);
  assert.deepEqual(t.service.removeSuiteCase(P,{requestId:'rm-1',caseId:c.caseId,confirmed:true}),{caseId:c.caseId,removed:true});
  assert.deepEqual(t.service.removeSuiteCase(P,{requestId:'rm-1',caseId:c.caseId,confirmed:true}),{caseId:c.caseId,removed:true});
  assert.throws(()=>t.service.removeSuiteCase(P,{requestId:'rm-2',caseId:c.caseId,confirmed:true}),/HARNESS_SUITE_CASE_NOT_FOUND/);
  assert.deepEqual(port.normalCases(P,'claude_task'),[]);
  assert.equal(rows(t.store),3);
  // The run can be registered again after removal, as a new case.
  assert.notEqual(t.register('reg-4',r.id,'task-1').caseId,c.caseId);
  assert.throws(()=>t.store.db.exec('UPDATE harness_suite_events SET body=body'),/HARNESS_APPEND_ONLY/);
  assert.throws(()=>t.store.db.exec('DELETE FROM harness_suite_events'),/HARNESS_APPEND_ONLY/);
  t.store.close();
});

test('a tampered suite log fails closed: view reports an error and the evaluation port throws',()=>{
  const t=setup();
  t.register('reg-1',t.passed('task-1').id,'task-1');
  t.store.db.exec('DROP TRIGGER harness_suite_events_no_update');
  t.store.db.exec(`UPDATE harness_suite_events SET body=replace(body,'"protected":false','"protected":true')`);
  assert.equal(t.service.view(P).suite?.state,'error');
  assert.throws(()=>t.service.suite.port().protectedCases(P,'claude_task'),/HARNESS_INTEGRITY/);
  t.store.close();
});

/** A real FE-4 failure case and a candidate citing it, so the failing kind of the suite is non-empty. */
function candidate(t:ReturnType<typeof setup>){
  const source=t.run('task-fail');
  const body=String((t.store.db.prepare('SELECT body FROM runs WHERE id=?').get(source.id) as {body:string}).body);
  const familyId='f'.repeat(64);
  const fc=new FailureCaseStore(t.store).create({requestId:'case-request-1',familyId,failureId:'failure-1',sourceTable:'runs',recordId:source.id,
    recordBodySha256:createHash('sha256').update(body).digest('hex'),expected:'same_failure',inputDigests:{},conditions:{},indexerVersion:'fe-2',confirmed:true});
  return t.service.versions.append({projectId:P,requestId:'append-1',parentId:harnessV0('claude_task').versionId,candidate:{class:'execution_guidance',target:'claude_task',
    lines:['관찰한 결과만 보고한다.'],origin:'user',evidence:{familyIds:[familyId],caseIds:[fc.id],indexerVersion:'fe-2'}}}).version;
}

test('production wiring: the suite store is the HE-4 port, so the runner (not the suite) is the remaining blocker',async()=>{
  // Fake runner injected only to observe the suite HE-4 fixes at start; production injects none.
  const calls:string[]=[];
  const runner:HarnessEvaluationRunner={mode:'fake',runCase:async i=>{calls.push(`${i.kind}:${i.caseId}:${i.arm}`);throw new Error('NOT_RUN');}};
  const t=setup({runner});
  const v=candidate(t);
  await assert.rejects(t.service.evaluate(P,{requestId:'eval-0',candidateVersionId:v.versionId,liveApproval:null}),/HARNESS_EVAL_SUITE_INCOMPLETE/);
  const n=t.register('reg-n',t.passed('task-1').id,'task-1'),p=t.register('reg-p',t.passed('task-2').id,'task-2',true);
  const r=await t.service.evaluate(P,{requestId:'eval-1',candidateVersionId:v.versionId,liveApproval:null});
  assert.equal(r.verdict,'unverified');assert.ok(!r.reasons.includes('HARNESS_EVAL_SUITE_INCOMPLETE'));
  assert.ok(calls.includes(`normal:${n.caseId}:A`)&&calls.includes(`protected:${p.caseId}:B`));
  const view=t.service.view(P).suite!;
  assert.deepEqual(view.targets.find(x=>x.target==='claude_task'),{target:'claude_task',normal:1,protected:1,digest:view.targets[0].digest});

  // Production: same store, no runner and no suite override.
  const production=new HarnessService(t.store);
  assert.deepEqual(production.suite.port().normalCases(P,'claude_task'),[{caseId:n.caseId,digest:n.digest}]);
  assert.equal(production.view(P).runnerMode,null);
  await assert.rejects(production.evaluate(P,{requestId:'eval-2',candidateVersionId:v.versionId,liveApproval:null}),/HARNESS_EVAL_RUNNER_UNAVAILABLE/);
  t.store.close();
});
