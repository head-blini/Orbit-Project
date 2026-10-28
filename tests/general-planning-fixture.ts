import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {Studio} from '../server/studio.ts';
import {FakeClaudeRun,outcome,planningInput,tick} from './claude-task-fixture.ts';
import type {ClaudePlanningOptions} from '../server/claude-planning.ts';

export function generalPlanningFixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-general-planning-')),database=join(dir,'state.sqlite');
  const store=new Store(database),managed=join(dir,'workspaces'),root=join(dir,'projects'),projects=new Projects(store,managed,[],root);
  const {project}=projects.createProject({requestId:randomUUID(),name:'Research',kind:'general'});
  const runners:FakeClaudeRun[]=[],launches:{cwd:string;mode:string}[]=[];
  let nativeCalls=0;
  const factory=()=>{nativeCalls++;throw new Error('CODEX_FORBIDDEN');};
  const options:ClaudePlanningOptions={findExecutable:()=>'/fake/claude',runnerFactory:config=>{launches.push(config);const runner=new FakeClaudeRun();runners.push(runner);return runner;}};
  const controller=new Controller(store,dir,factory,projects,[],[],{findExecutable:()=>{throw new Error('EXECUTION_FORBIDDEN');}},options);
  const service=controller.planningSuggestions,studio=new Studio(store),text='PRIVATE_PLANNING_MARKER Write an evidence report';
  const input=()=>({requestId:randomUUID(),text,expectedPreviewDigest:controller.previewPlanning(project.id,{text}).previewDigest,confirmed:true});
  return {dir,database,managed,root,store,projects,project,controller,service,studio,runners,launches,options,factory,text,input,get nativeCalls(){return nativeCalls;},
    complete:async()=>{await tick();runners.at(-1)!.finish(outcome('completed',{response:planningInput.text}));await service.settle();},
    close:async()=>{await tick();for(const runner of runners)runner.finish(outcome('interrupted'));await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
