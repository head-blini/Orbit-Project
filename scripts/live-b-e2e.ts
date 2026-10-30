// Manual live proof only (LIVE-B, docs/ORBIT-DECISION-2026-10-30-APPROVALS.md #1,#2,#5). Never imported by tests.
// `--approved-live` launches real subscription CLIs within the approved budget; `--dry-run` rehearses the same HTTP flow
// with in-process fakes (no provider process, no network) so harness bugs surface before any live call.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,statSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {get as httpGet} from 'node:http';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {codexFactory} from '../server/codex.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';
import {ClaudeCodeRun,type ClaudeEvent,type ClaudeOutcome} from '../server/runtimes/claude-code.ts';
import {serializePlanningDraft} from '../server/planning/parser.ts';
import type {RpcPort} from '../server/rpc.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';

const [mode,...options]=process.argv.slice(2);
if(mode!=='--approved-live'&&mode!=='--dry-run')throw Error('EXPLICIT_LIVE_APPROVAL_REQUIRED');
const live=mode==='--approved-live';
// --resume <dir>: reopen a saved LIVE-B data dir and continue from Codex execution on its approved plan (no planning/research).
// --stop-after-approval (dry-run only): leave a saved state for rehearsing --resume without touching a live data dir.
// --approve-result (with --resume): only the user's result approval on the saved run; every provider launch is refused.
const resume=options[0]==='--resume'?options[1]:null,stopAfterApproval=options[0]==='--stop-after-approval',approveResult=!!resume&&options[2]==='--approve-result';
if(options.length&&!(resume&&options.length===(approveResult?3:2)&&/^\/private\/tmp\/orbit-live-b-[A-Za-z0-9]+$/.test(resume)&&existsSync(join(resume,'orbit.sqlite')))&&!(stopAfterApproval&&!live&&options.length===1))throw Error('INVALID_OPTIONS');

// Approved budget (approvals #1, #5). Claude execution is not used: the code project executes on Codex.
const BUDGET={claude:{total:6,planning:1,research:1,fix:1,review:1},codex:{total:3,execution:1,fix:1,review:1}} as const;
type Provider=keyof typeof BUDGET;
const LEDGER='/private/tmp/orbit-live-b-ledger.json';
const ledger:{claude:Record<string,number>;codex:Record<string,number>;runs:string[];corrections?:object[]}=live&&existsSync(LEDGER)?JSON.parse(readFileSync(LEDGER,'utf8')):{claude:{},codex:{},runs:[]};

const DEMO_REQUEST='브라우저에서 바로 여는 작은 정적 날짜 표시 위젯을 만들어 주세요. index.html에서 날짜를 고르면 YYYY-MM-DD 형식으로 보여 주고, 형식화 로직은 src/date-format.mjs에서 formatDate(date) 함수(YYYY-MM-DD 문자열 반환)로 export하며 저장소의 기존 테스트 date-format.test.mjs를 통과해야 합니다. 날짜 처리에 알맞은 작은 공개 npm 라이브러리가 있으면 재사용을 검토해 주세요. 요구사항은 하나로 묶고 열린 질문 없이 기획해 주세요.';
const TEST_FILE=`import test from 'node:test';
import assert from 'node:assert/strict';
import {formatDate} from './src/date-format.mjs';

test('formatDate returns YYYY-MM-DD for local dates', () => {
  assert.equal(formatDate(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(formatDate(new Date(2026, 9, 30)), '2026-10-30');
  assert.equal(formatDate(new Date(1999, 11, 31)), '1999-12-31');
});
`;

const dir=resume??mkdtempSync('/private/tmp/orbit-live-b-'),root=join(dir,'demo-repo'),db=join(dir,'orbit.sqlite');if(!resume)mkdirSync(root);
// The first live run charged codex.execution before launch although no process started. Correct the ledger to the observed
// process count of that run (once, recorded), so the resume gets exactly the approved Codex budget.
const ledgerCorrections:object[]=[];
if(live&&resume&&!approveResult&&!ledger.corrections?.some((c:any)=>c.run===resume)){
  const first=JSON.parse(readFileSync(join(resume,'evidence.json'),'utf8')),observed:Record<string,number>={};
  for(const launch of first.codexProcesses)observed[launch.purpose]=(observed[launch.purpose]??0)+1;
  for(const [purpose,charged] of Object.entries(first.calls.codex as Record<string,number>)){
    const actual=observed[purpose]??0;if(actual>=charged)continue;
    ledger.codex[purpose]-=charged-actual;
    ledgerCorrections.push({run:resume,provider:'codex',purpose,from:charged,to:actual,at:new Date().toISOString(),reason:'pre-charged before launch; first-run evidence codexProcesses shows no launched process (EXECUTION_BRIEF_TOO_LARGE before connect)'});
  }
  ledger.corrections=[...(ledger.corrections??[]),...ledgerCorrections];writeFileSync(LEDGER,JSON.stringify(ledger,null,2));
}
const evidence:any={kind:'live_b_e2e',mode:live?'live':'dry_run',startedAt:new Date().toISOString(),directory:dir,budget:BUDGET,
  resumeOf:resume,approveResult,ledgerCorrections,ledgerSha256Before:existsSync(LEDGER)?createHash('sha256').update(readFileSync(LEDGER)).digest('hex'):null,calls:{claude:{},codex:{}},cumulativeBefore:structuredClone({claude:ledger.claude,codex:ledger.codex,runs:ledger.runs.length}),
  claudeProcesses:[],codexProcesses:[],blocks:[],steps:{},stage:'setup',costUsd:null,remainingQuota:null,success:false};
const save=()=>{evidence.cumulativeAfter={claude:ledger.claude,codex:ledger.codex};writeFileSync(join(dir,approveResult?'evidence-approval.json':resume?'evidence-resume.json':'evidence.json'),JSON.stringify(evidence,null,2)+'\n');};
save();console.log(JSON.stringify({evidenceDirectory:dir,mode:evidence.mode}));
if(live&&!approveResult){ledger.runs.push(resume?dir+'#resume':dir);writeFileSync(LEDGER,JSON.stringify(ledger,null,2));}

/** The only gate for a provider call: refuses before launch when the cumulative per-purpose or total budget would be exceeded. */
function take(provider:Provider,purpose:string){
  const limits=BUDGET[provider] as Record<string,number>,used=ledger[provider],total=Object.values(used).reduce((a,b)=>a+b,0);
  if(!(purpose in limits)||(used[purpose]??0)+1>limits[purpose]||total+1>limits.total){evidence.blocks.push({step:'budget',code:`BUDGET_EXCEEDED_${provider}_${purpose}`});save();throw Error('BUDGET_EXCEEDED');}
  used[purpose]=(used[purpose]??0)+1;evidence.calls[provider][purpose]=(evidence.calls[provider][purpose]??0)+1;
  if(live)writeFileSync(LEDGER,JSON.stringify(ledger,null,2));save();
}
const remaining=(provider:Provider,purpose:string)=>{const limits=BUDGET[provider] as Record<string,number>,used=ledger[provider];return Math.min(limits[purpose]-(used[purpose]??0),limits.total-Object.values(used).reduce((a,b)=>a+b,0));};

// --- dry-run fakes (never used live) ---
const dryOutcome=(response:string):ClaudeOutcome=>({status:'completed',sessionId:null,exit:'observed',exitCode:0,signal:null,forced:false,ignoredLines:0,response} as ClaudeOutcome);
const dryResponses:Record<string,string>={
  planning:JSON.stringify({schema_version:'1.0',title:'날짜 표시 위젯',goal:'날짜를 YYYY-MM-DD로 보여 주는 정적 위젯',depth:'simple',depth_reason:'작은 정적 페이지',
    requirements:[{id:'R1',description:'src/date-format.mjs에 formatDate(date) export',acceptance_criteria:['date-format.test.mjs 통과']},{id:'R2',description:'index.html 날짜 선택 UI',acceptance_criteria:['선택 날짜를 YYYY-MM-DD로 표시']}],
    constraints:['네트워크 없이 동작'],decisions:[],open_questions:['요일도 표시할까요?']}),
  research:JSON.stringify({candidates:[{name:'dayjs',source:'https://www.npmjs.com/package/dayjs',version:'1.11.13',license:'MIT',decision:'adopt',reason:'작고 널리 쓰이는 날짜 형식화 라이브러리'}]}),
};
class DryCodex extends EventEmitter {
  evidenceSource='mock' as const;threadId=randomUUID();turnId=randomUUID();
  async initialize(){} async close(){this.emit('closed');}
  async request(method:string,params:any):Promise<any>{
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='config/read')return {config:{mcp_servers:{}}};
    if(method==='mcpServerStatus/list')return {data:[],nextCursor:null};
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:params.threadId??this.threadId,status:{type:'idle'}},approvalPolicy:params.approvalPolicy,approvalsReviewer:'user',
      sandbox:params.sandbox==='read-only'?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}};
    if(method==='turn/start'){
      mkdirSync(join(params.cwd,'src'),{recursive:true});
      writeFileSync(join(params.cwd,'src/date-format.mjs'),"export function formatDate(d){return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}\n");
      writeFileSync(join(params.cwd,'index.html'),'<!doctype html><title>Date</title><input type="date" id="d"><output id="o"></output><script type="module" src="app.mjs"></script>\n');
      setTimeout(()=>this.emit('notification',{method:'turn/completed',params:{threadId:this.threadId,turn:{id:this.turnId,status:'completed'}}}),20);
      return {turn:{id:this.turnId}};
    }
    if(method==='review/start'){
      setTimeout(()=>{
        this.emit('notification',{method:'item/completed',params:{threadId:this.threadId,turnId:this.turnId,item:{type:'exitedReviewMode',id:'review-1',review:'Dry-run review: no findings.'}}});
        this.emit('notification',{method:'turn/completed',params:{threadId:this.threadId,turn:{id:this.turnId,status:'completed',items:[]}}});
      },20);
      return {reviewThreadId:params.threadId,turn:{id:this.turnId,status:'inProgress',items:[]}};
    }
    return {};
  }
}
if(!live){
  const real=globalThis.fetch;
  globalThis.fetch=(async(input:any,init?:any)=>{
    const url=String(input);if(!url.startsWith('https://cdn.jsdelivr.net/'))return real(input,init);
    if(url.endsWith('/package.json'))return new Response(JSON.stringify({name:'dayjs',version:'1.11.13',main:'dayjs.min.js',license:'MIT'}),{headers:{'content-type':'application/json'}});
    if(url.endsWith('/dayjs.min.js'))return new Response('/* dry-run stand-in */\n',{headers:{'content-type':'application/javascript'}});
    if(url.endsWith('/LICENSE'))return new Response('MIT (dry-run)\n',{headers:{'content-type':'text/plain'}});
    return new Response('',{status:404});
  }) as typeof fetch;
}

// --- instrumented provider boundaries ---
const claudeRunner=(purpose:'planning'|'research')=>(config:ConstructorParameters<typeof ClaudeCodeRun>[0])=>{
  take('claude',purpose);
  const record:any={purpose,startedAt:new Date().toISOString(),model:null,auth:null,status:null,exit:null,durationMs:null};evidence.claudeProcesses.push(record);save();
  const real=live?new ClaudeCodeRun(config):{start:async()=>dryOutcome(dryResponses[purpose]),interrupt:()=>'not_running' as const};
  return {interrupt:()=>real.interrupt(),start:async(prompt:string,onEvent:(event:ClaudeEvent)=>void)=>{
    const began=performance.now();
    try{const out=await real.start(prompt,event=>{if(event.kind==='session'){record.model=event.model;record.auth=event.auth;}onEvent(event);});record.status=out.status;record.exit=out.exit;return out;}
    catch(error){record.status='threw';throw error;}
    finally{record.durationMs=Math.round(performance.now()-began);save();}
  }};
};
let armed:'execution'|'fix'|'review'|null=null;
const codex=(workspace:string,write:boolean):RpcPort=>{
  if(approveResult){evidence.blocks.push({step:'codex_launch',code:'CODEX_FORBIDDEN_ON_APPROVAL'});save();throw Error('CODEX_FORBIDDEN_ON_APPROVAL');}
  if(!armed){evidence.blocks.push({step:'codex_launch',code:'CODEX_LAUNCH_NOT_ARMED'});save();throw Error('CODEX_LAUNCH_NOT_ARMED');}
  evidence.codexProcesses.push({purpose:armed,write,at:new Date().toISOString()});save();armed=null;
  return live?codexFactory(workspace,write)():new DryCodex() as unknown as RpcPort;
};

const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
if(!resume){
  git(root,'init','-q','-b','main');
  writeFileSync(join(root,'README.md'),'Disposable Orbit LIVE-B demo repository. Contains no user data.\n');writeFileSync(join(root,'date-format.test.mjs'),TEST_FILE);
  git(root,'add','.');git(root,'-c','user.name=Orbit Validation','-c','user.email=orbit@example.invalid','commit','-qm','LIVE-B demo baseline');
}

process.env.ORBIT_REUSE_DISCOVERY='1';
const store=new Store(db),projects=new Projects(store,join(dir,'managed'),[root]);
const forbidden=(name:string)=>()=>{evidence.blocks.push({step:'claude_launch',code:name});save();throw Error(name);};
const controller=new Controller(store,createWorkspace(dir),codex,projects,[],[],
  {findExecutable:()=>'/forbidden/claude',runnerFactory:forbidden('CLAUDE_TASK_FORBIDDEN')},
  {runnerFactory:resume?forbidden('CLAUDE_PLANNING_FORBIDDEN_ON_RESUME'):claudeRunner('planning')},
  {findExecutable:()=>'/forbidden/claude',claudeFactory:forbidden('CLAUDE_CROSS_REVIEW_FORBIDDEN') as never});
// Instrument the research boundary only; the enable flag itself comes from ORBIT_REUSE_DISCOVERY as in production.
const planning=controller.planningSuggestions as unknown as {reuse:{enabled:boolean}};
if(planning.reuse?.enabled!==true)throw Error('REUSE_DISCOVERY_NOT_ENABLED');
planning.reuse={...planning.reuse,runnerFactory:resume?forbidden('CLAUDE_RESEARCH_FORBIDDEN_ON_RESUME'):claudeRunner('research')} as never;
const server=createHttpServer(controller,resolve('dist'));

const files=(base:string)=>readdirSync(base,{recursive:true}).map(String).filter(p=>!p.split('/').includes('.git')&&p!=='.git'&&statSync(join(base,p)).isFile()).sort()
  .map(p=>{const bytes=readFileSync(join(base,p));return {path:p,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});
const code=(error:unknown)=>error instanceof Error?error.message.replace(/^HTTP_\d+_/,''):'FAILED';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function poll<T>(read:()=>Promise<T>,done:(value:T)=>boolean,ms:number,label:string):Promise<T>{const deadline=Date.now()+ms;for(;;){const value=await read();if(done(value))return value;if(Date.now()>deadline)throw Error(label+'_DEADLINE');await sleep(500);}}
async function step<T>(name:string,work:()=>Promise<T>):Promise<T|null>{
  evidence.stage=name;save();const began=performance.now();
  try{const value=await work();evidence.steps[name]={...(evidence.steps[name]??{}),status:'passed',durationMs:Math.round(performance.now()-began)};return value;}
  catch(error){evidence.steps[name]={...(evidence.steps[name]??{}),status:'blocked',code:code(error),durationMs:Math.round(performance.now()-began)};evidence.blocks.push({step:name,code:code(error)});return null;}
  finally{save();}
}
const note=(name:string,value:object)=>{evidence.steps[name]={...(evidence.steps[name]??{}),...value};save();};

const started=performance.now();
try{
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as any;
  const headers={cookie,origin,'content-type':'application/json','x-csrf-token':csrfToken};
  const api=async(path:string,data?:object)=>{const response=await fetch(origin+path,{headers,method:data?'POST':'GET',...(data?{body:JSON.stringify(data)}:{})});const body:any=await response.json();if(!response.ok)throw Error('HTTP_'+response.status+'_'+String(body.error??body.code??'FAILED'));return body;};

  // 1. Code project + isolated worktree, planning on Claude Code, execution on Codex.
  let resumed:{version:PlanningVersion;task:SavedTask}|null=null;
  const ctx=resume?await step('resume_load',async()=>{
    // Same saved project, worktree, approved plan and task; nothing is re-planned or re-approved.
    const project=store.projects().find(p=>p.kind==='code')!,workspace=projects.workspaces().find(w=>w.projectId===project?.id);
    if(!project||!workspace||store.projects().length!==1)throw Error('RESUME_STATE_INVALID');
    await api('/api/workspaces/select',{workspaceId:workspace.id});
    const base='/api/projects/'+project.id,plans:PlanningVersion[]=await api(base+'/plans'),version=plans.find(v=>v.state==='approved');
    const tasks:SavedTask[]=(await api(base+'/tasks')).filter((t:SavedTask)=>t.planningVersionId===version?.id);
    if(!version||tasks.length!==1)throw Error('RESUME_PLAN_INVALID');
    resumed={version,task:tasks[0]};
    note('resume_load',{projectId:project.id,workspaceId:workspace.id,baseSha:workspace.baseSha,planningVersionId:version.id,revision:version.revision,contentHash:version.contentHash,
      taskId:tasks[0].id,priorRuns:store.runs().length,preferences:await api(base+'/ai-preferences'),verificationSetup:(await api('/api/workspaces/'+workspace.id+'/verification-setup')).revision});
    return {project,workspace,base,ws:'/api/workspaces/'+workspace.id};
  }):await step('project',async()=>{
    const project=await api('/api/projects',{path:root}),workspace=await api('/api/workspaces',{projectId:project.id});
    await api('/api/workspaces/select',{workspaceId:workspace.id});
    const preferences=await api('/api/projects/'+project.id+'/ai-preferences',{expectedRevision:0,planning:'claude-code',execution:'codex'});
    note('project',{projectId:project.id,workspaceId:workspace.id,baseSha:workspace.baseSha,preferences});
    return {project,workspace,base:'/api/projects/'+project.id,ws:'/api/workspaces/'+workspace.id};
  });
  if(!ctx)throw Error('PROJECT_SETUP_FAILED');
  const {project,workspace,base,ws}=ctx;

  // 2. Orbit verification command from the repository's existing Node test (protected from edits).
  if(!resume)await step('verification_setup',async()=>{
    const view=await api(ws+'/verification-setup');if(!view.candidate)throw Error(view.issue??'NO_CANDIDATE');
    const receipt=await api(ws+'/verification-setup',{requestId:randomUUID(),profileId:'node-test-v1',expectedPreviewDigest:view.candidate.previewDigest,confirmed:true});
    note('verification_setup',{receipt,tests:view.candidate.tests,command:{executable:'node',args:view.candidate.command.args}});
  });

  // 3. Natural-language request -> Claude planning proposal, then opt-in public reuse research (Claude research mode).
  const suggestion=resume?null:await step('planning',async()=>{
    if(remaining('claude','planning')<1)throw Error('BUDGET_EXCEEDED_claude_planning');
    const preview=await api(base+'/planning-suggestions/preview',{workspaceId:workspace.id,text:DEMO_REQUEST});
    note('planning',{runtime:preview.runtime,scope:preview.scope,previewDigest:preview.previewDigest,request:DEMO_REQUEST});
    const record=await api(base+'/planning-suggestions/start',{requestId:randomUUID(),workspaceId:workspace.id,text:DEMO_REQUEST,expectedPreviewDigest:preview.previewDigest,confirmed:true});
    note('planning',{suggestionId:record.id});
    const done=await poll(async()=>(await api(base+'/planning-suggestions?workspaceId='+workspace.id)).records.find((r:any)=>r.id===record.id),r=>r.execution!=='running',240000,'PLANNING');
    const reuse=store.eventsAfter(0).filter(e=>e.kind==='planning_suggestion.reuse_discovery').map(e=>e.data);
    note('planning',{execution:done.execution,issue:done.issue,processStopped:done.processStopped,durationMs:done.durationMs,outputDigest:done.outputDigest,
      requirements:done.proposal?.requirements?.length??null,openQuestions:done.proposal?.openQuestions??null,decisions:done.proposal?.decisions??null,reuseDiscovery:reuse});
    if(done.execution!=='completed')throw Error(done.issue??'PLANNING_NOT_COMPLETED');
    return done;
  });

  // 4. User saves, (if needed) edits, and approves the plan; tasks are drafted from it.
  // User result approval: same digests the development result view shows; no provider process may start.
  if(approveResult){
    const task=resumed!.task,runs=store.runs().filter(r=>r.taskId===task.id&&r.execution==='completed'&&r.runtime==='codex');
    if(runs.length!==1){evidence.blocks.push({step:'approval_before',code:'RESUME_RUN_INVALID'});throw Error('RESUME_RUN_INVALID');}
    const runId=runs[0].id,events=()=>store.lastSeq();
    const snapshot=async(name:string)=>{
      const before=events(),progress=await api(base+'/progress'),view=await api(ws+'/verification?runId='+runId),result=await api(ws+'/result?runId='+runId);
      const item=progress.tasks.find((t:any)=>t.id===task.id);
      note(name,{runId,eventSeq:before,readOnly:events()===before,progress:{stage:item.stage,verification:item.verification,projectBlockers:progress.blockers,
        quality:Object.fromEntries(Object.entries(item.quality).filter(([k])=>k!=='evidence').map(([k,v]:[string,any])=>[k,{status:v.status,blockers:v.blockers,nextAction:v.nextAction}])),
        completion:item.completion??null,totals:progress.totals},
        verification:{canApprove:view.canApprove,approval:view.approval,approvalCurrent:view.approvalCurrent,sourceDigest:view.sourceDigest,checkSetDigest:view.checkSetDigest,checks:view.checks.map((c:any)=>({id:c.id,verdict:c.verdict}))},
        developmentResult:{canApprove:result.verification?.canApprove??null,approvalCurrent:result.verification?.approvalCurrent??null}});
      if(events()!==before)throw Error('GET_WROTE_EVENTS');
      return view;
    };
    const view=await step('approval_before',()=>snapshot('approval_before'));
    if(view)await step('user_result_approval',async()=>{
      const body={requestId:randomUUID(),runId,expectedSourceDigest:view.sourceDigest,expectedCheckSetDigest:view.checkSetDigest};
      note('user_result_approval',{request:{runId,expectedSourceDigest:body.expectedSourceDigest,expectedCheckSetDigest:body.expectedCheckSetDigest},canApproveBefore:view.canApprove});
      if(!view.checkSetDigest)throw Error('VERIFICATION_REQUIRED_NO_CHECK_SET');
      const response=await fetch(origin+ws+'/review-approval',{method:'POST',headers,body:JSON.stringify(body)}),record=await response.json() as any;
      note('user_result_approval',{httpStatus:response.status,response:record});
      if(!response.ok)throw Error(String(record.error??'APPROVAL_FAILED'));
      const again=await fetch(origin+ws+'/review-approval',{method:'POST',headers,body:JSON.stringify(body)}),same=await again.json() as any;
      note('user_result_approval',{idempotentReplay:{httpStatus:again.status,sameApprovalId:same.id===record.id}});
    });
    await step('approval_after',()=>snapshot('approval_after'));
  }
  const approved=approveResult?null:resume?resumed:suggestion&&await step('plan_approval',async()=>{
    let version:PlanningVersion=await api(base+'/planning-suggestions/'+suggestion.id+'/save',{workspaceId:workspace.id,expectedOutputDigest:suggestion.outputDigest});
    const draft=version.draft;
    if(draft.requirements.length>1||draft.openQuestions.length){
      // The demo user keeps one Codex execution: merge requirements into one and answer open questions with the plan's default.
      const doc=JSON.parse(serializePlanningDraft(draft));delete doc.source;
      doc.requirements=[{id:draft.requirements[0].label,description:draft.requirements.map(r=>r.description).join('\n'),acceptance_criteria:[...new Set(draft.requirements.flatMap(r=>r.acceptanceCriteria))]}];
      doc.decisions=[...doc.decisions,...draft.openQuestions.map(q=>({topic:q.slice(0,200),decision:'사용자 결정: 기획안의 기본 제안대로 진행',rationale:'LIVE-B 데모 사용자가 열린 질문에 기본안으로 답함'}))];doc.open_questions=[];
      version=await api(base+'/plans/'+version.id+'/revisions',{requestId:randomUUID(),expectedRevision:version.revision,input:{format:'json',source:'manual',text:JSON.stringify(doc)}});
      note('plan_approval',{userRevision:{mergedRequirements:draft.requirements.length,answeredQuestions:draft.openQuestions.length}});
    }
    const approvedVersion:PlanningVersion=await api(base+'/plans/'+version.id+'/approve',{expectedRevision:version.revision});
    const tasks:SavedTask[]=await api(base+'/plans/'+approvedVersion.id+'/task-drafts',{});
    note('plan_approval',{planningVersionId:approvedVersion.id,revision:approvedVersion.revision,contentHash:approvedVersion.contentHash,title:approvedVersion.draft.title,
      requirements:approvedVersion.draft.requirements,decisions:approvedVersion.draft.decisions??[],taskIds:tasks.map(t=>t.id)});
    if(tasks.length!==1)throw Error('TASK_COUNT_'+tasks.length);
    return {version:approvedVersion,task:tasks[0]};
  });
  if(stopAfterApproval)throw Error('STOPPED_AFTER_APPROVAL');

  // 5. Codex execution of the approved task in the disposable worktree.
  let runId:string|null=null;
  const runTask=async(purpose:'execution'|'fix')=>{
    // The acceptance preview builds the execution brief, so brief errors surface here before any launch is charged.
    const acceptance=(await api(base+'/tasks/'+approved!.task.id+'/verification-preview?workspaceId='+workspace.id)).preview;
    // A launched app-server or a new turn counts as the call even if the turn never completes.
    take('codex',purpose);
    if(controller.snapshot().provider!=='ready'){armed=purpose;try{await api('/api/connect',{});}finally{armed=null;}}
    const run=await api(base+'/tasks/'+approved!.task.id+'/run',{requestId:randomUUID(),workspaceId:workspace.id,...(acceptance?{expectedAcceptanceDigest:acceptance.digest}:{})});
    const done=await poll(async()=>store.getRun(run.id)!,r=>['completed','interrupted','failed','lost'].includes(r.execution),180000,'RUN');
    const identity=await api('/api/runs/'+run.id+'/model-identity');
    note(purpose,{runId:run.id,execution:done.execution,issue:(done as any).issue??null,acceptanceDigest:acceptance?.digest??null,modelIdentity:identity,files:files(workspace.path),
      gitStatus:git(workspace.path,'status','--porcelain')});
    if(done.execution!=='completed')throw Error('RUN_'+done.execution.toUpperCase());
    return run.id as string;
  };
  if(approved)runId=await step('execution',()=>runTask('execution'));

  // 6. Orbit verification command against the exact produced source.
  const verify=async(name:string,id:string)=>{
    const view=await api(ws+'/verification?runId='+id),command=view.commands[0];if(!command||!view.sourceDigest)throw Error(view.sourceIssue??'NO_VERIFICATION_COMMAND');
    const check=await api(ws+'/checks',{requestId:randomUUID(),runId:id,commandId:command.id,expectedSourceDigest:view.sourceDigest,expectedConfigDigest:command.configDigest});
    const done=await poll(async()=>(await api(ws+'/verification?runId='+id)).checks.find((c:any)=>c.id===check.id),c=>c&&c.execution!=='running',90000,'VERIFICATION');
    const after=await api(ws+'/verification?runId='+id);
    note(name,{checkId:check.id,verdict:done.verdict,exitCode:done.exitCode,durationMs:done.durationMs,output:String(done.output).slice(-1500),canApprove:after.canApprove,acceptance:after.acceptance??null});
    return done.verdict as string;
  };
  let verdict:string|null=null;
  if(runId)verdict=await step('verification',()=>verify('verification',runId!));
  // Fix (<=1 Codex turn): re-run the same approved task once if verification did not pass.
  if(runId&&verdict&&verdict!=='passed'){
    const fixed=await step('fix',async()=>{if(remaining('codex','fix')<1)throw Error('BUDGET_EXCEEDED_codex_fix');return runTask('fix');});
    if(fixed){runId=fixed;verdict=await step('fix_verification',()=>verify('fix_verification',fixed));}
  }
  evidence.finalVerdict=verdict;

  // 7. Development result view + app preview served by Orbit's isolated preview host.
  if(runId){
    await step('development_result',async()=>{const result=await api(ws+'/result?runId='+runId);note('development_result',{view:result});});
    await step('app_preview',async()=>{
      const catalog=await api(ws+'/app-preview');note('app_preview',{entries:catalog.entries,sourceDigest:catalog.sourceDigest});
      const entryPath=catalog.entries.includes('index.html')?'index.html':catalog.entries[0];if(!entryPath)throw Error('APP_PREVIEW_NO_HTML');
      const preview=await api(ws+'/app-preview',{entryPath,expectedSourceDigest:catalog.sourceDigest});
      const served=await new Promise<{status:number;bytes:Buffer;csp:string|undefined}>((ok,fail)=>httpGet(preview.url,{headers:{'sec-fetch-dest':'iframe'}},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>ok({status:res.statusCode!,bytes:Buffer.concat(chunks),csp:res.headers['content-security-policy'] as string|undefined}));}).on('error',fail));
      const disk=readFileSync(join(workspace.path,entryPath));
      note('app_preview',{entryPath,fileCount:preview.fileCount,httpStatus:served.status,servedSha256:createHash('sha256').update(served.bytes).digest('hex'),matchesWorkspaceFile:served.bytes.equals(disk),csp:served.csp});
      if(served.status!==200||!served.bytes.equals(disk))throw Error('APP_PREVIEW_MISMATCH');
    });
  }

  // 8. Reuse vendor (jsDelivr pinned) only for an approved adopt decision with an exact semver; after preview, before review.
  if(approved)await step('reuse_vendor',async()=>{
    const {decisions}=await api(ws+'/reuse-vendor');
    const adopt=decisions.find((d:any)=>/^재사용 채택: \S+ \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)? /.test(d.decision));
    note('reuse_vendor',{approvedDecisions:decisions});
    if(!adopt){note('reuse_vendor',{skipped:'NO_ADOPT_DECISION_WITH_EXACT_SEMVER'});return;}
    const result=await api(ws+'/reuse-vendor',{planningVersionId:adopt.planningVersionId,topic:adopt.topic});
    note('reuse_vendor',{result,evidence:(await api(ws+'/reuse-vendor')).evidence,files:files(workspace.path).filter(f=>f.path.startsWith('vendor/'))});
  });

  // 9. Codex review of the frozen diff (read-only, text-only).
  if(runId)await step('codex_review',async()=>{
    if(remaining('codex','review')<1)throw Error('BUDGET_EXCEEDED_codex_review');
    const preview=await api(ws+'/reviews/preview?runId='+runId);
    note('codex_review',{files:preview.files,patchBytes:preview.patchBytes});
    take('codex','review');armed='review';
    let done;
    try{
      const record=await api('/api/reviews/start',{requestId:randomUUID(),workspaceId:workspace.id,runId,expectedPreviewDigest:preview.previewDigest,confirmed:true});
      done=await poll(async()=>(await api(ws+'/reviews?runId='+runId)).records.find((r:any)=>r.id===record.id),r=>r.execution!=='running',150000,'REVIEW');
    }finally{armed=null;}
    note('codex_review',{reviewId:done.id,execution:done.execution,issue:done.issue,durationMs:done.durationMs,processStopped:done.processStopped,response:String(done.response).slice(0,4000)});
    if(done.execution!=='completed')throw Error(done.issue??'REVIEW_NOT_COMPLETED');
  });

  // 10. Claude cross-review of Codex output: must stop at QUALITY_PRODUCER_MODEL_UNKNOWN before any reviewer launch.
  if(runId)await step('claude_cross_review',async()=>{
    const input={sourceRunId:runId,reviewers:[{id:'claude-cross-review',providerId:'anthropic',modelId:'claude-opus-5-5'}],limits:{maxCalls:1,maxRepairs:0,timeoutMs:120000}};
    const preview=await api(base+'/quality-loops/preview',input);
    const record=await api(base+'/quality-loops/start',{...input,requestId:randomUUID(),expectedPreviewDigest:preview.previewDigest,confirmed:true});
    note('claude_cross_review',{producer:preview.producer,status:record.result.status,issue:record.result.issue,calls:record.result.calls,steps:record.steps.length});
    if(record.result.issue!=='QUALITY_PRODUCER_MODEL_UNKNOWN'||record.steps.length)throw Error('UNEXPECTED_QUALITY_RESULT');
    evidence.blocks.push({step:'claude_cross_review',code:'QUALITY_PRODUCER_MODEL_UNKNOWN',expected:true});
  });

  // 11. One place: project progress + development result (read-only GETs must not write).
  await step('progress',async()=>{
    const before=store.lastSeq(),progress=await api(base+'/progress'),result=runId?await api(ws+'/result?runId='+runId):null;
    note('progress',{snapshot:progress,developmentResult:result,readOnly:store.lastSeq()===before});
    if(store.lastSeq()!==before)throw Error('GET_WROTE_EVENTS');
  });
  evidence.sourceRepoClean=git(root,'status','--porcelain')==='';
  evidence.finalFiles=files(workspace.path);
}catch(error){evidence.error=code(error);process.exitCode=1;}
finally{
  evidence.durationMs=Math.round(performance.now()-started);evidence.finishedAt=new Date().toISOString();
  evidence.runs=store.runs().map(r=>({id:r.id,execution:r.execution,runtime:r.runtime,taskId:r.taskId}));
  evidence.events=store.eventsAfter(0).map(({seq,at,kind,runId})=>({seq,at,kind,runId}));
  const stepStatus=Object.values(evidence.steps).map((s:any)=>s.status);
  evidence.success=!evidence.error&&(approveResult||evidence.finalVerdict==='passed')&&stepStatus.length>0&&stepStatus.every(s=>s==='passed');
  evidence.ledgerSha256After=existsSync(LEDGER)?createHash('sha256').update(readFileSync(LEDGER)).digest('hex'):null;
  save();
  try{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await controller.close();store.close();}
  catch(error){evidence.postprocessingError=code(error);process.exitCode=1;}
  save();console.log(JSON.stringify({directory:dir,mode:evidence.mode,success:evidence.success,stage:evidence.stage,error:evidence.error,calls:evidence.calls,blocks:evidence.blocks,durationMs:evidence.durationMs}));
}
