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
    const runs=this.store.runs().filter(run=>run.workspaceId&&workspaces.has(run.workspaceId));
    const checks=this.checks().filter(check=>check.projectId===projectId&&workspaces.has(check.workspaceId));
    return buildProjectProgress({projectId,tasks,runs,checks,plans,currentPlanIds,signals});
  }
  private checks():CheckRecord[]{
    // The table belongs to VerificationService and may not exist yet in a fresh database.
    if(!this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='verification_checks'").get())return [];
    return this.store.db.prepare('SELECT body FROM verification_checks ORDER BY rowid').all().flatMap(row=>{
      try{return [JSON.parse(String(row.body)) as CheckRecord];}catch{return [];}
    });
  }
}
