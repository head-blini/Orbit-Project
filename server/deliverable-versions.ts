import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import type {DeliverableList,DeliverableVersion} from '../shared/deliverables.ts';
import {readOutputDeliverable} from './deliverables.ts';
import {generalEvidenceSnapshot} from './quality-progress.ts';
import {AppError} from './errors.ts';

export const deliverableId=(projectId:string,path:string)=>createHash('sha256').update(JSON.stringify([projectId,path])).digest('hex');
/** Metadata only. Observations are explicit writes; listing and downloads never append history. */
export class DeliverableVersions {
  private store:Store;
  constructor(store:Store){
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS deliverable_versions (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,deliverable_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS deliverable_versions_owner ON deliverable_versions(project_id,deliverable_id);
      CREATE TRIGGER IF NOT EXISTS deliverable_versions_no_update BEFORE UPDATE ON deliverable_versions BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS deliverable_versions_no_delete BEFORE DELETE ON deliverable_versions BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;`);
  }
  private records(projectId:string,id?:string):DeliverableVersion[]{
    return this.store.db.prepare('SELECT body FROM deliverable_versions WHERE project_id=?'+(id?' AND deliverable_id=?':'')+' ORDER BY rowid').all(...(id?[projectId,id]:[projectId])).map(row=>JSON.parse(String(row.body)) as DeliverableVersion);
  }
  observe(projectId:string,root:string,list:DeliverableList,completedRunId?:string){
    // Only existing, validated task manifests establish a producing run. Filenames and mtimes do not.
    const candidate=completedRunId?this.store.getRun(completedRunId):null;
    let source:ReturnType<typeof generalEvidenceSnapshot>|null=null;
    if(candidate?.projectId===projectId&&!candidate.workspaceId&&candidate.execution==='completed'){
      try{source=generalEvidenceSnapshot(this.store,candidate,()=>{throw Error('NO_MANIFEST');});}catch{}
    }
    const observations:DeliverableVersion[]=[];
    for(const item of list.items.filter(item=>item.role==='output')){
      let file;try{file=readOutputDeliverable(root,item.path);}catch{continue;}
      const matches=source?.manifest?.files.filter(f=>f.path===item.path&&f.sha256===file.sha256)??[];
      const run=matches.length===1?candidate:null;
      observations.push({id:randomUUID(),deliverableId:deliverableId(projectId,item.path),path:item.path,size:file.size,sha256:file.sha256,
        taskId:run?.taskId??null,runId:run?.id??null,runAt:run?.updatedAt??null,observedAt:new Date().toISOString()});
    }
    // Hashing and manifest validation finish before acquiring the SQLite write lock.
    this.store.transaction(()=>{
      const latest=this.store.db.prepare('SELECT body FROM deliverable_versions WHERE project_id=? AND deliverable_id=? ORDER BY rowid DESC LIMIT 1');
      const insert=this.store.db.prepare('INSERT INTO deliverable_versions VALUES(?,?,?,?)');
      for(const version of observations){
        const row=latest.get(projectId,version.deliverableId),last=row?JSON.parse(String(row.body)) as DeliverableVersion:null;
        if(last?.sha256===version.sha256&&last.size===version.size&&last.runId===version.runId)continue;
        insert.run(version.id,projectId,version.deliverableId,JSON.stringify(version));
      }
    });
  }
  private retained(projectId:string,root:string,version:DeliverableVersion){
    try{const file=readOutputDeliverable(root,version.path);if(file.sha256===version.sha256&&file.size===version.size)return file;}catch{}
    if(version.runId){
      const run=this.store.getRun(version.runId);
      if(run?.projectId===projectId&&run.taskId===version.taskId&&!run.workspaceId)try{
        const snapshot=generalEvidenceSnapshot(this.store,run,()=>{throw Error('NO_MANIFEST');});
        if(snapshot.space&&snapshot.manifest?.files.some(f=>f.path===version.path&&f.sha256===version.sha256)){
          const file=readOutputDeliverable(snapshot.space.path,version.path);
          if(file.sha256===version.sha256&&file.size===version.size)return file;
        }
      }catch{/* A missing or changed retained workspace is not a downloadable version. */}
    }
    throw new AppError('DELIVERABLE_VERSION_UNAVAILABLE',409);
  }
  list(projectId:string,_root:string,id:string){
    // Retention is unknown until a requested download passes the guarded byte read.
    return this.store.db.prepare('SELECT body FROM deliverable_versions WHERE project_id=? AND deliverable_id=? ORDER BY rowid DESC LIMIT 100')
      .all(projectId,id).reverse().map(row=>JSON.parse(String(row.body)) as DeliverableVersion);
  }
  references(projectId:string){return this.records(projectId);}
  download(projectId:string,root:string,id:string,versionId:string){
    const row=this.store.db.prepare('SELECT body FROM deliverable_versions WHERE project_id=? AND deliverable_id=? AND id=?').get(projectId,id,versionId);
    const version=row?JSON.parse(String(row.body)) as DeliverableVersion:null;
    if(!version)throw new AppError('DELIVERABLE_NOT_FOUND',404);
    return this.retained(projectId,root,version);
  }
}
