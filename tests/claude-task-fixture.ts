import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {Studio} from '../server/studio.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {ClaudeEvent,ClaudeOutcome} from '../server/runtimes/claude-code.ts';
import type {ClaudeTaskServiceOptions} from '../server/claude-task-service.ts';

export const planningInput={format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Research report',goal:'Compare local evidence',requirements:[{id:'REQ-1',description:'Write a report',acceptance_criteria:['Cite evidence']}],constraints:['Local files only'],non_goals:['Publish externally'],decisions:[{topic:'Format',decision:'Use Markdown',rationale:'Readable locally'}],open_questions:[]})};
export const outcome=(status:ClaudeOutcome['status'],extra:Partial<ClaudeOutcome>={}):ClaudeOutcome=>({status,sessionId:null,exit:'observed',exitCode:0,signal:null,forced:false,ignoredLines:0,response:'',...extra});
export class FakeClaudeRun {
  prompt='';onEvent:((event:ClaudeEvent)=>void)|null=null;interrupts=0;
  private resolve!:(result:ClaudeOutcome)=>void;
  result=new Promise<ClaudeOutcome>(resolve=>{this.resolve=resolve;});
  start(prompt:string,onEvent:(event:ClaudeEvent)=>void){this.prompt=prompt;this.onEvent=onEvent;return this.result;}
  interrupt():'requested'|'not_running'{this.interrupts++;return 'requested';}
  emit(event:ClaudeEvent){this.onEvent!(event);}
  finish(result:ClaudeOutcome=outcome('completed')){this.resolve(result);}
}
export const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
export const session:Extract<ClaudeEvent,{kind:'session'}>={kind:'session',sessionId:'11111111-2222-3333-4444-555555555555',model:'unused',permissionMode:'acceptEdits',auth:'subscription',tools:['Write']};

export function claudeFixture(options:ClaudeTaskServiceOptions={}){
  const dir=mkdtempSync(join(tmpdir(),'orbit-claude-task-')),db=join(dir,'state.sqlite'),managed=join(dir,'workspaces'),root=join(dir,'projects');
  const store=new Store(db),projects=new Projects(store,managed,[],root),studio=new Studio(store);
  const {project}=projects.createProject({requestId:randomUUID(),name:'Report',kind:'general'});
  const runners:FakeClaudeRun[]=[],launches:unknown[]=[];
  const dependencies:ClaudeTaskServiceOptions={findExecutable:()=>'/fake/claude',runnerFactory:config=>{
    const run=store.runs().at(-1)!;
    assert.equal(run.execution,'starting');assert.equal(run.runtime,'claude-code');assert.equal(run.projectId,project.id);
    assert.equal(config.cwd,project.path);assert.equal(config.mode,'write');assert.equal(config.executable,'/fake/claude');
    launches.push(config);const runner=new FakeClaudeRun();runners.push(runner);return runner;
  },...options};
  const controller=new Controller(store,dir,()=>{throw new Error('CODEX_FORBIDDEN');},projects,[],[],dependencies);
  function plan(input=planningInput){
    const version=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
    studio.mutate(project.id,'plans',version.id,'approve',{expectedRevision:1});
    const [task]=studio.mutate(project.id,'plans',version.id,'task-drafts',{}) as SavedTask[];
    return {version,task};
  }
  return {dir,db,managed,root,store,projects,project,studio,controller,runners,launches,plan,dependencies,
    close:async()=>{for(const runner of runners)runner.finish(outcome('interrupted'));await tick();await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
