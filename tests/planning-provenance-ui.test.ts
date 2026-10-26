import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';

test('missing predecessor tasks do not label an unchanged requirement as newly added',async()=>{
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(webRoot)&&url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  const store=new Store(':memory:');try{
    const {PlanningTaskProvenance}=await import('../web/studios.tsx'),studio=new Studio(store),projectId='project-a';
    store.saveProject({id:projectId,name:'Fixture',path:'never-accessed',createdAt:new Date().toISOString(),writeEnabled:false});
    const input={format:'markdown',source:'manual',text:'# Plan\n## Goal\nKeep evidence\n## Requirements\n### R1\nExisting requirement\n#### Acceptance criteria\n- Existing check\n## Constraints\n## Open questions\n'};
    const base=studio.mutate(projectId,'plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
    studio.mutate(projectId,'plans',base.id,'approve',{expectedRevision:1});
    const target=studio.mutate(projectId,'plans',base.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input}) as PlanningVersion;
    studio.mutate(projectId,'plans',target.id,'approve',{expectedRevision:2});
    const view=studio.comparePlanning(projectId,target.id,base.id);assert.equal(view.requirements[0].status,'unchanged');
    const tasks=studio.mutate(projectId,'plans',target.id,'replan',{requestId:randomUUID(),baseVersionId:base.id,expectedPreviewDigest:view.previewDigest,requirementLabels:['R1']}) as SavedTask[];
    assert.deepEqual(tasks[0].replannedFrom?.taskIds,[]);
    const html=renderToStaticMarkup(createElement(PlanningTaskProvenance,{tasks}));assert.match(html,/연결된 이전 Task 없음/);assert.doesNotMatch(html,/추가 요구사항에서 생성/);assert.equal(store.runs().length,0);
  }finally{hooks.deregister();store.close();}
});
