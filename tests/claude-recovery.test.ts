import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,rmSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {AppError} from '../server/errors.ts';
import {createHttpServer} from '../server/http.ts';
import {claudeQuotaResetsAt} from '../server/claude-task-service.ts';
import {buildProjectProgress,type ProjectProgress} from '../shared/project-progress.ts';
import type {ClaudeTaskServiceOptions} from '../server/claude-task-service.ts';
import {claudeFixture,outcome,session,tick} from './claude-task-fixture.ts';

const error=(message:string,status=409)=>(e:unknown)=>e instanceof AppError&&e.message===message&&e.status===status;
/** Pending until interrupted, so Controller.close observes its exit. */
const pendingRunner=()=>{let stop=()=>{};return {start:()=>new Promise<ReturnType<typeof outcome>>(resolve=>{stop=()=>resolve(outcome('interrupted'));}),interrupt:()=>{stop();return 'requested' as const;}};};
const recoveryEvents=(store:Store)=>store.eventsAfter(0).filter(e=>e.kind==='run.recovery_confirmed');

test('lost Claude run: explicit confirmation releases only the block; same requestId never re-dispatches',async()=>{
  const f=claudeFixture({runnerFactory:()=>({start:()=>Promise.reject(new Error('lost')),interrupt:()=>'not_running'})});
  try{
    const {task}=f.plan(),requestId=randomUUID(),run=await f.controller.submitTask(f.project.id,task.id,{requestId});await tick();
    assert.equal(f.store.getRun(run.id)!.execution,'lost');
    assert.deepEqual(f.controller.claudeRecoveries(f.project.id),[{runId:run.id,taskId:task.id,state:'required',lostReason:'EXIT_NOT_OBSERVED',exitObserved:false,basis:null,releasedAt:null}]);
    const recoverId=randomUUID();
    assert.throws(()=>f.controller.recoverClaudeRun(f.project.id,run.id,{requestId:recoverId,confirmedStopped:false}),error('CLAUDE_STOP_CONFIRMATION_REQUIRED'));
    await assert.rejects(f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error('SOLO_RECOVERY_REQUIRED'));
    assert.throws(()=>f.controller.recoverClaudeRun(f.project.id,randomUUID(),{requestId:recoverId,confirmedStopped:true}),error('RUN_NOT_FOUND',404));
    assert.throws(()=>f.controller.recoverClaudeRun(f.project.id,run.id,{requestId:'bad',confirmedStopped:true}),error('INVALID_REQUEST_ID',400));
    const released=f.controller.recoverClaudeRun(f.project.id,run.id,{requestId:recoverId,confirmedStopped:true});
    assert.equal(released.state,'released');assert.equal(released.basis,'user_confirmed_stopped');assert.ok(released.releasedAt);
    // Idempotent: replay and a second request return the same record without another event.
    assert.deepEqual(f.controller.recoverClaudeRun(f.project.id,run.id,{requestId:recoverId,confirmedStopped:true}),released);
    assert.deepEqual(f.controller.recoverClaudeRun(f.project.id,run.id,{requestId:randomUUID(),confirmedStopped:true}),released);
    assert.equal(recoveryEvents(f.store).length,1);
    // History preserved and never marked successful.
    assert.equal(f.store.getRun(run.id)!.execution,'lost');assert.equal(f.store.runs().length,1);
    // The original requestId replays the lost run; it is never dispatched again.
    assert.equal((await f.controller.submitTask(f.project.id,task.id,{requestId})).id,run.id);
    assert.equal(f.store.runs().length,1);
  }finally{await f.close();}
});

test('a released task accepts a new run only with a new requestId, and recovery requestIds cannot be reused across runs',async()=>{
  let launches=0;
  const f=claudeFixture({runnerFactory:()=>{launches++;return launches===1?{start:()=>Promise.reject(new Error('lost')),interrupt:()=>'not_running' as const}:pendingRunner();}});
  try{
    const {task}=f.plan(),first=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});await tick();
    const recoverId=randomUUID();f.controller.recoverClaudeRun(f.project.id,first.id,{requestId:recoverId,confirmedStopped:true});
    const second=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});
    assert.notEqual(second.id,first.id);assert.equal(launches,2);
    assert.throws(()=>f.controller.recoverClaudeRun(f.project.id,second.id,{requestId:recoverId,confirmedStopped:true}),error('IDEMPOTENCY_CONFLICT'));
    assert.throws(()=>f.controller.recoverClaudeRun(f.project.id,second.id,{requestId:randomUUID(),confirmedStopped:true}),error('CLAUDE_RUN_STILL_OWNED'));
  }finally{await f.close();}
});

test('observed exit with unknown result is recorded as exit_observed; non-lost runs stay out of recovery',async()=>{
  const f=claudeFixture();try{
    const {task}=f.plan(),run=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});
    f.runners[0].emit(session);f.runners[0].finish(outcome('unknown'));await tick();
    assert.equal(f.store.getRun(run.id)!.execution,'lost');
    const released=f.controller.recoverClaudeRun(f.project.id,run.id,{requestId:randomUUID(),confirmedStopped:true});
    assert.equal(released.basis,'exit_observed');assert.equal(released.lostReason,'RESULT_NOT_OBSERVED');assert.equal(released.exitObserved,true);
  }finally{await f.close();}
  const g=claudeFixture();try{
    const {task}=g.plan(),run=await g.controller.submitTask(g.project.id,task.id,{requestId:randomUUID()});
    g.runners[0].finish(outcome('completed'));await tick();
    assert.throws(()=>g.controller.recoverClaudeRun(g.project.id,run.id,{requestId:randomUUID(),confirmedStopped:true}),error('CLAUDE_RUN_NOT_LOST'));
    assert.deepEqual(g.controller.claudeRecoveries(g.project.id),[]);assert.equal(recoveryEvents(g.store).length,0);
  }finally{await g.close();}
});

test('restart-lost run keeps SERVER_RESTART reason and is released only by the explicit action',async()=>{
  const f=claudeFixture(),{task}=f.plan(),run=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});
  f.store.close();const store=new Store(f.db),projects=new Projects(store,f.managed,[],f.root);
  let launched=0;
  const options:ClaudeTaskServiceOptions={findExecutable:()=>'/fake/claude',runnerFactory:()=>{launched++;return pendingRunner();}};
  const controller=new Controller(store,f.dir,()=>{throw new Error('CODEX_FORBIDDEN');},projects,[],[],options);
  try{
    assert.equal(controller.claudeRecoveries(f.project.id)[0].lostReason,'SERVER_RESTART');
    await assert.rejects(controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error('SOLO_RECOVERY_REQUIRED'));
    assert.equal(launched,0,'restart never resumes work');
    controller.recoverClaudeRun(f.project.id,run.id,{requestId:randomUUID(),confirmedStopped:true});
    assert.equal(launched,0,'recovery never dispatches');
  }finally{await controller.close();store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('HTTP recover route enforces session, CSRF and exact fields; progress GET exposes recovery without mutating',async()=>{
  const f=claudeFixture({runnerFactory:()=>({start:()=>Promise.reject(new Error('lost')),interrupt:()=>'not_running'})});
  const server=createHttpServer(f.controller,'.');await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
    const response=await fetch(origin+'/api/session'),cookie=response.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await response.json() as {csrfToken:string};
    const headers={cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
    const {task}=f.plan(),run=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});await tick();
    const path=`/api/projects/${f.project.id}/claude-runs/${run.id}/recover`,body={requestId:randomUUID(),confirmedStopped:true};
    assert.equal((await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
    assert.equal((await fetch(origin+path,{method:'POST',headers:{...headers,'X-CSRF-Token':''},body:JSON.stringify(body)})).status,403);
    for(const bad of [{...body,extra:1},{requestId:body.requestId},{...body,confirmedStopped:'yes'}]){
      const r=await fetch(origin+path,{method:'POST',headers,body:JSON.stringify(bad)});assert.equal(r.status,400);assert.deepEqual(await r.json(),{error:'INVALID_FIELDS'});
    }
    const seq=f.store.lastSeq();
    const before=await (await fetch(origin+`/api/projects/${f.project.id}/progress`,{headers:{cookie}})).json() as ProjectProgress;
    assert.equal(before.claudeRecovery![0].state,'required');assert.equal(f.store.lastSeq(),seq,'GET appends no events');
    assert.equal((await fetch(origin+path,{method:'GET',headers:{cookie}})).status,404);
    const denied=await fetch(origin+path,{method:'POST',headers,body:JSON.stringify({...body,confirmedStopped:false})});
    assert.equal(denied.status,409);assert.deepEqual(await denied.json(),{error:'CLAUDE_STOP_CONFIRMATION_REQUIRED'});
    const ok=await fetch(origin+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(ok.status,200);
    assert.equal((await ok.json() as {state:string}).state,'released');
    const after=await (await fetch(origin+`/api/projects/${f.project.id}/progress`,{headers:{cookie}})).json() as ProjectProgress;
    assert.equal(after.claudeRecovery![0].state,'released');assert.equal(after.tasks[0].stage,'lost','history stays lost');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});

test('quota reset time is reported only from observed rejected windows',()=>{
  const w=(status:string,resetsAt:string|null)=>({id:'x',utilization:1,resetsAt,status});
  assert.equal(claudeQuotaResetsAt(null),null);
  assert.equal(claudeQuotaResetsAt({windows:[]}),null);
  assert.equal(claudeQuotaResetsAt({windows:[w('rejected',null)]}),null);
  assert.equal(claudeQuotaResetsAt({windows:[w('allowed','2026-10-29T01:00:00.000Z')]}),null);
  assert.equal(claudeQuotaResetsAt({windows:[w('rejected','2026-10-29T01:00:00.000Z'),w('rejected',null)]}),null,'any unknown rejected window keeps it unknown');
  assert.equal(claudeQuotaResetsAt({windows:[w('rejected','2026-10-29T01:00:00.000Z'),w('rejected','2026-10-30T01:00:00.000Z'),w('allowed','2026-10-31T01:00:00.000Z')]}),'2026-10-30T01:00:00.000Z');
  const base={projectId:'p',tasks:[],runs:[],checks:[],plans:[],currentPlanIds:[]};
  assert.deepEqual(buildProjectProgress({...base,signals:{quota:'exhausted',quotaResetsAt:null}}).blockers,[{code:'QUOTA_EXHAUSTED',scope:'project',resetsAt:null}]);
  assert.deepEqual(buildProjectProgress({...base,signals:{quota:'exhausted'}}).blockers,[{code:'QUOTA_EXHAUSTED',scope:'project'}]);
  assert.deepEqual(buildProjectProgress({...base,signals:{quota:'available',quotaResetsAt:'2026-10-29T01:00:00.000Z'}}).blockers,[]);
});

test('UI shows plain recovery control, gated release button and manual-resume quota guidance',async()=>{
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  const {ClaudeRecoveryControl,QuotaResumeNote}=await import('../web/claude-recovery.tsx').finally(()=>hooks.deregister());
  const required={runId:'a'.repeat(36),taskId:'t',state:'required' as const,lostReason:'SERVER_RESTART',exitObserved:false,basis:null,releasedAt:null};
  const html=renderToStaticMarkup(createElement(ClaudeRecoveryControl,{recovery:required,advanced:false,busy:false,onRecover:()=>{}}));
  assert.match(html,/서버가 다시 시작/);assert.match(html,/자동으로 다시 실행하지 않습니다/);assert.match(html,/<button disabled="">종료 확인하고 차단 해제/);
  assert.doesNotMatch(html,/SERVER_RESTART/,'simple mode hides codes');
  assert.match(renderToStaticMarkup(createElement(ClaudeRecoveryControl,{recovery:required,advanced:true,busy:false})),/SERVER_RESTART/);
  const released=renderToStaticMarkup(createElement(ClaudeRecoveryControl,{recovery:{...required,state:'released',basis:'user_confirmed_stopped',releasedAt:'2026-10-29T00:00:00.000Z'},advanced:false,busy:false}));
  assert.match(released,/차단 해제됨/);assert.match(released,/여전히 미확인/);assert.match(released,/2026\. 10\. 29\.[^(]*9[^(]*\(KST\)/);
  assert.match(renderToStaticMarkup(createElement(QuotaResumeNote,{resetsAt:null})),/알 수 없음.*자동으로 재개하지 않습니다/);
  assert.equal(renderToStaticMarkup(createElement(QuotaResumeNote,{resetsAt:undefined})),'');
});
