import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProjectProgress,mergeRunUpdate,connectionFreshness,quotaSignal,type ProgressInput} from '../shared/project-progress.ts';
import type {CodexUsage} from '../shared/usage.ts';
import type {Run} from '../shared/types.ts';
import type {SavedTask,PlanningVersion} from '../shared/parallel.ts';
import type {CheckRecord} from '../shared/verification.ts';

const digest=(c:string)=>c.repeat(64);
const plan=(id:string,state:PlanningVersion['state']='approved'):PlanningVersion=>({id,projectId:'p',revision:1,contentHash:digest('a'),state,lineageId:'L',
  draft:{schemaVersion:'1.0',title:'Report',goal:'Write a market report',requirements:[],constraints:[],openQuestions:[],source:'manual'}});
const task=(id:string,criteria=2,version='v1'):SavedTask=>({id,projectId:'p',title:'Task '+id,description:'',acceptanceCriteria:Array.from({length:criteria},(_,i)=>'c'+i),
  planningVersionId:version,requirementLabels:['R1'],state:'draft',verification:'not_run',createdAt:'2026-10-28T00:00:00.000Z'});
const run=(id:string,taskId:string|undefined,execution:Run['execution'],updatedAt='2026-10-28T01:00:00.000Z',extra:Partial<Run>={}):Run=>({id,requestId:'r'+id,turnId:null,prompt:'',response:'',
  execution,verification:'not_run',createdAt:'2026-10-28T00:30:00.000Z',updatedAt,workspaceId:'w',taskId,planningVersionId:'v1',...extra});
const check=(id:string,runId:string,verdict:CheckRecord['verdict'],execution:CheckRecord['execution']='completed',extra:Partial<CheckRecord>={}):CheckRecord=>({id,requestId:'q'+id,runId,projectId:'p',workspaceId:'w',
  commandId:'node-test',configDigest:digest('c'),baseSha:'0'.repeat(40),sourceDigest:digest('s'),finishedDigest:null,createdAt:'2026-10-28T01:10:00.000Z',completedAt:'2026-10-28T01:11:00.000Z',
  execution,verdict,exitCode:verdict==='passed'?0:1,durationMs:5,output:'',recoveredAt:null,...extra});
const input=(over:Partial<ProgressInput>={}):ProgressInput=>({projectId:'p',tasks:[task('t1')],runs:[],checks:[],plans:[plan('v1')],currentPlanIds:['v1'],signals:{},...over});
const stage=(p:ReturnType<typeof buildProjectProgress>,id='t1')=>p.tasks.find(t=>t.id===id)!.stage;

test('model_done_is_not_verified: a completed response without a passing check is not complete',()=>{
  const progress=buildProjectProgress(input({runs:[run('r1','t1','completed')]}));
  assert.equal(stage(progress),'response_unverified');
  assert.equal(progress.totals.verifiedTasks,0);assert.equal(progress.criteria.verified,0);
  assert.equal(progress.tasks[0].verification,'not_run');
});

test('a passing check verifies the task but criteria count only when the acceptance baseline is bound',()=>{
  const unbound=buildProjectProgress(input({runs:[run('r1','t1','completed')],checks:[check('c1','r1','passed')]}));
  assert.equal(stage(unbound),'verified');assert.equal(unbound.totals.verifiedTasks,1);assert.equal(unbound.criteria.verified,0);assert.equal(unbound.criteria.total,2);
  const bound=buildProjectProgress(input({runs:[run('r1','t1','completed',undefined,{acceptanceDigest:digest('d')})],checks:[check('c1','r1','passed',undefined,{acceptanceDigest:digest('d')})]}));
  assert.equal(bound.criteria.verified,2);
  const mismatch=buildProjectProgress(input({runs:[run('r1','t1','completed',undefined,{acceptanceDigest:digest('d')})],checks:[check('c1','r1','passed',undefined,{acceptanceDigest:digest('e')})]}));
  assert.equal(mismatch.criteria.verified,0);
});

test('failed, running, stale and lost checks map to distinct stages',()=>{
  const at=(c:CheckRecord)=>stage(buildProjectProgress(input({runs:[run('r1','t1','completed')],checks:[c]})));
  assert.equal(at(check('c','r1','failed')),'verification_failed');
  assert.equal(at(check('c','r1','timed_out')),'verification_failed');
  assert.equal(at(check('c','r1','not_run','running',{completedAt:null})),'verifying');
  assert.equal(at(check('c','r1','stale')),'revalidation_required');
  assert.equal(at(check('c','r1','not_run','lost',{completedAt:null})),'lost');
});

test('the latest check decides the verdict, not the most favourable one',()=>{
  const progress=buildProjectProgress(input({runs:[run('r1','t1','completed')],checks:[check('c1','r1','passed'),check('c2','r1','failed',undefined,{createdAt:'2026-10-28T02:00:00.000Z',completedAt:'2026-10-28T02:01:00.000Z'})]}));
  assert.equal(stage(progress),'verification_failed');
});

test('duplicate_event_counted_once: repeated run and check records do not inflate counts',()=>{
  const r=run('r1','t1','completed'),c=check('c1','r1','passed');
  const progress=buildProjectProgress(input({runs:[r,r,{...r}],checks:[c,c]}));
  assert.equal(progress.tasks[0].runsTotal,1);assert.equal(progress.totals.verifiedTasks,1);assert.equal(progress.tasks[0].runs[0].checks,1);
});

test('late_event_cannot_regress_final_state',()=>{
  const done=run('r1','t1','completed','2026-10-28T02:00:00.000Z');
  assert.equal(mergeRunUpdate(done,run('r1','t1','running','2026-10-28T01:00:00.000Z')),done);
  assert.equal(mergeRunUpdate(done,run('r1','t1','running','2026-10-28T03:00:00.000Z')),done,'terminal never returns to active');
  const newer=run('r1','t1','failed','2026-10-28T03:00:00.000Z');
  assert.equal(mergeRunUpdate(run('r1','t1','running'),newer),newer);
  assert.equal(mergeRunUpdate(undefined,newer),newer);
});

test('lost, failed, interrupted and interrupting runs are never reported as running or complete',()=>{
  assert.equal(stage(buildProjectProgress(input({runs:[run('r1','t1','lost')]}))),'lost');
  assert.equal(stage(buildProjectProgress(input({runs:[run('r1','t1','failed')]}))),'error');
  assert.equal(stage(buildProjectProgress(input({runs:[run('r1','t1','interrupted')]}))),'interrupted');
  assert.equal(stage(buildProjectProgress(input({runs:[run('r1','t1','interrupting')]}))),'interrupt_requested');
  assert.equal(stage(buildProjectProgress(input({runs:[run('r1','t1','running')]}))),'running');
  assert.equal(stage(buildProjectProgress(input({runs:[]}))),'not_started');
});

test('the latest run of a task decides its stage and older runs stay in history',()=>{
  const progress=buildProjectProgress(input({runs:[run('r1','t1','completed'),run('r2','t1','running','2026-10-28T02:00:00.000Z',{createdAt:'2026-10-28T01:30:00.000Z'})],checks:[check('c1','r1','passed')]}));
  assert.equal(stage(progress),'running');assert.equal(progress.tasks[0].latestRunId,'r2');assert.equal(progress.tasks[0].runsTotal,2);
  assert.equal(progress.totals.verifiedTasks,0);
});

test('new_baseline_marks_only_affected_checks_stale: tasks on a superseded plan need revalidation',()=>{
  const progress=buildProjectProgress(input({tasks:[task('t1',2,'v1'),task('t2',1,'v2')],plans:[plan('v1','superseded'),plan('v2')],currentPlanIds:['v2'],
    runs:[run('r1','t1','completed'),run('r2','t2','completed',undefined,{planningVersionId:'v2'})],checks:[check('c1','r1','passed'),check('c2','r2','passed')]}));
  assert.equal(stage(progress,'t1'),'revalidation_required');assert.equal(progress.tasks.find(t=>t.id==='t1')!.planCurrent,false);
  assert.equal(stage(progress,'t2'),'verified');assert.equal(progress.totals.verifiedTasks,1);
  assert.equal(progress.plan?.id,'v2');
});

test('waiting reasons come from observed signals and only apply to tasks that are not yet running',()=>{
  const progress=buildProjectProgress(input({tasks:[task('t1'),task('t2')],runs:[run('r2','t2','running')],signals:{quota:'exhausted',provider:'auth_required',recoveryRequired:true}}));
  assert.equal(stage(progress,'t1'),'quota_wait');assert.equal(stage(progress,'t2'),'running');
  assert.deepEqual(progress.blockers.map(b=>b.code).sort(),['LOGIN_REQUIRED','QUOTA_EXHAUSTED','RECOVERY_REQUIRED']);
  const unknown=buildProjectProgress(input({signals:{quota:'unknown'}}));
  assert.equal(stage(unknown),'not_started');assert.deepEqual(unknown.blockers,[]);
});

test('runs without a task are counted separately and never attributed to a task',()=>{
  const progress=buildProjectProgress(input({runs:[run('free','t-missing','completed'),run('free2',undefined,'running')]}));
  assert.equal(progress.untaskedRuns,2);assert.equal(progress.tasks[0].runsTotal,0);
});

test('last observed time is the newest recorded run or check time, never invented',()=>{
  const empty=buildProjectProgress(input());assert.equal(empty.lastObservedAt,null);assert.equal(empty.tasks[0].lastObservedAt,null);
  const progress=buildProjectProgress(input({runs:[run('r1','t1','completed','2026-10-28T01:00:00.000Z')],checks:[check('c1','r1','passed')]}));
  assert.equal(progress.tasks[0].lastObservedAt,'2026-10-28T01:11:00.000Z');assert.equal(progress.lastObservedAt,'2026-10-28T01:11:00.000Z');
});

test('stale_connection_is_visible without changing recorded stages',()=>{
  const now=Date.parse('2026-10-28T01:00:00.000Z');
  assert.equal(connectionFreshness({online:false,lastEventAt:null,now}),'offline');
  assert.equal(connectionFreshness({online:true,lastEventAt:'2026-10-28T00:59:50.000Z',now}),'live');
  assert.equal(connectionFreshness({online:true,lastEventAt:'2026-10-28T00:50:00.000Z',now}),'quiet');
  assert.equal(connectionFreshness({online:true,lastEventAt:null,now}),'quiet');
});

test('get_progress_never_starts_run: building progress is pure and does not mutate input',()=>{
  const value=input({runs:[run('r1','t1','running')],checks:[check('c1','r1','passed')]}),before=JSON.stringify(value);
  buildProjectProgress(value);assert.equal(JSON.stringify(value),before);
});

test('project denominators come from the current plan tasks and are labelled by basis',()=>{
  const progress=buildProjectProgress(input({tasks:[task('t1',3),task('t2',1)]}));
  assert.equal(progress.totals.tasks,2);assert.equal(progress.totals.basis,'tasks');
  assert.equal(progress.criteria.total,4);assert.equal(progress.criteria.basis,'acceptance_criteria');
});

test('unknown_quota_stays_unknown: only an observed exhausted window becomes a quota wait',()=>{
  const usage=(status:CodexUsage['status'],remaining:number|null):CodexUsage=>({status,source:'codex_app_server',checkedAt:'2026-10-28T00:00:00.000Z',
    buckets:remaining===null?null:[{id:'codex',primary:{usedPercent:100-remaining,remainingPercent:remaining,windowDurationMins:300,resetsAt:null},secondary:null}],
    summary:null,daily:null,billing:'chatgpt_subscription',apiCostUsd:null});
  assert.equal(quotaSignal(null),'unknown');
  assert.equal(quotaSignal(usage('unknown',null)),'unknown');
  assert.equal(quotaSignal(usage('available',null)),'unknown');
  assert.equal(quotaSignal(usage('available',40)),'available');
  assert.equal(quotaSignal(usage('partial',0)),'exhausted');
});

test('observed activity events advance last observation and expose the latest tool name only',()=>{
  const progress=buildProjectProgress(input({runs:[run('r1','t1','running','2026-10-28T01:00:00.000Z')],
    activity:{r1:{at:'2026-10-28T01:07:00.000Z',tool:'Write'}}}));
  assert.equal(progress.tasks[0].lastObservedAt,'2026-10-28T01:07:00.000Z');assert.equal(progress.lastObservedAt,'2026-10-28T01:07:00.000Z');
  assert.equal(progress.tasks[0].runs[0].lastActivity,'Write');assert.equal(progress.tasks[0].stage,'running','activity never changes the recorded stage');
  const older=buildProjectProgress(input({runs:[run('r1','t1','completed','2026-10-28T02:00:00.000Z')],activity:{r1:{at:'2026-10-28T01:00:00.000Z',tool:null}}}));
  assert.equal(older.tasks[0].lastObservedAt,'2026-10-28T02:00:00.000Z');assert.equal(older.tasks[0].runs[0].lastActivity,null);
});
