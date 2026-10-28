import type {Store} from './store.ts';
import type {ProjectAiPreferences,UpdateProjectAiPreferencesInput} from '../shared/project-ai-preferences.ts';
import {AppError} from './errors.ts';

/** Selection only: no runtime or execution service dependencies. */
export class ProjectAiPreferencesService {
  private store:Store;
  constructor(store:Store){
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS project_ai_preferences(
      project_id TEXT PRIMARY KEY,
      planning TEXT NOT NULL CHECK(planning IN ('codex','claude-code')),
      execution TEXT NOT NULL CHECK(execution IN ('codex','claude-code')),
      revision INTEGER NOT NULL CHECK(revision>0),updated_at TEXT NOT NULL);`);
  }
  private project(id:string){
    const project=this.store.projects().find(project=>project.id===id);
    if(!project)throw new AppError('PROJECT_NOT_FOUND',404);return project;
  }
  read(projectId:string):ProjectAiPreferences {
    const project=this.project(projectId);
    const row=this.store.db.prepare('SELECT planning,execution,revision,updated_at AS updatedAt FROM project_ai_preferences WHERE project_id=?').get(projectId);
    if(row)return {...row} as unknown as ProjectAiPreferences;
    const runtime=project.kind==='general'?'claude-code':'codex';
    return {planning:runtime,execution:runtime,revision:0,updatedAt:null};
  }
  update(projectId:string,input:UpdateProjectAiPreferencesInput):ProjectAiPreferences {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='execution,expectedRevision,planning'
      ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.expectedRevision>=Number.MAX_SAFE_INTEGER
      ||!['codex','claude-code'].includes(input.planning)||!['codex','claude-code'].includes(input.execution))throw new AppError('INVALID_FIELDS',400);
    // Only combinations Orbit can actually run are stored, so the saved choice is always the runtime used.
    const kind=this.project(projectId).kind;
    if(kind==='general'&&(input.execution==='codex'||input.planning==='codex'))throw new AppError('GIT_REQUIRED',409);
    if(kind==='code'&&input.execution==='claude-code')throw new AppError('RUNTIME_NOT_SUPPORTED',409);
    return this.store.transaction(()=>{
      const current=this.read(projectId);
      if(current.revision!==input.expectedRevision)throw new AppError('AI_PREFERENCES_STALE',409);
      if(current.planning===input.planning&&current.execution===input.execution)return current;
      const next:ProjectAiPreferences={planning:input.planning,execution:input.execution,revision:current.revision+1,updatedAt:new Date().toISOString()};
      this.store.db.prepare(`INSERT INTO project_ai_preferences VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET
        planning=excluded.planning,execution=excluded.execution,revision=excluded.revision,updated_at=excluded.updated_at`).run(projectId,next.planning,next.execution,next.revision,next.updatedAt);
      return next;
    });
  }
}
