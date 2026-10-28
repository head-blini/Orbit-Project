import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {FakeClaudeRun,outcome,planningInput} from './claude-task-fixture.ts';
const module=await import('../server/claude-planning.ts').catch(()=>null);
const input={workspacePath:'/planning-fixture',instructions:'PRIVATE_REQUEST',timeoutMs:1000};
function fixture(){
  assert.ok(module,'Claude planning runner required');
  const runner=new FakeClaudeRun();let calls=0;
  const options={findExecutable:()=>'/fake/claude',runnerFactory:(config:any)=>{calls++;assert.equal(config.mode,'read');assert.equal(config.cwd,input.workspacePath);assert.equal(config.spawn,undefined,'production wrapper must not bypass native authentication');assert.equal(typeof config.onOutputLine,'function');return runner;}};
  return {runner,options,get calls(){return calls;}};
}
test('Claude planning parses JSON v1 and Markdown with server-owned attribution in read mode',async()=>{
  for(const response of [planningInput.text,'# Report\n## Goal\nCompare evidence\n## Requirements\n### R1\nWrite report\n#### Acceptance criteria\n- Cite sources']){
    const f=fixture(),pending=module!.runClaudePlanning(input,f.options);
    f.runner.finish(outcome('completed',{response}));const result=await pending;
    assert.equal(result.execution,'completed');assert.equal(result.processStopped,true);assert.equal(result.proposal?.source,'import');
    assert.deepEqual(result.proposal?.provenance,{kind:'in_app_agent',providerId:'claude-code',externalUrl:null});assert.equal(f.calls,1);
  }
});
test('invalid or sensitive Claude output produces an issue and no proposal',async()=>{
  for(const response of ['not a plan','```json\n{}\n```','{"schema_version":"9"}','# Plan\n## Goal\nperson@example.invalid','x'.repeat(64001)]){
    const f=fixture(),pending=module!.runClaudePlanning(input,f.options);f.runner.finish(outcome('completed',{response}));
    const result=await pending;assert.equal(result.execution,'failed');assert.match(result.issue!,/^PLANNING_PROPOSAL_(INVALID|BLOCKED)$/);assert.equal(result.proposal,null);
  }
});
test('Claude login/quota outcomes and missing executable map to public issue codes',async()=>{
  for(const [status,issue] of [['auth_required','LOGIN_REQUIRED'],['quota_exhausted','QUOTA_EXHAUSTED']] as const){
    const f=fixture(),pending=module!.runClaudePlanning(input,f.options);f.runner.finish(outcome(status));
    const result=await pending;assert.equal(result.execution,'failed');assert.equal(result.issue,issue);assert.equal(result.proposal,null);
  }
  const result=await module!.runClaudePlanning(input,{findExecutable:()=>{throw new Error('CLAUDE_NOT_INSTALLED');}});
  assert.equal(result.issue,'CLAUDE_NOT_INSTALLED');assert.equal(result.processStopped,true);
});
test('known planning no-start authentication denial is failed with a stopped process, not quarantined',async()=>{
 const f=fixture(),pending=module!.runClaudePlanning(input,f.options);
 f.runner.finish(outcome('auth_required',{dispatch:'not_started',exit:'not_observed',issue:'AUTH_MODE_BLOCKED'}));
 const result=await pending;assert.equal(result.execution,'failed');assert.equal(result.processStopped,true);assert.equal(result.issue,'LOGIN_REQUIRED');
});
test('Claude interrupt remains pending until exit, and unobserved exit is lost',async()=>{
  const f=fixture(),controller=new AbortController();let settled=false;
  const pending=module!.runClaudePlanning({...input,signal:controller.signal},f.options).then(result=>{settled=true;return result;});
  controller.abort();await Promise.resolve();assert.equal(f.runner.interrupts,1);assert.equal(settled,false);
  f.runner.finish(outcome('interrupted'));assert.equal((await pending).execution,'interrupted');
  const g=fixture(),lost=module!.runClaudePlanning(input,g.options);g.runner.finish(outcome('completed',{response:planningInput.text,exit:'not_observed'}));
  assert.equal((await lost).execution,'lost');
});
test('Claude deadline requests interrupt and quarantines if exit never arrives',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),pending=module!.runClaudePlanning(input,f.options);
  t.mock.timers.tick(1000);assert.equal(f.runner.interrupts,1);t.mock.timers.tick(6000);
  const result=await pending;assert.equal(result.execution,'lost');assert.equal(result.processStopped,false);assert.equal(result.proposal,null);
});
test('Claude timeout with observed exit is timed_out; pre-abort never launches',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),pending=module!.runClaudePlanning(input,f.options);
  t.mock.timers.tick(1000);f.runner.finish(outcome('interrupted'));const result=await pending;
  assert.equal(result.execution,'timed_out');assert.equal(result.processStopped,true);
  const g=fixture();const stopped=await module!.runClaudePlanning({...input,signal:AbortSignal.abort()},g.options);
  assert.equal(stopped.execution,'interrupted');assert.equal(g.calls,0);
});
test('deadline during preflight retains timeout cause when no task process started',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),pending=module!.runClaudePlanning(input,f.options);
 t.mock.timers.tick(1000);f.runner.finish(outcome('interrupted',{dispatch:'not_started',exit:'not_observed'}));
 const result=await pending;assert.equal(result.execution,'timed_out');assert.equal(result.issue,'PLANNING_TIMEOUT');assert.equal(result.processStopped,true);
});

test('native Claude sanitization or truncation cannot turn altered output into a planning proposal',async()=>{
  for(const [response,issue] of [
    [JSON.stringify({...JSON.parse(planningInput.text),goal:'Use sk-synthetic-only-fixture to write the report'}),'PLANNING_PROPOSAL_BLOCKED'],
    ['# Report\n## Goal\n'+'word '.repeat(13000)+'\n## Requirements\n### R1\nReport\n#### Acceptance criteria\n- Cite evidence','PLANNING_PROPOSAL_INVALID'],
    [JSON.stringify({...JSON.parse(planningInput.text),goal:'Original output contains [REDACTED] text'}),'PLANNING_PROPOSAL_BLOCKED'],
    [planningInput.text,null],
  ] as const){
    const spawn=(_command:string,args:readonly string[])=>{
      assert.equal(args[args.indexOf('--tools')+1],'Read,Grep,Glob');assert.equal(args[args.indexOf('--permission-mode')+1],'plan');
      const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill:()=>true});
      queueMicrotask(()=>{
        const lines=JSON.stringify({type:'assistant',message:{content:[{type:'text',text:response}]}})+'\n'+JSON.stringify({type:'result',is_error:false})+'\n';
        child.stdout.emit('data',lines.slice(0,37));child.stdout.emit('data',lines.slice(37));child.emit('close',0,null);
      });return child as unknown as ChildProcess;
    };
    assert.ok(module);const result=await module.runClaudePlanning(input,{findExecutable:()=>'/fake/claude',spawn});
    assert.equal(result.issue,issue);assert.equal(result.execution,issue?'failed':'completed');if(issue)assert.equal(result.proposal,null);
  }
});
test('Claude planning asks for non-goals separately and keeps them as nonGoals in the draft',async()=>{
  const {buildClaudePlanningPrompt,parseClaudePlanningProposal,planningOutputSchema}=await import('../server/planning/agent-input.ts');
  const prompt=buildClaudePlanningPrompt('시장 조사 보고서').instructions;
  assert.match(prompt,/non_goals/);assert.match(prompt,/"non_goals"/,'the Claude schema lists non_goals');
  assert.equal((planningOutputSchema.required as readonly string[]).includes('non_goals'),false,'the Codex strict schema is unchanged until verified live');
  const draft=parseClaudePlanningProposal(JSON.stringify({schema_version:'1.0',title:'Report',goal:'Compare',requirements:[{id:'R1',description:'Write',acceptance_criteria:['Done']}],
    constraints:['Local files only'],non_goals:['No new data collection'],open_questions:[],decisions:[{topic:'Scope',decision:'Use existing files',rationale:'No web tools'}]}));
  assert.deepEqual(draft.nonGoals,['No new data collection']);assert.deepEqual(draft.constraints,['Local files only']);
});
test('oversized native output cannot promote an earlier valid proposal after line or buffer truncation',async()=>{
 for(const split of [false,true]){
  const spawn=()=>{
   const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill:()=>true});
   queueMicrotask(()=>{
    child.stdout.emit('data',JSON.stringify({type:'assistant',message:{content:[{type:'text',text:planningInput.text}]}})+'\n');
    const oversized=JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'x'.repeat(4*1024*1024+1)}]}});
    child.stdout.emit('data',oversized+(split?'':'\n'));if(split)child.stdout.emit('data','\n');
    child.stdout.emit('data',JSON.stringify({type:'result',is_error:false})+'\n');child.emit('close',0,null);
   });return child as unknown as ChildProcess;
  };
  const result=await module!.runClaudePlanning(input,{findExecutable:()=>'/fake/claude',spawn});
  assert.equal(result.execution,'failed');assert.equal(result.issue,'PLANNING_PROPOSAL_INVALID');assert.equal(result.proposal,null);
 }
});
