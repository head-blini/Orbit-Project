import type {CodexModelAttribution} from './codex-model-attribution.ts';
import type {QualityLoopRecord} from './quality-loop-record.ts';
import type {Run,ProviderStatus} from './types.ts';
import {terminal} from './types.ts';
import type {SavedTask,PlanningVersion} from './parallel.ts';
import type {CheckRecord} from './verification.ts';
import type {CodexUsage} from './usage.ts';

/**
 * Project → Task → Run progress read model. Pure: it never starts, retries or
 * mutates anything. Every stage is derived from recorded runs/checks and
 * observed signals; a model response is never treated as verification.
 */
export type TaskStage='not_started'|'quota_wait'|'running'|'interrupt_requested'|'verifying'|'response_unverified'
  |'verification_failed'|'revalidation_required'|'verified'|'interrupted'|'error'|'lost';
export type ProgressVerification='not_run'|'running'|'passed'|'failed'|'stale'|'lost';
export type ConnectionFreshness='live'|'quiet'|'offline';
export interface ProgressSignals {provider?:ProviderStatus;quota?:'available'|'exhausted'|'unknown';recoveryRequired?:boolean}
export interface ProgressInput {
  projectId:string;tasks:readonly SavedTask[];runs:readonly Run[];checks:readonly CheckRecord[];
  plans:readonly PlanningVersion[];currentPlanIds:readonly string[];signals:ProgressSignals;
  /** Last recorded event per run and the latest observed tool name (never tool input). */
  activity?:Readonly<Record<string,{at:string;tool:string|null}>>;
}
export interface ProgressRun {
  modelAttribution?:CodexModelAttribution|null;
  id:string;assignee:string;execution:Run['execution'];startedAt:string;lastObservedAt:string;
  verification:ProgressVerification;checks:number;planningVersionId:string|null;lastActivity:string|null;
}
export interface ProgressTask {
  qualityLoops?:QualityLoopRecord[];
  id:string;title:string;requirementLabels:string[];stage:TaskStage;assignee:string|null;planCurrent:boolean;
  latestRunId:string|null;startedAt:string|null;lastObservedAt:string|null;verification:ProgressVerification;
  criteria:{total:number;verified:number};runs:ProgressRun[];runsTotal:number;
}
export interface ProgressBlocker {code:'RECOVERY_REQUIRED'|'LOGIN_REQUIRED'|'RUNTIME_NOT_INSTALLED'|'RUNTIME_ERROR'|'QUOTA_EXHAUSTED';scope:'project'}
export interface ProjectProgress {
  projectId:string;
  plan:{id:string;revision:number;state:PlanningVersion['state'];contentHash:string;title:string;goal:string}|null;
  totals:{tasks:number;verifiedTasks:number;basis:'tasks'};
  criteria:{total:number;verified:number;basis:'acceptance_criteria'};
  blockers:ProgressBlocker[];tasks:ProgressTask[];untaskedRuns:number;lastObservedAt:string|null;
}

/** Existing Run records are Codex App Server turns; other runtimes add their own label later. */
export const runAssignee=(run:Run)=>{const value=(run as Run&{runtime?:unknown}).runtime;return typeof value==='string'&&value?value:'codex';};
const latest=(a:string|null,b:string|null)=>!a?b:!b?a:a>=b?a:b;
const unique=<T extends {id:string}>(items:readonly T[])=>[...new Map(items.map(item=>[item.id,item])).values()];
const checkTime=(c:CheckRecord)=>c.completedAt??c.createdAt;
function checkState(c:CheckRecord|undefined):ProgressVerification{
  if(!c)return 'not_run';
  if(c.execution==='lost')return 'lost';
  if(c.execution==='running')return 'running';
  if(c.verdict==='passed')return 'passed';
  if(c.verdict==='stale')return 'stale';
  return ['failed','timed_out','interrupted'].includes(c.verdict)?'failed':'not_run';
}
function runStage(run:Run,verification:ProgressVerification):TaskStage{
  switch(run.execution){
    case 'starting':case 'running':return 'running';
    case 'interrupting':return 'interrupt_requested';
    case 'interrupted':return 'interrupted';
    case 'failed':return 'error';
    case 'lost':return 'lost';
  }
  return ({not_run:'response_unverified',running:'verifying',passed:'verified',failed:'verification_failed',stale:'revalidation_required',lost:'lost'} as const)[verification];
}

export function buildProjectProgress(input:ProgressInput):ProjectProgress{
  const tasks=unique(input.tasks.filter(task=>task.projectId===input.projectId)),taskIds=new Set(tasks.map(task=>task.id));
  const runs=unique(input.runs).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  const checksByRun=new Map<string,CheckRecord[]>();
  for(const c of unique(input.checks))if(c.projectId===input.projectId)checksByRun.set(c.runId,[...(checksByRun.get(c.runId)??[]),c]);
  for(const list of checksByRun.values())list.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  const current=new Set(input.currentPlanIds),signals=input.signals;
  let lastObservedAt:string|null=null;
  const progressTasks=tasks.map((task):ProgressTask=>{
    const own=runs.filter(run=>run.taskId===task.id),planCurrent=current.has(task.planningVersionId);
    const views=own.map((run):ProgressRun=>{
      const checks=checksByRun.get(run.id)??[],last=checks.at(-1);
      const activity=input.activity?.[run.id];
      const observed=checks.reduce<string>((at,c)=>latest(at,checkTime(c))!,latest(run.updatedAt,activity?.at??null)!);
      return {id:run.id,assignee:runAssignee(run),execution:run.execution,startedAt:run.createdAt,lastObservedAt:observed,verification:checkState(last),checks:checks.length,planningVersionId:run.planningVersionId??null,lastActivity:activity?.tool??null};
    });
    const head=own.at(-1),view=views.at(-1);
    let stage:TaskStage=head&&view?runStage(head,view.verification):signals.quota==='exhausted'?'quota_wait':'not_started';
    if(stage==='verified'&&!planCurrent)stage='revalidation_required';
    const lastCheck=head?checksByRun.get(head.id)?.at(-1):undefined;
    const bound=stage==='verified'&&!!head?.acceptanceDigest&&lastCheck?.acceptanceDigest===head.acceptanceDigest;
    const taskObserved=views.reduce<string|null>((at,v)=>latest(at,v.lastObservedAt),null);lastObservedAt=latest(lastObservedAt,taskObserved);
    return {id:task.id,title:task.title,requirementLabels:[...task.requirementLabels],stage,assignee:view?.assignee??null,planCurrent,
      latestRunId:head?.id??null,startedAt:views[0]?.startedAt??null,lastObservedAt:taskObserved,verification:view?.verification??'not_run',
      criteria:{total:task.acceptanceCriteria.length,verified:bound?task.acceptanceCriteria.length:0},runs:views.slice(-20).reverse(),runsTotal:views.length};
  });
  const blockers:ProgressBlocker[]=[];
  if(signals.recoveryRequired)blockers.push({code:'RECOVERY_REQUIRED',scope:'project'});
  if(signals.provider==='auth_required')blockers.push({code:'LOGIN_REQUIRED',scope:'project'});
  if(signals.provider==='not_installed')blockers.push({code:'RUNTIME_NOT_INSTALLED',scope:'project'});
  if(signals.provider==='error')blockers.push({code:'RUNTIME_ERROR',scope:'project'});
  if(signals.quota==='exhausted')blockers.push({code:'QUOTA_EXHAUSTED',scope:'project'});
  const plans=input.plans.filter(plan=>plan.projectId===input.projectId&&current.has(plan.id)&&plan.state==='approved');
  const plan=plans.sort((a,b)=>(a.approvedAt??a.createdAt??'').localeCompare(b.approvedAt??b.createdAt??'')).at(-1);
  return {projectId:input.projectId,
    plan:plan?{id:plan.id,revision:plan.revision,state:plan.state,contentHash:plan.contentHash,title:plan.draft.title,goal:plan.draft.goal}:null,
    totals:{tasks:progressTasks.length,verifiedTasks:progressTasks.filter(task=>task.stage==='verified').length,basis:'tasks'},
    criteria:{total:progressTasks.reduce((n,t)=>n+t.criteria.total,0),verified:progressTasks.reduce((n,t)=>n+t.criteria.verified,0),basis:'acceptance_criteria'},
    blockers,tasks:progressTasks,untaskedRuns:runs.filter(run=>!run.taskId||!taskIds.has(run.taskId)).length,lastObservedAt};
}

/** Live-event merge: an older or post-terminal update can never regress a recorded run. */
export function mergeRunUpdate(existing:Run|undefined,incoming:Run):Run{
  if(!existing)return incoming;
  if(terminal(existing.execution))return existing;
  return incoming.updatedAt<existing.updatedAt?existing:incoming;
}

/** Connection freshness only describes the event stream; it never changes recorded stages. */
export function connectionFreshness(input:{online:boolean;lastEventAt:string|null;now:number;quietAfterMs?:number}):ConnectionFreshness{
  if(!input.online)return 'offline';
  if(!input.lastEventAt)return 'quiet';
  return input.now-Date.parse(input.lastEventAt)<=(input.quietAfterMs??60_000)?'live':'quiet';
}

/** Quota wait is reported only from an observed exhausted window; missing data stays unknown. */
export function quotaSignal(usage:CodexUsage|null):NonNullable<ProgressSignals['quota']>{
  const windows=usage&&usage.status!=='unknown'?(usage.buckets??[]).flatMap(bucket=>[bucket.primary,bucket.secondary]).filter(window=>!!window):[];
  if(!windows.length)return 'unknown';
  return windows.some(window=>window.remainingPercent<=0)?'exhausted':'available';
}
