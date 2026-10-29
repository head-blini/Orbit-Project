import test from 'node:test';
import assert from 'node:assert/strict';
import type {ProjectProgress,ProgressTask,TaskStage} from '../shared/project-progress.ts';
import type {QualityLoopRecord,QualityModelEvidence,QualityStep} from '../shared/quality-loop-record.ts';
import type {QualityLoopResult} from '../shared/quality-loop.ts';
import {projectSteps,nextAction,qualitySteps,taskQuality,completionView,verifiedTaskCount} from '../web/project-work-model.ts';
import type {TaskCompletion,CompletionGate} from '../shared/task-completion.ts';
import type {QualityDimension,QualityProgress,QualityStatus} from '../shared/quality-progress.ts';

// QG-UI-01: the 교차 검증 / 수정·재검증 steps come only from recorded Quality Loops (mock fixtures, no model calls).
const native=(modelId:string|null,source:QualityModelEvidence['evidenceSource']|null='native'):QualityModelEvidence=>
  ({providerId:'anthropic',modelId,sessionId:'s',runId:'run-'+modelId,source:modelId?'native_observed':'unknown',...(source?{evidenceSource:source}:{})});
const step=(kind:QualityStep['kind'],evidence:QualityModelEvidence|null):QualityStep=>({id:kind+Math.random(),index:0,kind,state:'completed',requestDigest:'d',startedAt:'',finishedAt:'',issue:null,evidence,result:null});
function loop(result:Partial<QualityLoopResult>,options:{producer?:QualityModelEvidence;steps?:QualityStep[];verification?:'passed'|'failed'|'unknown';sourceRunId?:string;recoveryRequired?:boolean}={}):QualityLoopRecord{
  return {id:'loop-'+Math.random().toString(16).slice(2),requestId:'q',createdAt:'',updatedAt:'',projectId:'p',sourceRunId:options.sourceRunId??'run-1',taskId:'t',
    recoveryRequired:options.recoveryRequired??false,reviewers:[{id:'cross',providerId:'openai',modelId:'gpt-y'}],producer:options.producer??native('claude-x'),
    steps:options.steps??[step('review',{...native('gpt-y'),providerId:'openai'})],
    verification:{status:options.verification??'passed',checkIds:[],issue:null},
    result:{status:'passed',issue:null,calls:1,repairs:0,rounds:[],artifact:{id:'a',digest:'0'.repeat(64)},...result},
  } as unknown as QualityLoopRecord;
}
const task=(qualityLoops?:QualityLoopRecord[],over:Partial<ProgressTask>={}):ProgressTask=>({id:'t'+Math.random(),title:'보고서',requirementLabels:[],stage:'response_unverified' as TaskStage,assignee:null,planCurrent:true,
  latestRunId:'run-1',startedAt:null,lastObservedAt:null,verification:'not_run',criteria:{total:1,verified:0},runs:[],runsTotal:0,qualityLoops,...over});
const progress=(...tasks:ProgressTask[]):ProjectProgress=>({projectId:'p',plan:{id:'v',revision:1,state:'approved',contentHash:'a'.repeat(64),title:'T',goal:'G'},
  totals:{tasks:tasks.length,verifiedTasks:0,basis:'tasks'},criteria:{total:0,verified:0,basis:'acceptance_criteria'},blockers:[],tasks,untaskedRuns:0,lastObservedAt:null});
const steps=(value:ProjectProgress)=>{const [cross,fix]=qualitySteps(value,'general');return {cross,fix};};

test('normal native record passes both quality steps',()=>{
  const {cross,fix}=steps(progress(task([loop({})])));
  assert.equal(cross.state,'done');assert.equal(fix.state,'done');assert.match(fix.detail,/수정 불필요/);
  assert.equal(taskQuality(task([loop({repairs:2})])).reason,'수정 2회 후 재검증 통과');
});

test('missing quality records never show completion',()=>{
  const {cross,fix}=steps(progress(task(),task([])));
  assert.equal(cross.state,'pending');assert.match(cross.detail,/통과로 보지 않습니다/);assert.equal(fix.state,'pending');
  assert.equal(nextAction(progress(task()),2).target,'results','no quality record keeps the existing flow');
});

test('unknown or mock model identity is never a pass',()=>{
  for(const record of [loop({},{producer:native(null)}),loop({},{producer:native('claude-x',null)}),loop({},{steps:[step('review',null)]})]){
    const q=taskQuality(task([record]));assert.equal(q.phase,'unverified');assert.equal(q.origin,'unknown');
    assert.notEqual(steps(progress(task([record]))).cross.state,'done');
  }
  const mock=taskQuality(task([loop({},{producer:native('claude-x','mock')})]));
  assert.equal(mock.phase,'unverified');assert.equal(mock.origin,'mock');assert.match(mock.reason,/모의/);
  assert.equal(taskQuality(task([loop({},{verification:'unknown'})])).phase,'unverified','required checks must pass');
  assert.equal(nextAction(progress(task([loop({},{producer:native(null)})])),1).target,'tasks');
});

test('independent review blocked and recovery required are shown as blocked',()=>{
  const value=progress(task([loop({status:'blocked',issue:'INDEPENDENT_MODEL_REQUIRED'})]));
  const {cross}=steps(value);assert.equal(cross.state,'blocked');assert.match(cross.detail,/독립 검토 모델/);
  assert.equal(nextAction(value,3).text,'품질 검증 차단 원인을 확인하세요');
  assert.equal(taskQuality(task([loop({status:'reviewing'},{recoveryRequired:true})])).phase,'blocked');
});

test('review, fix, retest and failure are distinguished',()=>{
  assert.equal(taskQuality(task([loop({status:'reviewing'})])).phase,'review');
  assert.equal(taskQuality(task([loop({status:'repairing',repairs:0})])).phase,'fix');
  assert.equal(taskQuality(task([loop({status:'reviewing',repairs:1})])).phase,'retest');
  assert.deepEqual([steps(progress(task([loop({status:'reviewing'})]))).cross.state,steps(progress(task([loop({status:'reviewing'})]))).fix.state],['active','pending']);
  assert.match(steps(progress(task([loop({status:'repairing'})]))).fix.detail,/수정 중/);
  assert.match(steps(progress(task([loop({status:'reviewing',repairs:1})]))).fix.detail,/재검증 중/);
  const failed=progress(task([loop({status:'failed',rounds:[{number:1,artifact:{id:'a',digest:'0'},reviews:[],failures:[{reviewerId:'r',criterion:'c',evidence:'e',status:'not_met'}]}]})]));
  assert.equal(steps(failed).fix.state,'attention');assert.match(taskQuality(failed.tasks[0]).reason,/문제 1개/);
  assert.match(nextAction(failed,1).text,/실패 항목/);
  assert.equal(taskQuality(task([loop({status:'limit_reached'})])).phase,'failed');
});

test('a result from an older run or baseline is stale, not passed',()=>{
  for(const t of [task([loop({})],{latestRunId:'run-2'}),task([loop({})],{planCurrent:false}),task([loop({})],{stage:'revalidation_required'})]){
    assert.equal(taskQuality(t).phase,'stale');
    const {cross,fix}=steps(progress(t));assert.equal(cross.state,'attention');assert.equal(fix.state,'attention');
  }
  assert.equal(taskQuality(task([loop({status:'reviewing'})],{latestRunId:'run-2'})).phase,'review','an active loop still shows progress');
});

test('mixed tasks summarize without claiming completion; code projects keep their wording',()=>{
  const {cross}=steps(progress(task([loop({})]),task()));
  assert.equal(cross.state,'attention');assert.match(cross.detail,/통과 1 · 기록 없음 1/);
  assert.match(qualitySteps(null,'code')[1].detail,/검증 명령/);
  assert.match(qualitySteps(null,'general')[1].detail,/재검증/);
  const all=projectSteps(progress(task([loop({})])),1);
  assert.deepEqual(all.map(s=>s.id),['goal','plan','run','cross','fix','result']);
  assert.ok(all.find(s=>s.id==='cross')!.evidence![0].includes('실제 실행 관측'),'advanced evidence names the origin');
});

test('native origin alone is not proof of a completed independent review',()=>{
  const cases:[string,QualityLoopRecord][]=[
    ['no completed review',loop({},{steps:[]})],
    ['reviewer is the producer model',loop({},{steps:[step('review',native('claude-x'))]})],
    ['review observed as another model than selected',loop({},{steps:[step('review',{...native('gpt-z'),providerId:'openai'})]})],
    ['review reuses the producer run',loop({},{steps:[step('review',{...native('gpt-y'),providerId:'openai',runId:'run-claude-x'})]})],
  ];
  for(const [name,record] of cases){
    const q=taskQuality(task([record]));
    assert.equal(q.phase,'unverified',name);assert.match(q.reason,/독립 검토 완료 근거/,name);
    assert.notEqual(steps(progress(task([record]))).cross.state,'done',name);
  }
});

// QG-01 server dimensions (tasks[].quality) may only downgrade the UI verdict.
const dim=(status:QualityStatus,blockers:string[]=[]):QualityDimension=>({status,evidenceIds:[],blockers,nextAction:null});
const server=(over:Partial<QualityProgress>={}):QualityProgress=>({execution:dim('completed'),format:dim('not_run'),codeVerification:dim('not_run'),semantic:dim('passed'),
  independentReview:dim('completed'),repair:dim('not_run'),revalidation:dim('not_run'),userApproval:dim('not_run'),evidence:[],...over});

test('server quality dimensions confirm but never upgrade the UI verdict',()=>{
  assert.equal(taskQuality(task([loop({})],{quality:server()})).phase,'passed');
  assert.equal(taskQuality(task([loop({})])).phase,'passed','older servers without quality keep UI behaviour');
  const recorded=taskQuality(task([loop({})],{quality:server({semantic:dim('recorded',['QUALITY_EVIDENCE_SOURCE_UNKNOWN'])})}));
  assert.equal(recorded.phase,'unverified');assert.match(recorded.reason,/QUALITY_EVIDENCE_SOURCE_UNKNOWN/);
  assert.equal(taskQuality(task([loop({})],{quality:server({independentReview:dim('not_run')})})).phase,'unverified');
  assert.equal(taskQuality(task([loop({})],{quality:server({semantic:dim('stale')})})).phase,'stale');
  assert.equal(taskQuality(task([loop({repairs:1})],{quality:server({repair:dim('completed'),revalidation:dim('unknown')})})).phase,'unverified');
  assert.equal(taskQuality(task([loop({repairs:1})],{quality:server({repair:dim('completed'),revalidation:dim('passed')})})).phase,'passed');
  assert.equal(taskQuality(task([loop({},{producer:native('claude-x','mock')})],{quality:server()})).phase,'unverified','a server pass never lifts a mock record');
  assert.equal(taskQuality(task([],{quality:server()})).phase,'none','server dimensions alone are not a quality record');
  assert.equal(taskQuality(task([loop({status:'reviewing'})],{quality:server({semantic:dim('stale')})})).phase,'review','active loops stay visible');
});

// CQG-5: the server tasks[].completion verdict is the only authority for "완료".
const gate=(over:Partial<CompletionGate>={}):CompletionGate=>({id:'unit',status:'passed',evidenceIds:['e1'],source:'native',freshness:'current',blockers:[],...over});
const decision=(status:'passed'|'not_run'='not_run')=>({status,evidenceIds:[],source:'native' as const,freshness:'current' as const,blockers:[]});
const completion=(over:Partial<TaskCompletion>={}):TaskCompletion=>({binding:{} as TaskCompletion['binding'],policyDigest:'p',gates:[gate()],qualityPassed:true,
  independentReview:decision('passed'),userApproval:decision(),verifiedDone:true,reasonCodes:[],...over});

test('verifiedDone true is the only done: board count and label follow the server',()=>{
  const done=task([loop({})],{completion:completion()}),notDone=task([loop({})],{completion:completion({verifiedDone:false})});
  assert.equal(completionView(done)!.label,'완료(검증됨)');
  assert.equal(taskQuality(done).phase,'passed');assert.equal(steps(progress(done)).cross.state,'done');
  assert.equal(verifiedTaskCount({...progress(done,notDone),totals:{tasks:2,verifiedTasks:2,basis:'tasks'}}),1,'server completion overrides totals');
});

test('qualityPassed with release policy wait is labelled, not released, not done',()=>{
  const t=task([loop({})],{completion:completion({verifiedDone:false,reasonCodes:['CQG_DEPENDENCY_RELEASE_WAIT']})});
  const v=completionView(t)!;
  assert.equal(v.done,false);assert.notEqual(v.label,'완료(검증됨)');assert.match(v.gates,/통과/);assert.match(v.release,/의존 작업 해제 대기: 정책 wait/);
  assert.notEqual(steps(progress(t)).cross.state,'done','local pass cannot override server false');
  assert.match(completionView(task([],{completion:completion()}))!.release,/해제됨/);
});

test('mock, unknown and stale gates are visibly downgraded',()=>{
  const view=(g:Partial<CompletionGate>)=>completionView(task([loop({})],{completion:completion({verifiedDone:false,qualityPassed:false,gates:[gate(g)]})}))!;
  assert.match(view({source:'mock'}).label,/모의/);
  assert.match(view({source:'unknown'}).label,/모델 미확인/);
  const stale=view({freshness:'stale'});assert.match(stale.label,/재검증 필요/);
  const t=task([loop({})],{completion:completion({verifiedDone:false,qualityPassed:false,gates:[gate({freshness:'stale'})]})});
  assert.equal(taskQuality(t).phase,'stale');assert.match(nextAction(progress(t),1).text,/다시 실행/);
  const m=task([loop({})],{completion:completion({verifiedDone:false,qualityPassed:false,gates:[gate({source:'mock'})]})});
  assert.notEqual(steps(progress(m)).cross.state,'done');
});

test('absent completion keeps old behaviour and never shows 완료(검증됨)',()=>{
  const t=task([loop({})]);
  assert.equal(completionView(t),null);assert.equal(steps(progress(t)).cross.state,'done');
  assert.equal(verifiedTaskCount({...progress(t),totals:{tasks:1,verifiedTasks:1,basis:'tasks'}}),1);
});

test('review and approval are reported separately from quality gates',()=>{
  const v=completionView(task([],{completion:completion({verifiedDone:false,independentReview:decision('passed'),userApproval:decision('not_run')})}))!;
  assert.match(v.review,/독립 검토 통과/);assert.match(v.approval,/사용자 승인 미실행/);
});
