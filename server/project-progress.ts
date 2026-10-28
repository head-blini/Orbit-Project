import {readCapabilityExecution} from './capability-execution.ts';
import type {CapabilityRouteDecision} from '../shared/capability-routing.ts';
import type {QualityLoopRecord} from '../shared/quality-loop-record.ts';
import type {Store} from './store.ts';
import type {Studio} from './studio.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {CheckRecord} from '../shared/verification.ts';
import {buildProjectProgress,type ProgressSignals,type ProjectProgress} from '../shared/project-progress.ts';
import {AppError} from './errors.ts';

/** Read-only collector for the project progress board. It only reads recorded state. */
export class ProjectProgressService {
  private store:Store;private studio:Studio;
  constructor(store:Store,studio:Studio){this.store=store;this.studio=studio;}
  read(projectId:string,signals:ProgressSignals):ProjectProgress{
    if(!this.store.projects().some(project=>project.id===projectId))throw new AppError('PROJECT_NOT_FOUND',404);
    const plans=this.studio.read(projectId,'plans') as PlanningVersion[],tasks=this.studio.read(projectId,'tasks') as SavedTask[];
    const lineages=[...new Set(plans.map(plan=>plan.lineageId).filter((id):id is string=>!!id))];
    const head=this.store.db.prepare('SELECT version_id FROM planning_heads WHERE lineage_id=?');
    const currentPlanIds=lineages.flatMap(id=>{const row=head.get(id);return row?[String(row.version_id)]:[];});
    const workspaces=new Set(this.store.workspaces().filter(w=>w.projectId===projectId).map(w=>w.id));
    // Code-project runs belong to a project workspace; general-project runs carry projectId directly.
    const runs=this.store.runs().filter(run=>run.workspaceId?workspaces.has(run.workspaceId):(run as typeof run&{projectId?:unknown}).projectId===projectId);
    const checks=this.checks().filter(check=>check.projectId===projectId&&workspaces.has(check.workspaceId));
    const progress=buildProjectProgress({projectId,tasks,runs,checks,plans,currentPlanIds,signals,activity:this.activity(new Set(runs.map(run=>run.id)))});
    if(this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quality_loops'").get()){
      const records=this.store.db.prepare('SELECT body FROM quality_loops WHERE project_id=? ORDER BY rowid DESC').all(projectId).map(row=>JSON.parse(String(row.body)) as QualityLoopRecord);
      for(const task of progress.tasks)task.qualityLoops=records.filter(record=>record.taskId===task.id).slice(0,20);
    }
    if(this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='capability_routes'").get()){
      const query=this.store.db.prepare("SELECT body FROM capability_routes WHERE project_id=? AND json_valid(body) AND json_extract(body,'$.taskId')=? ORDER BY rowid DESC LIMIT 20");
      for(const task of progress.tasks)task.capabilityRoutes=query.all(projectId,task.id).flatMap(row=>{
        try{const record=JSON.parse(String(row.body)) as CapabilityRouteDecision;return record.projectId===projectId&&record.taskId===task.id?[record]:[];}catch{return [];}
      });
    }
    if(this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='capability_executions'").get()){
      const query=this.store.db.prepare("SELECT id FROM capability_executions WHERE project_id=? AND json_valid(body) AND json_extract(body,'$.taskId')=? ORDER BY rowid DESC LIMIT 20");
      for(const task of progress.tasks)task.capabilityExecutions=query.all(projectId,task.id).flatMap(row=>{
        const record=readCapabilityExecution(this.store,projectId,String(row.id));return record?[record]:[];
      });
    }
    for(const task of progress.tasks)for(const run of task.runs)run.modelAttribution=this.store.getCodexModelAttribution(run.id);
    return progress;
  }
  /** Latest event time per run plus the most recent tool name; other event payloads are never read out. */
  private activity(ids:ReadonlySet<string>){
    const result:Record<string,{at:string;tool:string|null}>={};
    if(!ids.size)return result;
    for(const row of this.store.db.prepare('SELECT run_id,MAX(at) AS at FROM events WHERE run_id IS NOT NULL GROUP BY run_id').all()){
      const id=String(row.run_id);if(ids.has(id))result[id]={at:String(row.at),tool:null};
    }
    const tool=this.store.db.prepare("SELECT json_extract(data,'$.name') AS name FROM events WHERE run_id=? AND kind='claude.tool' ORDER BY seq DESC LIMIT 1");
    for(const id of Object.keys(result)){const name=tool.get(id)?.name;if(typeof name==='string'&&/^[A-Za-z][\w.-]{0,79}$/.test(name))result[id].tool=name;}
    return result;
  }
  private checks():CheckRecord[]{
    // The table belongs to VerificationService and may not exist yet in a fresh database.
    if(!this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='verification_checks'").get())return [];
    return this.store.db.prepare('SELECT body FROM verification_checks ORDER BY rowid').all().flatMap(row=>{
      try{return [JSON.parse(String(row.body)) as CheckRecord];}catch{return [];}
    });
  }
}
