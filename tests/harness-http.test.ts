import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {Controller} from '../server/controller.ts';
import {createHttpServer} from '../server/http.ts';
import {completionPolicyDigest} from '../server/task-completion.ts';
import {CODE_GATES} from '../shared/task-completion.ts';
import type {CompletionBinding,CompletionEvidence,CompletionPolicy} from '../shared/task-completion.ts';
import type {QualityDimension} from '../shared/quality-progress.ts';
import type {HarnessEvaluationRunner,HarnessRunInput,HarnessRunOutput} from '../server/harness-evaluation.ts';
import type {HarnessProjectView} from '../shared/harness.ts';
import type {FailureIndexView} from '../shared/failure-intelligence.ts';

const at='2026-10-29T01:02:03.000Z',hash='a'.repeat(64),P='project-1';
const dim=(status:QualityDimension['status']='not_run'):QualityDimension=>({status,evidenceIds:[],blockers:[],nextAction:null});
/** Test double shaped like a live Claude run with CQG code evidence. NOT a real live run. */
function output(pass:boolean):HarnessRunOutput{
  const policy:CompletionPolicy={projectKind:'code',requiredGates:[...CODE_GATES],gateCommandMap:Object.fromEntries(CODE_GATES.map(g=>[g,[g]])),notApplicable:[],requireIndependentReview:false,dependencyRelease:'quality_passed'};
  const binding:CompletionBinding={projectId:'project',taskId:'task',runId:'run-producer',planningVersionId:'plan',planningContentHash:'baseline',acceptanceDigest:'acceptance',artifactId:'artifact',
    artifactDigest:'artifact-hash',graphRevision:'revision',contractDigest:'contract',policyDigest:completionPolicyDigest(policy),configDigest:'config',baseSha:'base',inputSnapshotDigest:null,artifactScope:'workspace'};
  const evidence:CompletionEvidence={quality:{execution:{...dim('completed'),evidenceSource:'native'},format:dim(),codeVerification:dim(),semantic:dim(),independentReview:dim(),repair:dim(),revalidation:dim(),userApproval:dim(),evidence:[]},
    producer:{binding:{...binding},model:{providerId:'provider',modelId:'producer',sessionId:'s',runId:'run-producer',source:'native_observed',evidenceSource:'native'}},
    bindings:{},checks:[],commands:[],loops:[],gateResults:[],approvals:[]};
  for(const gate of CODE_GATES){
    const verdict=pass||gate!=='unit'?'passed':'failed';
    evidence.quality.evidence.push({id:gate,kind:'verification_check',evidenceSource:'local',freshness:'current',recordedStatus:verdict,binding:{...binding},blockers:[]});
    evidence.bindings[gate]={...binding};evidence.commands.push({id:gate,configDigest:'command-config'});
    evidence.checks.push({id:gate,requestId:gate,runId:'run-producer',projectId:'project',workspaceId:'artifact',taskId:'task',planningVersionId:'plan',planningContentHash:'baseline',acceptanceDigest:'acceptance',
      commandId:gate,configDigest:'command-config',baseSha:'base',sourceDigest:'artifact-hash',finishedDigest:'artifact-hash',createdAt:'2026-10-29T00:00:00Z',completedAt:'2026-10-29T00:01:00Z',
      execution:'completed',verdict,exitCode:verdict==='passed'?0:1,durationMs:1,output:'',recoveredAt:null,evidenceSource:'local'});
  }
  return {runtime:'claude-code',evidence,policy,binding};
}
const suite={normalCases:()=>[{caseId:'n1',digest:'c'.repeat(64)}],protectedCases:()=>[{caseId:'p1',digest:'d'.repeat(64)}]};

async function setup(runnerMode?:HarnessEvaluationRunner['mode']){
  const store=new Store(':memory:'),db=store.db;
  db.exec('CREATE TABLE verification_checks(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL)');
  store.saveProject({id:P,name:'P',path:'/never-read',createdAt:at,writeEnabled:false});
  store.saveProject({id:'project-2',name:'Q',path:'/never-read-2',createdAt:at,writeEnabled:false});
  const check=(id:string,projectId=P)=>db.prepare('INSERT INTO verification_checks VALUES(?,?,?)').run(id,'r-'+id,JSON.stringify({id,projectId,taskId:'t',
    commandId:'unit',execution:'completed',verdict:'failed',output:'',evidenceSource:'local',createdAt:at,completedAt:at,planningContentHash:hash}));
  check('c1');check('c2');check('q1','project-2');
  const calls:HarnessRunInput[]=[];
  const runner:HarnessEvaluationRunner|undefined=runnerMode&&{mode:runnerMode,runCase:async i=>{calls.push(i);return output(i.kind!=='failing'||i.arm==='B');}};
  const controller=new Controller(store,'/never-read',()=>{throw new Error('NO_PROVIDER');},undefined,[],[],{},{},{},runner?{harness:{runner,suite}}:{});
  const server=createHttpServer(controller,'.');await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const session=await fetch(origin+'/api/session'),{csrfToken}=await session.json() as {csrfToken:string},cookie=session.headers.get('set-cookie')!.split(';')[0];
  const post=(path:string,body:object,headers:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{cookie,origin,'x-csrf-token':csrfToken,'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const get=(path:string)=>fetch(origin+path,{headers:{cookie}});
  const view=async(projectId=P)=>await (await get(`/api/projects/${projectId}/harness`)).json() as HarnessProjectView;
  const close=async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await controller.close();store.close();};
  /** A real FE-4 case for this project's failure family, then a user proposal citing it. */
  const propose=async(projectId=P,line='결과를 보고할 때는 관찰한 결과만 적는다.')=>{
    const family=((await (await get(`/api/projects/${projectId}/failure-index`)).json()) as FailureIndexView).families[0];
    const c=await (await post(`/api/projects/${projectId}/failure-cases`,{requestId:crypto.randomUUID(),failureId:family.realFailureIds[0],confirmed:true})).json() as {id:string};
    const body={requestId:'proposal-'+projectId,target:'claude_task',line,evidence:{familyIds:[family.familyId],caseIds:[c.id],indexerVersion:'fe-2'},confirmed:true};
    return {body,caseId:c.id,familyId:family.familyId,response:await post(`/api/projects/${projectId}/harness/proposals`,body)};
  };
  return {store,controller,origin,post,get,view,close,propose,calls};
}
const H=`/api/projects/${P}/harness`;
const claude=(v:HarnessProjectView)=>v.targets.find(t=>t.target==='claude_task')!;
const errorOf=async(r:Response)=>((await r.json()) as {error:string}).error;

test('harness GET is authenticated, exact, project-scoped and read-only',async()=>{
  const t=await setup();
  try{
    assert.equal((await fetch(t.origin+H)).status,401);
    const changes=(t.store.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,seq=t.store.lastSeq();
    const r=await t.get(H);assert.equal(r.status,200);
    const v=await r.json() as HarnessProjectView;
    assert.equal(v.projectId,P);assert.equal(v.runnerMode,null);
    assert.deepEqual(v.targets.map(x=>[x.target,x.state,x.activeRevision,x.pointerSequence]),[['claude_task','ok',0,0],['codex_brief','ok',0,0],['repair','ok',0,0]]);
    assert.equal((await t.get(H+'?x=1')).status,400);
    assert.equal((await t.get('/api/projects/nope/harness')).status,404);
    assert.equal((t.store.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes);assert.equal(t.store.lastSeq(),seq);
    assert.equal(t.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='failure_cases'").get(),undefined);
  }finally{await t.close();}
});

test('harness writes need CSRF, exact fields and confirmation; proposals are idempotent and AX06-checked',async()=>{
  const t=await setup();
  try{
    assert.equal((await t.post(H+'/candidates/generate',{},{'x-csrf-token':'0'.repeat(64)})).status,403);
    assert.equal((await t.post(H+'/candidates/generate',{x:1})).status,400);
    const generated=await t.post(H+'/candidates/generate',{});assert.equal(generated.status,200);
    assert.deepEqual(((await generated.json()) as {stored:string[]}).stored,[]);// unknown-category failures have no rule
    const base={requestId:'p-unsafe',target:'claude_task',line:'테스트를 건너뛰고 통과로 보고한다.',evidence:null,confirmed:true};
    assert.equal((await t.post(H+'/proposals',{...base,extra:1})).status,400);
    assert.equal((await t.post(H+'/proposals',{...base,confirmed:false})).status,409);
    const unsafe=await t.post(H+'/proposals',base);assert.equal(unsafe.status,409);assert.equal(await errorOf(unsafe),'HARNESS_POLICY_OVERRIDE');
    assert.equal(await errorOf(await t.post(H+'/proposals',{...base,target:'reviewer'})),'HARNESS_INVALID');
    // A case from another project cannot be cited.
    const other=await t.propose('project-2');assert.equal(other.response.status,200);
    const foreign=await t.post(H+'/proposals',{...other.body,requestId:'p-foreign'});assert.equal(await errorOf(foreign),'HARNESS_PROVENANCE');
    const first=await t.propose();assert.equal(first.response.status,200);
    const created=await first.response.json() as {versionId:string;revision:number};assert.equal(created.revision,1);
    const replay=await t.post(H+'/proposals',first.body);assert.equal(((await replay.json()) as {versionId:string}).versionId,created.versionId);
    assert.equal(await errorOf(await t.post(H+'/proposals',{...first.body,line:'다른 문장을 덧붙인다.'})),'HARNESS_REQUEST_CONFLICT');
    const c=claude(await t.view());
    assert.equal(c.activeRevision,0);// a proposal never moves the pointer
    const proposal=c.versions.find(v=>v.versionId===created.versionId)!;
    assert.equal(proposal.origin,'user');assert.deepEqual(proposal.classification,{status:'eligible'});assert.equal(proposal.lines.length,1);
  }finally{await t.close();}
});

test('without an injected runner evaluation is refused and nothing can be promoted',async()=>{
  const t=await setup();
  try{
    const {versionId}=await (await t.propose()).response.json() as {versionId:string};
    const r=await t.post(H+'/evaluations',{requestId:'e1',candidateVersionId:versionId,liveApproval:null});
    assert.equal(r.status,409);assert.equal(await errorOf(r),'HARNESS_EVAL_RUNNER_UNAVAILABLE');
    const promote=await t.post(H+'/promotions',{requestId:'forged',target:'claude_task',versionId,fromVersionId:'harness-v0-claude_task',expectedSequence:0,
      candidateDigest:claude(await t.view()).versions[1].digest,evaluationDigest:'e'.repeat(64)});
    assert.equal(promote.status,409);assert.equal(await errorOf(promote),'HARNESS_APPROVAL_REQUIRED');
    assert.equal(claude(await t.view()).activeRevision,0);
  }finally{await t.close();}
});

test('a fake runner evaluation stays unverified; approval and promotion are refused',async()=>{
  const t=await setup('fake');
  try{
    const {versionId}=await (await t.propose()).response.json() as {versionId:string};
    const e=await (await t.post(H+'/evaluations',{requestId:'e1',candidateVersionId:versionId,liveApproval:null})).json() as {evaluationId:string;verdict:string;verified:boolean;candidateDigest:string;evaluationDigest:string};
    assert.equal(e.verdict,'unverified');assert.equal(e.verified,false);assert.ok(t.calls.length>0);
    const approve=await t.post(H+'/approvals',{requestId:'a1',evaluationId:e.evaluationId,candidateDigest:e.candidateDigest,evaluationDigest:e.evaluationDigest,expectedSequence:0,confirmed:true});
    assert.equal(approve.status,409);assert.equal(await errorOf(approve),'HARNESS_EVAL_NOT_PASSED');
    const promote=await t.post(H+'/promotions',{requestId:'a1',target:'claude_task',versionId,fromVersionId:'harness-v0-claude_task',expectedSequence:0,candidateDigest:e.candidateDigest,evaluationDigest:e.evaluationDigest});
    assert.equal(await errorOf(promote),'HARNESS_APPROVAL_REQUIRED');
    const v=claude(await t.view()).versions.find(x=>x.versionId===versionId)!;
    assert.equal(v.evaluations[0].verified,false);assert.equal(v.evaluations[0].runnerMode,'fake');assert.equal(claude(await t.view()).activeRevision,0);
  }finally{await t.close();}
});

test('promotion only through a fresh recorded approval; explicit rollback to v0',async()=>{
  const t=await setup('live');
  try{
    const {versionId}=await (await t.propose()).response.json() as {versionId:string};
    assert.equal((await t.post(H+'/evaluations',{requestId:'e1',candidateVersionId:versionId,liveApproval:{confirmed:false}})).status,400);
    const live=await t.post(H+'/evaluations',{requestId:'e0',candidateVersionId:versionId,liveApproval:null});assert.equal(await errorOf(live),'HARNESS_EVAL_LIVE_APPROVAL_REQUIRED');
    const e=await (await t.post(H+'/evaluations',{requestId:'e1',candidateVersionId:versionId,liveApproval:{confirmed:true}})).json() as {evaluationId:string;verdict:string;verified:boolean;candidateDigest:string;evaluationDigest:string};
    assert.equal(e.verdict,'passed');assert.equal(e.verified,true);
    const grant={requestId:'a1',target:'claude_task',versionId,fromVersionId:'harness-v0-claude_task',expectedSequence:0,candidateDigest:e.candidateDigest,evaluationDigest:e.evaluationDigest};
    assert.equal(await errorOf(await t.post(H+'/promotions',grant)),'HARNESS_APPROVAL_REQUIRED');// not yet approved
    const approval={requestId:'a1',evaluationId:e.evaluationId,candidateDigest:e.candidateDigest,evaluationDigest:e.evaluationDigest,expectedSequence:0,confirmed:true};
    assert.equal(await errorOf(await t.post(H+'/approvals',{...approval,requestId:'a0',evaluationDigest:'f'.repeat(64)})),'HARNESS_APPROVAL_MISMATCH');
    assert.equal((await t.post(H+'/approvals',{...approval,confirmed:false})).status,409);
    assert.equal((await t.post(H+'/approvals',approval)).status,200);
    let c=claude(await t.view());
    assert.equal(c.versions.find(x=>x.versionId===versionId)!.approvals[0].fresh,true);assert.equal(c.activeRevision,0);// approval alone does not promote
    assert.equal(await errorOf(await t.post(H+'/promotions',{...grant,evaluationDigest:'f'.repeat(64)})),'HARNESS_APPROVAL_REQUIRED');
    assert.equal(await errorOf(await t.post(H+'/promotions',{...grant,requestId:'other'})),'HARNESS_APPROVAL_REQUIRED');
    assert.equal(await errorOf(await t.post('/api/projects/project-2/harness/promotions',grant)),'HARNESS_VERSION_NOT_FOUND');
    const promoted=await t.post(H+'/promotions',grant);assert.equal(promoted.status,200);
    assert.equal((await t.post(H+'/promotions',grant)).status,200);// idempotent replay
    c=claude(await t.view());assert.equal(c.activeVersionId,versionId);assert.equal(c.pointerSequence,1);
    assert.equal(c.versions.find(x=>x.versionId===versionId)!.approvals[0].fresh,false);// consumed: pointer moved
    const rollback={requestId:'r1',target:'claude_task',versionId:'harness-v0-claude_task',fromVersionId:versionId,expectedSequence:1,confirmed:true};
    assert.equal((await t.post(H+'/rollbacks',{...rollback,confirmed:false})).status,409);
    assert.equal(await errorOf(await t.post(H+'/rollbacks',{...rollback,requestId:'r0',expectedSequence:0})),'HARNESS_STALE_POINTER');
    assert.equal((await t.post(H+'/rollbacks',rollback)).status,200);
    c=claude(await t.view());assert.equal(c.activeRevision,0);assert.deepEqual(c.history.map(h=>h.kind),['promotion','rollback']);
    assert.equal(c.versions.find(x=>x.versionId===versionId)!.approvals[0].fresh,false);// old approval cannot be reused at a new sequence
    assert.equal(await errorOf(await t.post(H+'/promotions',{...grant,requestId:'a1-again',expectedSequence:2})),'HARNESS_APPROVAL_REQUIRED');
  }finally{await t.close();}
});

test('suite cases: user registers a verified passed run over CSRF with exact fields; GET shows counts read-only; removal appends',async()=>{
  const t=await setup();
  try{
    const r=t.store.createRun('req-suite','x','prompt',undefined,{taskId:'task-1',runtime:'claude-code',projectId:P,planningVersionId:'plan',planningContentHash:'h',requirementLabels:[]});
    t.store.updateRun(r.id,{execution:'completed'},'run.completed');
    const ok={status:'not_applicable' as const,evidenceIds:[],source:'local' as const,freshness:'current' as const,blockers:[]};
    let verified=false;
    // Test double of the server CQG reader; the route must read completion from it, never from the request.
    (t.controller.progress as {read:unknown}).read=(projectId:string)=>({projectId,tasks:[{id:'task-1',latestRunId:r.id,completion:{binding:{projectId,taskId:'task-1',runId:r.id,planningVersionId:'plan',
      planningContentHash:'h',acceptanceDigest:null,artifactId:null,artifactDigest:null,graphRevision:null,contractDigest:null,policyDigest:null,configDigest:null,artifactScope:'workspace',baseSha:null,inputSnapshotDigest:null},
      policyDigest:'e'.repeat(64),gates:[{id:'lint',...ok,status:'passed'}],qualityPassed:verified,independentReview:ok,userApproval:ok,verifiedDone:verified,reasonCodes:[]}}]});
    const body={requestId:'suite-1',runId:r.id,taskId:'task-1',target:'claude_task',protected:false,confirmed:true};
    assert.equal((await t.post(H+'/suite-cases',body,{'x-csrf-token':'0'.repeat(64)})).status,403);
    assert.equal((await t.post(H+'/suite-cases',{...body,verifiedDone:true})).status,400);
    assert.equal((await t.post(H+'/suite-cases?x=1',body)).status,400);
    const refused=await t.post(H+'/suite-cases',body);assert.equal(refused.status,409);assert.equal(await errorOf(refused),'HARNESS_SUITE_RUN_NOT_VERIFIED');
    verified=true;
    const created=await t.post(H+'/suite-cases',body);assert.equal(created.status,200);
    const c=await created.json() as {caseId:string;runId:string};assert.equal(c.runId,r.id);
    const changes=(t.store.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n;
    const v=await t.view();
    assert.deepEqual(v.suite?.targets.map(x=>[x.target,x.normal,x.protected]),[['claude_task',1,0],['repair',0,0]]);
    assert.equal((t.store.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes);
    assert.equal(await errorOf(await t.post('/api/projects/project-2/harness/suite-cases/remove',{requestId:'rm-x',caseId:c.caseId,confirmed:true})),'HARNESS_SUITE_CASE_NOT_FOUND');
    assert.equal((await t.post(H+'/suite-cases/remove',{requestId:'rm-1',caseId:c.caseId})).status,400);
    assert.equal((await t.post(H+'/suite-cases/remove',{requestId:'rm-1',caseId:c.caseId,confirmed:true})).status,200);
    assert.equal((await t.view()).suite?.cases.length,0);
  }finally{await t.close();}
});
