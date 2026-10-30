import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {claudeArgs} from '../server/runtimes/claude-code.ts';
import {claudeTaskPrompt} from '../server/runtimes/claude-task.ts';
import {PlanningAgentService} from '../server/planning-agent-service.ts';
import {kstIso,parseReuseResponse,reuseDecisions,runReuseDiscovery} from '../server/reuse-discovery.ts';
import {FakeClaudeRun,outcome,planningInput,tick} from './claude-task-fixture.ts';

const now=()=>new Date('2026-10-30T03:04:05Z'),query='제목: 보고서\n목표: 여행 결제 비교\n요구사항:\n- R1: 비교표 작성';
const candidate=(extra:object={})=>({name:'pandas',source:'https://pandas.pydata.org/',version:'2.2.3',license:'BSD-3-Clause',decision:'adopt',reason:'Official, maintained table library',...extra});
const response=(candidates:object[])=>JSON.stringify({candidates});
// The temp cwd is created asynchronously before launch; wait for real I/O, not a fixed tick count.
const until=async(ready:()=>unknown)=>{for(let i=0;i<1000&&!ready();i++)await tick();assert.ok(ready());};
function fixture(){
  const runner=new FakeClaudeRun(),configs:any[]=[];
  return {runner,configs,options:{now,findExecutable:()=>'/fake/claude',runnerFactory:(config:any)=>{configs.push(config);return runner;}}};
}

test('research mode exposes only web tools in plan mode, and runs from an empty temp cwd outside the project',async()=>{
  const args=claudeArgs({mode:'research'});
  assert.equal(args[args.indexOf('--tools')+1],'WebSearch,WebFetch');assert.equal(args[args.indexOf('--permission-mode')+1],'plan');
  assert.doesNotMatch(args[args.indexOf('--tools')+1],/Read|Grep|Glob|Edit|Write|Bash/);
  assert.equal(claudeArgs({mode:'write'})[claudeArgs({mode:'write'}).indexOf('--tools')+1],'Read,Grep,Glob,Edit,Write');
  const f=fixture(),pending=runReuseDiscovery({query,timeoutMs:1000},f.options);
  await until(()=>f.configs.length);const config=f.configs[0];
  assert.equal(config.mode,'research');assert.match(config.cwd,/orbit-reuse-/);assert.ok(!config.cwd.startsWith(process.cwd()));
  assert.deepEqual(readdirSync(config.cwd),[]);assert.match(f.runner.prompt,/untrusted data/);assert.match(f.runner.prompt,/여행 결제 비교/);
  f.runner.finish(outcome('completed',{response:response([candidate()])}));const result=await pending;
  assert.equal(result.status,'searched');assert.equal(result.checkedAt,'2026-10-30T12:04:05+09:00');assert.equal(result.candidates[0].source,'https://pandas.pydata.org/');
  assert.equal(existsSync(config.cwd),false,'temp cwd is removed afterwards');
});

test('credential or personal data in the query is blocked without spawning',async()=>{
  for(const [text,code] of [['목표: key sk-abcdefghijklmnop0123','CREDENTIAL_LIKE_INPUT'],['목표: person@example.com 에게 보고','PERSONAL_DATA_BLOCKED']]){
    const f=fixture(),result=await runReuseDiscovery({query:text,timeoutMs:1000},f.options);
    assert.equal(result.status,'blocked');assert.equal(result.issue,code);assert.equal(f.configs.length,0);
  }
});

test('response parsing is strict: extra keys, http URLs, >3 candidates and 2 adopts are invalid',async()=>{
  assert.equal(parseReuseResponse('```json\n'+response([candidate()])+'\n```').length,1);
  assert.deepEqual(parseReuseResponse(response([])),[]);
  for(const bad of [JSON.stringify({candidates:[candidate()],note:'x'}),response([candidate({extra:1})]),response([candidate({source:'http://pandas.pydata.org/'})]),
    response([candidate({source:'https://user:pw@example.com/'})]),response([candidate({decision:'maybe'})]),response([candidate({name:'x'.repeat(81)})]),
    response([candidate(),candidate({decision:'reject'}),candidate({decision:'reject'}),candidate({decision:'reject'})]),response([candidate(),candidate()]),'Sure! here you go']){
    assert.throws(()=>parseReuseResponse(bad));
    const f=fixture(),pending=runReuseDiscovery({query,timeoutMs:1000},f.options);await until(()=>f.configs.length);
    f.runner.finish(outcome('completed',{response:bad}));const result=await pending;
    assert.equal(result.status,'invalid');assert.deepEqual(result.candidates,[]);
  }
});

test('timeout with observed exit is timed_out; unobserved exit is lost; missing CLI is unavailable',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),pending=runReuseDiscovery({query,timeoutMs:1000},f.options);await until(()=>f.configs.length);
  t.mock.timers.tick(1000);assert.equal(f.runner.interrupts,1);f.runner.finish(outcome('interrupted'));
  assert.equal((await pending).status,'timed_out');
  const g=fixture(),lost=runReuseDiscovery({query,timeoutMs:1000},g.options);await until(()=>g.configs.length);
  t.mock.timers.tick(1000);t.mock.timers.tick(6000);const result=await lost;assert.equal(result.status,'lost');assert.equal(result.issue,'REUSE_PROCESS_STOP_UNCONFIRMED');
  const h=fixture(),unobserved=runReuseDiscovery({query,timeoutMs:1000},h.options);await until(()=>h.configs.length);
  h.runner.finish(outcome('completed',{response:response([candidate()]),exit:'not_observed'}));assert.equal((await unobserved).status,'lost');
  t.mock.timers.reset();
  const missing=await runReuseDiscovery({query,timeoutMs:1000},{now,findExecutable:()=>{throw new Error('CLAUDE_NOT_INSTALLED');}});
  assert.equal(missing.status,'unavailable');assert.equal(missing.issue,'CLAUDE_NOT_INSTALLED');
});

test('reuse decisions show every candidate, and failure or no fit stays visible',()=>{
  const base={checkedAt:kstIso(now()),issue:null};
  const searched=reuseDecisions({...base,status:'searched',candidates:[candidate() as any,candidate({name:'polars',decision:'reject',reason:'Extra runtime'}) as any]});
  assert.equal(searched.length,2);assert.equal(searched[0].topic,'재사용: pandas');
  assert.match(searched[0].decision,/^재사용 채택: pandas 2\.2\.3 \(BSD-3-Clause\) · https:\/\/pandas\.pydata\.org\/ · 확인 2026-10-30T12:04:05\+09:00$/);
  assert.match(searched[1].decision,/^재사용 미채택: polars/);assert.equal(searched[1].rationale,'Extra runtime');
  assert.match(reuseDecisions({...base,status:'searched',candidates:[]})[0].decision,/적합 후보 없음 — 직접 구현/);
  const failed=reuseDecisions({...base,status:'timed_out',issue:'REUSE_TIMEOUT',candidates:[]});
  assert.equal(failed.length,1);assert.equal(failed[0].topic,'재사용 탐색');assert.match(failed[0].decision,/timed_out REUSE_TIMEOUT/);
});

test('Claude task prompt asks to report used reuse decisions only when the plan has them',()=>{
  const input={title:'t',goal:'g',baseline:{planningVersionId:'v',revision:1,contentHash:'c'.repeat(64)},acceptanceCriteria:['x'],constraints:[],nonGoals:[],deliverable:'out.md'};
  assert.doesNotMatch(claudeTaskPrompt({...input,decisions:[{decision:'Markdown',rationale:'r'}]}),/재사용 결정/);
  assert.match(claudeTaskPrompt({...input,decisions:[{decision:'재사용 채택: pandas 2.2.3',rationale:'r'}]}),/실제로 사용한 구성요소/);
});

function service(enabled:boolean){
  const dir=mkdtempSync(join(tmpdir(),'orbit-reuse-planning-')),store=new Store(join(dir,'state.sqlite'));
  const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects'));
  const {project}=projects.createProject({requestId:randomUUID(),name:'Research',kind:'general'});
  const planners:FakeClaudeRun[]=[],researchers:FakeClaudeRun[]=[],configs:any[]=[];
  const planning={findExecutable:()=>'/fake/claude',runnerFactory:(config:any)=>{configs.push(config);const r=new FakeClaudeRun();planners.push(r);return r;}};
  const reuse={enabled,now,findExecutable:()=>'/fake/claude',runnerFactory:(config:any)=>{configs.push(config);const r=new FakeClaudeRun();researchers.push(r);return r;}};
  const svc=new PlanningAgentService(store,projects,()=>{throw new Error('CODEX_FORBIDDEN');},()=>false,()=>{},undefined,planning,reuse);
  const text='PRIVATE_PLANNING_MARKER Write an evidence report';
  return {store,svc,project,planners,researchers,configs,text,
    start:()=>svc.start(project.id,{requestId:randomUUID(),text,expectedPreviewDigest:svc.preview(project.id,{text}).previewDigest,confirmed:true}),
    close:async()=>{await svc.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('enabled: reuse candidates merge into decisions, audit keeps only status, count and URLs, and the preview discloses it',async()=>{
  const off=service(false),on=service(true);
  try{
    assert.doesNotMatch(off.svc.preview(off.project.id,{text:off.text}).scope,/재사용 탐색/);
    assert.match(on.svc.preview(on.project.id,{text:on.text}).scope,/재사용 탐색.*WebSearch/);
    const started=on.start();await tick();on.planners[0].finish(outcome('completed',{response:planningInput.text}));
    await until(()=>on.researchers.length);
    assert.equal(on.configs[1].mode,'research');assert.doesNotMatch(on.researchers[0].prompt,/PRIVATE_PLANNING_MARKER|Local files only|Readable locally/);
    on.researchers[0].finish(outcome('completed',{response:response([candidate(),candidate({name:'polars',decision:'reject'})])}));await on.svc.settle();
    const record=on.svc.record(started.id);
    assert.equal(record.execution,'completed');assert.deepEqual(record.proposal!.decisions!.map(d=>d.topic),['Format','재사용: pandas','재사용: polars']);
    const event=on.store.eventsAfter(0).find(e=>e.kind==='planning_suggestion.reuse_discovery')!;
    assert.deepEqual(event.data,{suggestionId:started.id,projectId:on.project.id,status:'searched',issue:null,checkedAt:'2026-10-30T12:04:05+09:00',candidateCount:2,sources:['https://pandas.pydata.org/','https://pandas.pydata.org/'],merged:true});
    assert.ok(on.svc.saveDraft(on.project.id,started.id,{expectedOutputDigest:record.outputDigest!}).id);
  }finally{await off.close();await on.close();}
});

test('enabled: a discovery failure is a visible decision and the suggestion still completes',async()=>{
  const on=service(true);
  try{
    const started=on.start();await tick();on.planners[0].finish(outcome('completed',{response:planningInput.text}));
    await until(()=>on.researchers.length);
    on.researchers[0].finish(outcome('quota_exhausted'));await on.svc.settle();
    const record=on.svc.record(started.id),last=record.proposal!.decisions!.at(-1)!;
    assert.equal(record.execution,'completed');assert.equal(record.issue,null);assert.equal(record.proposal!.openQuestions.length,0);
    assert.equal(last.topic,'재사용 탐색');assert.match(last.decision,/unavailable QUOTA_EXHAUSTED/);
  }finally{await on.close();}
});

test('disabled: no research launch, unchanged decisions and an unchanged preview digest',async()=>{
  const off=service(false);
  try{
    const digestOff=off.svc.preview(off.project.id,{text:off.text}).previewDigest;
    const reuse=(off.svc as any).reuse;reuse.enabled=true;
    const digestOn=off.svc.preview(off.project.id,{text:off.text}).previewDigest;reuse.enabled=false;
    assert.notEqual(digestOff,digestOn,'enabling discovery makes old previews stale');
    assert.equal(off.svc.preview(off.project.id,{text:off.text}).previewDigest,digestOff);
    const started=off.start();await tick();off.planners[0].finish(outcome('completed',{response:planningInput.text}));await off.svc.settle();
    const record=off.svc.record(started.id);
    assert.equal(record.execution,'completed');assert.deepEqual(record.proposal!.decisions!.map(d=>d.topic),['Format']);
    assert.equal(off.researchers.length,0);assert.equal(off.store.eventsAfter(0).some(e=>e.kind==='planning_suggestion.reuse_discovery'),false);
  }finally{await off.close();}
});
