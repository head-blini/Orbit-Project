import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,renameSync,symlinkSync,rmSync} from 'node:fs';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {AppError} from '../server/errors.ts';
import type {ClaudeEvent} from '../server/runtimes/claude-code.ts';
import {parseClaudeLine} from '../server/runtimes/claude-code.ts';
import {claudeFixture,planningInput,outcome,session,tick} from './claude-task-fixture.ts';

const error=(message:string,status=409)=>(e:unknown)=>e instanceof AppError&&e.message===message&&e.status===status;

test('general task persists the approved Claude prompt before launch and reuses requestId without a second owner',async()=>{
  const f=claudeFixture();try{
    const {version,task}=f.plan(),requestId=randomUUID();
    const submit=()=>f.controller.submitTask(f.project.id,task.id,{requestId});
    const [run,replay]=await Promise.all([submit(),submit()]);
    assert.equal(run.id,replay.id);assert.equal(run.runtime,'claude-code');assert.equal(run.projectId,f.project.id);
    assert.equal(run.taskId,task.id);assert.equal(run.planningVersionId,version.id);assert.equal(run.planningContentHash,version.contentHash);
    assert.equal(run.workspaceId,undefined);assert.equal(run.execution,'starting');assert.equal(run.verification,'not_run');
    assert.equal(run.prompt,f.runners[0].prompt);
    for(const text of ['Write a report','Compare local evidence','Cite evidence','Local files only','Publish externally','Use Markdown','Readable locally',`task-${task.id.slice(0,8)}.md`,version.id,version.contentHash.slice(0,12)])assert.ok(run.prompt.includes(text),text);
    await assert.rejects(f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error('RUN_ACTIVE'));
    await assert.rejects(f.controller.submitTask(f.project.id,randomUUID(),{requestId}),error('IDEMPOTENCY_CONFLICT'));
    assert.equal(f.launches.length,1);assert.equal(f.store.runs().length,1);
    f.studio.mutate(f.project.id,'plans',version.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:planningInput});
    assert.equal((await submit()).id,run.id);
    f.runners[0].finish();await tick();
    assert.equal(f.store.getRun(run.id)?.execution,'completed');assert.equal(f.store.getRun(run.id)?.verification,'not_run');
  }finally{await f.close();}
});

test('stale and unapproved baselines are rejected before launch or Run creation',async()=>{
  for(const state of ['stale','draft'] as const){
    const f=claudeFixture();try{
      const {version,task}=f.plan();
      if(state==='stale')f.studio.mutate(f.project.id,'plans',version.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:planningInput});
      else f.store.db.prepare("UPDATE planning_versions SET body=json_set(body,'$.state','draft') WHERE id=?").run(version.id);
      await assert.rejects(f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error(state==='stale'?'PLANNING_VERSION_STALE':'NOT_APPROVED',state==='stale'?409:422));
      assert.equal(f.store.runs().length,0);assert.equal(f.launches.length,0);
    }finally{await f.close();}
  }
});

test('Claude events project session, tool and quota only; the last sanitized message is capped outside events',async()=>{
  const f=claudeFixture();try{
    // A credential in the plan itself is now refused before launch (Codex-equivalent gate, tested below);
    // here the secret only appears in model output and tool input, which must never reach events.
    const secret='sk-abcdefghijklmnop0123456789';
    const {task}=f.plan(),run=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),runner=f.runners[0];
    runner.emit(session);
    for(const event of parseClaudeLine(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Write',input:{prompt:secret}},{type:'text',text:`Result ${secret}`}]}}))!)runner.emit(event);
    assert.doesNotMatch(f.store.getRun(run.id)!.response,new RegExp(secret));
    runner.emit({kind:'message',text:'last '+ 'x'.repeat(70000)});
    const quota:Extract<ClaudeEvent,{kind:'quota'}>={kind:'quota',status:'rejected',windows:[{id:'five_hour',utilization:1,resetsAt:null,status:'rejected'}]};
    runner.emit(quota);assert.deepEqual(f.controller.claudeQuota(),quota);
    const copy=f.controller.claudeQuota()!;copy.windows.length=0;assert.equal(f.controller.claudeQuota()!.windows.length,1);
    runner.finish(outcome('quota_exhausted',{response:'outcome response is not the last message'}));await tick();
    const saved=f.store.getRun(run.id)!;assert.equal(saved.execution,'failed');assert.equal(saved.response,'last '+ 'x'.repeat(63995));assert.doesNotMatch(saved.prompt,new RegExp(secret));
    const events=f.store.eventsAfter(0).filter(e=>e.runId===run.id),raw=JSON.stringify(events);
    for(const text of [secret,'Write a report','Compare local evidence','"prompt"','"response"','"input"'])assert.equal(raw.includes(text),false,text);
    assert.deepEqual(events.find(e=>e.kind==='run.started')!.data,{sessionId:session.sessionId});
    assert.deepEqual(events.find(e=>e.kind==='claude.tool')!.data,{name:'Write'});
    assert.deepEqual(events.find(e=>e.kind==='claude.quota')!.data,{status:quota.status,windows:quota.windows});
    assert.equal(events.find(e=>e.kind==='run.failed')!.data.reason,'QUOTA_EXHAUSTED');assert.equal(f.launches.length,1);
  }finally{await f.close();}
});

test('interrupt is recorded immediately, remains interrupting through late session/message events, and completes only on exit',async()=>{
  const f=claudeFixture();try{
    const {task}=f.plan(),run=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),runner=f.runners[0];
    await f.controller.interrupt(run.id);await f.controller.interrupt(run.id);
    assert.equal(f.store.getRun(run.id)!.execution,'interrupting');assert.equal(runner.interrupts,1);
    assert.ok(f.store.eventsAfter(0).some(e=>e.runId===run.id&&e.kind==='run.interrupting'));
    assert.equal(f.store.eventsAfter(0).some(e=>e.kind==='run.interrupted'),false);
    runner.emit(session);runner.emit({kind:'message',text:'partial'});assert.equal(f.store.getRun(run.id)!.execution,'interrupting');
    runner.finish(outcome('interrupted'));await tick();assert.equal(f.store.getRun(run.id)!.execution,'interrupted');
    const seq=f.store.lastSeq();runner.emit(session);runner.emit({kind:'message',text:'too late'});assert.equal(f.store.lastSeq(),seq);
    assert.equal(f.store.getRun(run.id)!.response,'partial');
  }finally{await f.close();}
});

for(const [status,extra,execution,reason] of [
  ['unknown',{},'lost','RESULT_NOT_OBSERVED'],['completed',{exit:'not_observed'},'lost','EXIT_NOT_OBSERVED'],
  ['spawn_failed',{exit:'not_observed'},'failed','RUNTIME_NOT_STARTED'],['auth_required',{},'failed','LOGIN_REQUIRED'],['error',{},'failed','RUNTIME_ERROR'],
] as const)test(`Claude outcome ${status}/${extra.exit??'observed'} preserves ${execution} and ${reason}`,async()=>{
  const f=claudeFixture();try{
    const {task}=f.plan(),requestId=randomUUID(),run=await f.controller.submitTask(f.project.id,task.id,{requestId});
    f.runners[0].finish(outcome(status,extra));await tick();assert.equal(f.store.getRun(run.id)!.execution,execution);
    assert.equal(f.store.eventsAfter(0).find(e=>e.runId===run.id&&e.kind==='run.'+execution)!.data.reason,reason);
    if(execution==='lost'){
      assert.equal((await f.controller.submitTask(f.project.id,task.id,{requestId})).id,run.id);
      await assert.rejects(f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error('SOLO_RECOVERY_REQUIRED'));
    }
    assert.equal(f.launches.length,1);
  }finally{await f.close();}
});

for(const state of ['starting','running'] as const)test(`restart quarantines a ${state} Claude run and blocks a new owner for that task`,async()=>{
  const f=claudeFixture(),{task}=f.plan(),requestId=randomUUID();
  const run=await f.controller.submitTask(f.project.id,task.id,{requestId});if(state==='running')f.runners[0].emit(session);
  assert.equal(f.store.getRun(run.id)!.execution,state);
  // Simulate process loss: no graceful Controller.close and no runner exit.
  f.store.close();const store=new Store(f.db),projects=new Projects(store,f.managed,[],f.root);
  const controller=new Controller(store,f.dir,()=>{throw new Error('CODEX_FORBIDDEN');},projects,[],[],{findExecutable:()=>{throw new Error('NO_RETRY');},runnerFactory:()=>{throw new Error('NO_RETRY');}});
  try{
    assert.equal(store.getRun(run.id)!.execution,'lost');assert.equal(store.getRun(run.id)!.runtime,'claude-code');
    assert.equal((await controller.submitTask(f.project.id,task.id,{requestId})).id,run.id);
    await assert.rejects(controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error('SOLO_RECOVERY_REQUIRED'));
    assert.equal(store.runs().length,1);assert.equal(JSON.stringify(store.eventsAfter(0).filter(e=>e.runId===run.id)).includes('"prompt"'),false);
  }finally{await controller.close();store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('missing executable, invalid request and persistence failure never launch a Claude process',async()=>{
  const f=claudeFixture({findExecutable:()=>{throw new AppError('CLAUDE_NOT_INSTALLED',503);}});try{
    const {task}=f.plan();
    await assert.rejects(f.controller.submitTask(f.project.id,task.id,{requestId:'bad_id'}),error('INVALID_REQUEST_ID',400));
    await assert.rejects(f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error('CLAUDE_NOT_INSTALLED',503));
    assert.equal(f.store.runs().length,0);assert.equal(f.launches.length,0);
  }finally{await f.close();}
  const g=claudeFixture();try{
    const {task}=g.plan();g.store.db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    await assert.rejects(g.controller.submitTask(g.project.id,task.id,{requestId:randomUUID()}),/fixture/);
    assert.equal(g.store.runs().length,0);assert.equal(g.launches.length,0);
  }finally{await g.close();}
});

test('general dispatch rejects directory/root/link substitution and unreceipted allowlisted paths',async()=>{
  for(const target of ['project','root','link','record','unreceipted'] as const){
    const f=claudeFixture();try{
      const {task}=f.plan(),path=target==='root'?f.root:f.project.path;
      if(target==='unreceipted')f.store.db.exec('DELETE FROM project_creation_receipts');
      else if(target==='record')f.store.db.prepare("UPDATE projects SET body=json_set(body,'$.path',?) WHERE id=?").run(f.dir,f.project.id);
      else{renameSync(path,path+'-old');if(target==='link')symlinkSync(path+'-old',path,'junction');else mkdirSync(path);}
      await assert.rejects(f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error('PROJECT_CREATION_UNAVAILABLE'));
      assert.equal(f.store.runs().length,0);assert.equal(f.launches.length,0);
    }finally{await f.close();}
  }
});

test('a rejected runner start is uncertain and cannot authorize a retry or leak diagnostics',async()=>{
  const f=claudeFixture({runnerFactory:()=>({start:()=>Promise.reject(new Error('PRIVATE_DIAGNOSTIC')),interrupt:()=> 'not_running'})});
  try{
    const {task}=f.plan(),run=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});await tick();
    assert.equal(f.store.getRun(run.id)!.execution,'lost');
    await assert.rejects(f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error('SOLO_RECOVERY_REQUIRED'));
    assert.equal(JSON.stringify(f.store.eventsAfter(0)).includes('PRIVATE_DIAGNOSTIC'),false);
  }finally{await f.close();}
});

test('failed terminal persistence keeps the durable intent blocking another owner',async()=>{
  const f=claudeFixture();try{
    const {task}=f.plan(),run=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});
    f.runners[0].emit(session);
    f.store.db.exec("CREATE TRIGGER fail_terminal BEFORE INSERT ON events WHEN NEW.kind='run.completed' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    f.runners[0].finish();await tick();assert.equal(f.store.getRun(run.id)!.execution,'running');
    await assert.rejects(f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error('RUN_ACTIVE'));
    assert.equal(f.runners.length,1);assert.equal(f.store.eventsAfter(0).some(e=>e.kind==='run.completed'),false);
    await f.controller.interrupt(run.id);assert.equal(f.store.getRun(run.id)!.execution,'lost');
  }finally{await f.close();}
});

test('graceful close requests interruption, waits for exit and does not let Codex cleanup claim Claude loss',async()=>{
  const f=claudeFixture();try{
    const {task}=f.plan(),run=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});
    let closed=false;const pending=f.controller.close().then(()=>{closed=true;});await tick();
    assert.equal(closed,false);assert.equal(f.store.getRun(run.id)!.execution,'interrupting');
    f.runners[0].finish(outcome('interrupted'));await pending;
    assert.equal(f.store.getRun(run.id)!.execution,'interrupted');assert.equal(f.store.eventsAfter(0).some(e=>e.kind==='run.lost'),false);
    await assert.rejects(f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error('SESSION_BUSY'));
  }finally{await f.close();}
});

test('Claude loss quarantines only its task while the legacy Codex recovery barrier remains intact',async()=>{
  const f=claudeFixture();try{
    const {task}=f.plan(),run=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});
    f.runners[0].finish(outcome('unknown'));await tick();assert.equal(f.store.getRun(run.id)!.execution,'lost');
    assert.doesNotThrow(()=>f.controller.assertExecutionAvailable());
    assert.equal(f.controller.snapshot().soloRecoveryRequired,false);
    await assert.rejects(f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error('SOLO_RECOVERY_REQUIRED'));
    const other=f.plan();const second=await f.controller.submitTask(f.project.id,other.task.id,{requestId:randomUUID()});
    assert.equal(second.execution,'starting');assert.equal(f.runners.length,2);
    const legacy=f.store.createRun(randomUUID(),'fixture','legacy');f.store.updateRun(legacy.id,{execution:'lost'},'run.lost');
    assert.throws(()=>f.controller.assertExecutionAvailable(),error('SOLO_RECOVERY_REQUIRED'));
    assert.equal(f.controller.snapshot().soloRecoveryRequired,true);
  }finally{await f.close();}
});

test('shutdown still signals Claude when recording the interrupt request fails, without inventing exit',async()=>{
  const f=claudeFixture();try{
    const {task}=f.plan(),run=await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});
    f.store.db.exec("CREATE TRIGGER fail_interrupt BEFORE INSERT ON events WHEN NEW.kind='run.interrupting' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    let closed=false;const pending=f.controller.close().then(()=>{closed=true;});await tick();
    assert.equal(f.runners[0].interrupts,1);assert.equal(closed,false);assert.equal(f.store.getRun(run.id)!.execution,'starting');
    f.runners[0].finish(outcome('interrupted'));await pending;
    assert.equal(f.store.getRun(run.id)!.execution,'interrupted');assert.equal(f.store.eventsAfter(0).some(e=>e.kind==='run.interrupting'),false);
  }finally{await f.close();}
});
test('one active Claude run per general project: another task in the same folder waits',async()=>{
  const f=claudeFixture();try{
    const first=f.plan(),second=f.plan();
    const run=await f.controller.submitTask(f.project.id,first.task.id,{requestId:randomUUID()});
    await assert.rejects(f.controller.submitTask(f.project.id,second.task.id,{requestId:randomUUID()}),error('RUN_ACTIVE'));
    assert.equal(f.launches.length,1);
    f.runners[0].finish();await tick();assert.equal(f.store.getRun(run.id)?.execution,'completed');
    await f.controller.submitTask(f.project.id,second.task.id,{requestId:randomUUID()});assert.equal(f.launches.length,2);
  }finally{await f.close();}
});
test('Claude task prompts face the same credential and personal-data blocks as Codex runs',async()=>{
  for(const [goal,code] of [['연락처 010-1234-5678로 보낸다','PERSONAL_DATA_BLOCKED'],['키 sk-abcdefghijklmnopqrstuvwx 사용','CREDENTIAL_LIKE_INPUT']] as const){
    const f=claudeFixture();try{
      const input={format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Report',goal,requirements:[{id:'REQ-1',description:'Write',acceptance_criteria:['Done']}],constraints:[],open_questions:[]})};
      const version=f.studio.mutate(f.project.id,'plans',undefined,undefined,{requestId:randomUUID(),input}) as any;
      f.studio.mutate(f.project.id,'plans',version.id,'approve',{expectedRevision:1});
      const [task]=f.studio.mutate(f.project.id,'plans',version.id,'task-drafts',{}) as any[];
      const seq=f.store.lastSeq();
      await assert.rejects(f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()}),error(code,400));
      assert.equal(f.launches.length,0);assert.equal(f.store.runs().length,0);
      assert.deepEqual(f.store.eventsAfter(seq).map(e=>[e.kind,e.data.providerId,e.data.code]),[['guardrail.denied','claude-code',code]]);
    }catch(e){if(String(e).includes('INVALID')||String(e).includes('PLANNING'))throw new Error('fixture plan rejected: '+String(e));throw e;}finally{await f.close();}
  }
});
test('task dispatch follows the stored execution preference and never silently swaps runtimes',async()=>{
  const f=claudeFixture();try{
    const {task}=f.plan();
    assert.equal(f.controller.aiPreferences.read(f.project.id).execution,'claude-code');
    await f.controller.submitTask(f.project.id,task.id,{requestId:randomUUID()});
    assert.equal(f.store.runs()[0].runtime,f.controller.aiPreferences.read(f.project.id).execution);
  }finally{await f.close();}
});
