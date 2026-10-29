import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import {Studio,exact} from './studio.ts';
import {AppError} from './errors.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {TrackedGoal,TrackedGoalView,CreateTrackedGoalInput,SetTrackingStateInput,GoalEvidenceReference} from '../shared/goals.ts';
import type {Run} from '../shared/types.ts';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function fields(input:unknown,keys:string[]):asserts input is Record<string,unknown> {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('INVALID_FIELDS',400);
  exact(input as Record<string,unknown>,keys);
}

/** Tracking has no runtime, filesystem, usage-refresh or execution dependency. */
export class GoalService {
  private store:Store;private studio:Studio;
  constructor(store:Store){
    this.store=store;this.studio=new Studio(store);
    const version=store.getMeta('goal_schema_version');
    if(version!==null&&version!=='1')throw new AppError('GOAL_SCHEMA_UNSUPPORTED',503);
    store.transaction(()=>{
      store.db.exec(`CREATE TABLE IF NOT EXISTS tracked_goals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,planning_version_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(project_id,planning_version_id));
        CREATE TABLE IF NOT EXISTS goal_history(goal_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(goal_id,revision));
        CREATE TABLE IF NOT EXISTS goal_requests(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);`);
      if(version===null)store.setMeta('goal_schema_version','1');
    });
  }
  private project(id:string){if(!identifier(id))throw new AppError('INVALID_PROJECT_ID',400);if(!this.store.projects().some(p=>p.id===id))throw new AppError('PROJECT_NOT_FOUND',404);}
  private plan(projectId:string,id:string):PlanningVersion {
    const row=this.store.db.prepare('SELECT id,project_id,lineage_id,body FROM planning_versions WHERE id=? AND project_id=?').get(id,projectId);
    if(!row)throw new AppError('PLAN_NOT_FOUND',404);
    const plan=JSON.parse(String(row.body)) as PlanningVersion;
    if(plan.id!==row.id||plan.projectId!==row.project_id||plan.lineageId!==row.lineage_id||!digest(plan.contentHash)||hash(plan.draft)!==plan.contentHash)throw new AppError('PLAN_INTEGRITY',409);
    return plan;
  }
  private current(plan:PlanningVersion){return this.store.db.prepare('SELECT version_id FROM planning_heads WHERE lineage_id=?').get(plan.lineageId!)?.version_id===plan.id;}
  private record(projectId:string,id:string):TrackedGoal {
    const row=this.store.db.prepare('SELECT * FROM tracked_goals WHERE id=? AND project_id=?').get(id,projectId);
    if(!row)throw new AppError('GOAL_NOT_FOUND',404);
    const goal=JSON.parse(String(row.body)) as TrackedGoal;
    if(goal.id!==row.id||goal.projectId!==row.project_id||goal.planningVersionId!==row.planning_version_id||goal.level!=='tracking'
      ||!['tracking','paused','cancelled'].includes(goal.state)||!Number.isSafeInteger(goal.revision)||goal.revision<1)throw new AppError('GOAL_INTEGRITY',409);
    return goal;
  }
  private change(projectId:string,operation:string,input:object,requestId:string,work:()=>TrackedGoal):TrackedGoal {
    this.project(projectId);if(typeof requestId!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(requestId))throw new AppError('INVALID_REQUEST_ID',400);
    return this.store.transaction(()=>{
      const fingerprint=hash({projectId,operation,input});
      const receipt=this.store.db.prepare('SELECT digest,result FROM goal_requests WHERE request_id=?').get(requestId);
      if(receipt){if(receipt.digest!==fingerprint)throw new AppError('IDEMPOTENCY_CONFLICT',409);return JSON.parse(String(receipt.result));}
      const goal=work(),body=JSON.stringify(goal);
      this.store.db.prepare('INSERT INTO goal_history VALUES(?,?,?)').run(goal.id,goal.revision,body);
      this.store.db.prepare('INSERT INTO goal_requests VALUES(?,?,?)').run(requestId,fingerprint,body);
      this.store.append(operation,null,{projectId,goalId:goal.id,revision:goal.revision,state:goal.state,actor:'local-user'});
      return goal;
    });
  }
  create(projectId:string,input:CreateTrackedGoalInput):TrackedGoal {
    fields(input,['requestId','planningVersionId','expectedPlanningHash']);
    if(!uuid(input.planningVersionId)||!digest(input.expectedPlanningHash))throw new AppError('INVALID_FIELDS',400);
    const canonical={requestId:input.requestId,planningVersionId:input.planningVersionId,expectedPlanningHash:input.expectedPlanningHash};
    return this.change(projectId,'goal.created',canonical,input.requestId,()=>{
      const plan=this.plan(projectId,input.planningVersionId);
      if(plan.state!=='approved')throw new AppError('PLAN_NOT_APPROVED',409);
      if(plan.contentHash!==input.expectedPlanningHash)throw new AppError('PLAN_CHANGED',409);
      if(!this.current(plan))throw new AppError('PLAN_NOT_CURRENT',409);
      if(this.store.db.prepare('SELECT id FROM tracked_goals WHERE project_id=? AND planning_version_id=?').get(projectId,plan.id))throw new AppError('GOAL_ALREADY_TRACKED',409);
      if(Number(this.store.db.prepare('SELECT COUNT(*) AS count FROM tracked_goals WHERE project_id=?').get(projectId)!.count)>=100)throw new AppError('GOAL_LIMIT',413);
      const now=new Date().toISOString(),goal:TrackedGoal={id:randomUUID(),projectId,planningVersionId:plan.id,planningHash:plan.contentHash,revision:1,level:'tracking',state:'tracking',createdAt:now,updatedAt:now};
      this.store.db.prepare('INSERT INTO tracked_goals VALUES(?,?,?,?)').run(goal.id,projectId,plan.id,JSON.stringify(goal));return goal;
    });
  }
  setState(projectId:string,id:string,input:SetTrackingStateInput):TrackedGoal {
    fields(input,['requestId','expectedRevision','state']);
    if(!uuid(id)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||!['tracking','paused','cancelled'].includes(input.state))throw new AppError('INVALID_FIELDS',400);
    const canonical={id,requestId:input.requestId,expectedRevision:input.expectedRevision,state:input.state};
    return this.change(projectId,'goal.state_changed',canonical,input.requestId,()=>{
      const old=this.record(projectId,id);
      if(old.revision!==input.expectedRevision)throw new AppError('GOAL_REVISION_CONFLICT',409);
      if(old.state==='cancelled')throw new AppError('GOAL_CANCELLED',409);
      if(old.state===input.state)throw new AppError('GOAL_STATE_UNCHANGED',409);
      if(old.revision>=200)throw new AppError('GOAL_HISTORY_LIMIT',413);
      const goal={...old,state:input.state,revision:old.revision+1,updatedAt:new Date().toISOString()};
      this.store.db.prepare('UPDATE tracked_goals SET body=? WHERE id=?').run(JSON.stringify(goal),id);return goal;
    });
  }
  history(projectId:string,id:string):TrackedGoal[]{
    this.project(projectId);this.record(projectId,id);
    return this.store.db.prepare('SELECT revision,body FROM goal_history WHERE goal_id=? ORDER BY revision').all(id).map(row=>{
      const goal=JSON.parse(String(row.body)) as TrackedGoal;
      if(goal.id!==id||goal.projectId!==projectId||goal.revision!==row.revision)throw new AppError('GOAL_INTEGRITY',409);return goal;
    });
  }
  private evidence(runs:Run[],projectId:string):{refs:GoalEvidenceReference[];recoveryRequired:boolean}{
    let recoveryRequired=false;
    const byId=new Map(runs.map(run=>[run.id,run]));
    const refs:GoalEvidenceReference[]=runs.map(run=>({kind:'run',id:run.id,runId:run.id,status:run.execution,sourceDigest:null,qualification:'reference_only'}));
    for(const [table,kind] of [['verification_checks','check'],['native_reviews','review'],['verification_approvals','approval'],['merge_records','merge']] as const){
      if(!this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
      // Table names are internal literals. Bodies are projected, never forwarded.
      for(const row of this.store.db.prepare(`SELECT id,body FROM ${table} ORDER BY rowid`).all()){
        const record=JSON.parse(String(row.body)),run=byId.get(record.runId);
        if(!run||record.id!==row.id||record.workspaceId!==run.workspaceId||(kind!=='approval'&&record.projectId!==projectId))continue;
        if(kind==='check'&&record.execution==='lost'&&!record.recoveredAt)recoveryRequired=true;
        const status=kind==='check'?(['running','lost'].includes(record.execution)?record.execution:record.verdict):kind==='approval'?'recorded':kind==='merge'?record.status:record.execution;
        const allowed=['not_run','passed','failed','interrupted','timed_out','stale','running','completed','lost','recorded','preparing','prepared','applying','applied','not_applied'];
        refs.push({kind,id:record.id,runId:run.id,status:allowed.includes(status)?status:'unknown',sourceDigest:digest(record.sourceDigest)?record.sourceDigest:null,qualification:'reference_only'});
      }
    }
    return {refs,recoveryRequired};
  }
  list(projectId:string):TrackedGoalView[]{
    this.project(projectId);
    const tasks=this.studio.read(projectId,'tasks') as SavedTask[],workspaces=new Set(this.store.workspaces().filter(w=>w.projectId===projectId).map(w=>w.id));
    const allRuns=this.store.runs().filter(run=>run.workspaceId?workspaces.has(run.workspaceId):run.projectId===projectId);
    return this.store.db.prepare('SELECT id FROM tracked_goals WHERE project_id=? ORDER BY rowid DESC').all(projectId).map(row=>{
      const goal=this.record(projectId,String(row.id)),plan=this.plan(projectId,goal.planningVersionId);
      if(plan.contentHash!==goal.planningHash)throw new AppError('GOAL_PLAN_INTEGRITY',409);
      const planCurrent=this.current(plan)&&plan.state==='approved',linkedTasks=tasks.filter(t=>t.projectId===projectId&&t.planningVersionId===plan.id),taskIds=new Set(linkedTasks.map(t=>t.id));
      const runs=allRuns.filter(run=>run.planningVersionId===plan.id&&run.taskId&&taskIds.has(run.taskId)),{refs:evidence,recoveryRequired}=this.evidence(runs,projectId);
      const blockers=['ACCEPTANCE_NOT_QUALIFIED'];if(!planCurrent)blockers.push('PLAN_NOT_CURRENT');if(runs.some(r=>r.execution==='lost'))blockers.push('RUN_RECOVERY_UNRESOLVED');
      if(recoveryRequired)blockers.push('EVIDENCE_RECOVERY_UNRESOLVED');
      return {goal,title:plan.draft.title,objective:plan.draft.goal,planCurrent,blockers,
        evidenceScope:'기존 기록은 참고 증거입니다. 현재 소스·승인된 수용 테스트·실행 환경의 자격 검증을 뜻하지 않습니다. 요구사항별 최대 100개 참조를 표시합니다.',
        requirements:plan.draft.requirements.map(requirement=>{
          const ids=linkedTasks.filter(task=>task.requirementLabels.includes(requirement.label)).map(t=>t.id),set=new Set(ids);
          const relevant=runs.filter(run=>set.has(run.taskId!)),runIds=new Set(relevant.map(run=>run.id)),references=evidence.filter(ref=>runIds.has(ref.runId));
          return {...requirement,taskIds:ids,runs:relevant.slice(-100).map(run=>({id:run.id,execution:run.execution})),runsTotal:relevant.length,acceptance:'unverified' as const,evidence:references.slice(-100),evidenceTotal:references.length};
        })};
    });
  }
}
