import test from 'node:test';
import assert from 'node:assert/strict';
import type {ProjectProgress,ProgressTask,TaskStage} from '../shared/project-progress.ts';
import {projectSteps,nextAction} from '../web/project-work-model.ts';
import {getUiMode,setUiMode,subscribeUiMode,advancedMenuKey} from '../web/ui-mode.ts';

// Home/project screen (2026-10-28): the six steps and the next action come only from recorded state,
// and cross-model verification / fixing never claim progress without a Quality Loop record (see quality-gate-ui.test.ts).
const task=(stage:TaskStage):ProgressTask=>({id:stage+Math.random(),title:'t',requirementLabels:[],stage,assignee:null,planCurrent:true,latestRunId:null,startedAt:null,lastObservedAt:null,verification:'not_run',criteria:{total:1,verified:0},runs:[],runsTotal:0});
const progress=(state:'draft'|'approved'|null,stages:TaskStage[]):ProjectProgress=>({projectId:'p',plan:state?{id:'v',revision:2,state,contentHash:'a'.repeat(64),title:'T',goal:'G'}:null,
  totals:{tasks:stages.length,verifiedTasks:0,basis:'tasks'},criteria:{total:0,verified:0,basis:'acceptance_criteria'},blockers:[],tasks:stages.map(task),untaskedRuns:0,lastObservedAt:null});

test('steps never claim cross verification or fixing without a quality record',()=>{
  for(const value of [null,progress(null,[]),progress('approved',['verified'])]){
    const steps=projectSteps(value,3);
    assert.deepEqual(steps.map(step=>step.id),['goal','plan','run','cross','fix','result']);
    assert.equal(steps.find(step=>step.id==='cross')!.state,'pending');
    assert.equal(steps.find(step=>step.id==='fix')!.state,'pending');
  }
});

test('run step is pending until something runs or responds, and counts responses not verification',()=>{
  assert.equal(projectSteps(progress('approved',['not_started','not_started']),0).find(s=>s.id==='run')!.state,'pending');
  const partial=projectSteps(progress('approved',['response_unverified','not_started']),1).find(s=>s.id==='run')!;
  assert.equal(partial.state,'active');assert.match(partial.detail,/2개 중 1개 응답 완료/);
  assert.equal(projectSteps(progress('approved',['running']),0).find(s=>s.id==='run')!.state,'active');
  assert.equal(projectSteps(progress('approved',['response_unverified']),1).find(s=>s.id==='run')!.state,'done');
  assert.equal(projectSteps(progress('draft',[]),0).find(s=>s.id==='plan')!.state,'active');
});

test('next action follows the recorded flow',()=>{
  assert.equal(nextAction(null,0).target,'followup');
  assert.equal(nextAction(progress('draft',[]),0).target,'plan');
  assert.equal(nextAction(progress('approved',[]),0).target,'plan');
  assert.equal(nextAction(progress('approved',['not_started']),0).target,'tasks');
  assert.equal(nextAction(progress('approved',['running','not_started']),0).text,'AI가 실행 중입니다. 작업 상태를 확인하세요');
  assert.equal(nextAction(progress('approved',['lost']),0).target,'tasks');
  assert.equal(nextAction(progress('approved',['response_unverified']),2).target,'results');
});

test('ui mode defaults to simple, persists, notifies and survives storage refusal',()=>{
  const values=new Map<string,string>(),previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v)}});
  try{
    assert.equal(getUiMode(),'simple');
    let calls=0;const stop=subscribeUiMode(()=>calls++);
    setUiMode('advanced');assert.equal(values.get(advancedMenuKey),'1');assert.equal(getUiMode(),'advanced');assert.equal(calls,1);
    stop();setUiMode('simple');assert.equal(calls,1);assert.equal(getUiMode(),'simple');
    Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}}});
    assert.doesNotThrow(()=>setUiMode('advanced'));assert.equal(getUiMode(),'advanced');
  }finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete (globalThis as any).localStorage;}
});
