import {createHash} from 'node:crypto';
import type {DevelopmentResultView} from '../shared/development-results.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {Run} from '../shared/types.ts';
import {terminal} from '../shared/types.ts';
import type {CheckRecord} from '../shared/verification.ts';
import type {Store} from './store.ts';
import type {Projects} from './projects.ts';
import type {VerificationService} from './verification-service.ts';
import {AppError} from './errors.ts';

const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sourceIssue='FINGERPRINT_UNAVAILABLE';
const unavailable=():NonNullable<DevelopmentResultView['verification']>=>({available:false,canApprove:false,approvalCurrent:false,quarantined:false,scope:'현재 검증 정보를 확인할 수 없습니다. 과거 기록은 현재 소스의 통과 증거가 아닙니다.',commands:[],checks:[]});
function projectCheck(check:CheckRecord):Omit<CheckRecord,'requestId'|'output'>{
  return {id:check.id,runId:check.runId,projectId:check.projectId,workspaceId:check.workspaceId,commandId:check.commandId,configDigest:check.configDigest,
    baseSha:check.baseSha,sourceDigest:check.sourceDigest,finishedDigest:check.finishedDigest,createdAt:check.createdAt,completedAt:check.completedAt,
    execution:check.execution,verdict:check.verdict,exitCode:check.exitCode,durationMs:check.durationMs,recoveredAt:check.recoveredAt,...(check.acceptanceDigest?{acceptanceDigest:check.acceptanceDigest}:{})};
}
/** Historical association only: reading an old result must not call Studio.execution(). */
function link(store:Store,projectId:string,run:Run):Pick<DevelopmentResultView,'task'|'planning'|'linkIssue'>{
  const empty={task:null,planning:null,linkIssue:null};
  if(!run.taskId&&!run.planningVersionId)return empty;
  try{
    if(!run.taskId||!run.planningVersionId)throw new Error();
    const tasks=store.db.prepare('SELECT body FROM planning_tasks WHERE project_id=? AND version_id=?').get(projectId,run.planningVersionId);
    const task=(tasks?JSON.parse(String(tasks.body)):[]) as SavedTask[];
    const selected=task.find(value=>value.id===run.taskId);
    const row=store.db.prepare('SELECT id,project_id,lineage_id,body FROM planning_versions WHERE id=? AND project_id=?').get(run.planningVersionId,projectId);
    if(!selected||!row)throw new Error();const plan=JSON.parse(String(row.body)) as PlanningVersion;
    if(selected.projectId!==projectId||selected.planningVersionId!==run.planningVersionId||plan.id!==row.id||plan.projectId!==row.project_id||plan.lineageId!==row.lineage_id
      ||!digest(plan.contentHash)||createHash('sha256').update(JSON.stringify(plan.draft)).digest('hex')!==plan.contentHash
      ||typeof selected.title!=='string'||!Array.isArray(selected.requirementLabels)||!selected.requirementLabels.every(label=>typeof label==='string'&&plan.draft.requirements.some(requirement=>requirement.label===label)))throw new Error();
    const head=store.db.prepare('SELECT version_id FROM planning_heads WHERE lineage_id=?').get(plan.lineageId??plan.id);
    return {task:{id:selected.id,title:selected.title,requirementLabels:[...selected.requirementLabels]},
      planning:{id:plan.id,title:plan.draft.title,revision:plan.revision,contentHash:plan.contentHash,state:plan.state,current:head?.version_id===plan.id&&plan.state==='approved'},linkIssue:null};
  }catch{return {task:null,planning:null,linkIssue:'TASK_LINK_UNAVAILABLE'};}
}

/** Metadata-only observation. No dispatch, approval mutation or acceptance decision. */
export function getDevelopmentResult(store:Store,projects:Projects,verification:VerificationService,workspaceId:string,runId:string|null):DevelopmentResultView{
  const workspace=store.workspaces().find(value=>value.id===workspaceId);
  if(!workspace)throw new AppError('WORKSPACE_NOT_FOUND',404);
  if(!store.projects().some(project=>project.id===workspace.projectId))throw new AppError('PROJECT_NOT_FOUND',404);
  const run=runId===null?null:store.getRun(runId);
  if(runId!==null&&(!run||run.workspaceId!==workspaceId))throw new AppError('RUN_NOT_FOUND',404);
  const readSource=()=>{try{const value=projects.fingerprint(workspaceId);return digest(value)?value:null;}catch{return null;}};
  const initial=readSource();
  const result:DevelopmentResultView={projectId:workspace.projectId,workspaceId,observedAt:new Date().toISOString(),sourceDigest:initial,sourceIssue:initial===null?sourceIssue:null,
    run:run?{id:run.id,execution:run.execution,createdAt:run.createdAt,updatedAt:run.updatedAt}:null,
    ...(run?link(store,workspace.projectId,run):{task:null,planning:null,linkIssue:null}),verification:null};
  if(run&&terminal(run.execution)){
    try{
      const view=verification.view(workspaceId,run.id);
      if(view.workspaceId!==workspaceId||view.runId!==run.id||!Array.isArray(view.checks)||view.checks.length>100||!Array.isArray(view.commands)||view.commands.length>32
        ||view.checks.some(check=>check.projectId!==workspace.projectId||check.workspaceId!==workspaceId||check.runId!==run.id)
        ||new Set(view.commands.map(command=>command.id)).size!==view.commands.length)throw new Error();
      // view.canApprove covers the authoritative unbounded history and manager busy
      // state. Require each latest configured check to be visible as well, so base
      // identity cannot be silently inferred from the capped presentation history.
      const current=run.execution!=='lost'&&view.canApprove&&!view.sourceIssue&&initial!==null&&view.sourceDigest===initial&&!view.quarantined&&view.commands.length>0&&view.commands.every(command=>{
        const check=view.checks.find(record=>record.commandId===command.id);
        return check?.execution==='completed'&&check.verdict==='passed'&&check.exitCode===0&&check.baseSha===workspace.baseSha
          &&check.configDigest===command.configDigest&&check.sourceDigest===initial&&check.finishedDigest===initial;
      });
      result.verification={available:true,canApprove:current,approvalCurrent:current&&view.approvalCurrent,quarantined:view.quarantined,scope:view.scope,
        commands:view.commands.map(({id,label,configDigest})=>({id,label,configDigest})),checks:view.checks.map(projectCheck)};
    }catch{result.verification=unavailable();}
  }
  // A separately read Check view is not an atomic workspace snapshot. Never join
  // its approval to a different later source observation, including read failure.
  const final=readSource();
  if(initial===null||final===null||initial!==final){
    result.sourceDigest=initial===null?null:final;
    result.sourceIssue=final===null||initial===null?sourceIssue:'SOURCE_CHANGED_DURING_READ';
    if(result.verification){result.verification.canApprove=false;result.verification.approvalCurrent=false;}
  }
  result.observedAt=new Date().toISOString();return result;
}
