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
  observe(projectId:string,root:string,list:DeliverableList){
    // Only existing, validated task manifests establish a producing run. Filenames and mtimes do not.
    const sources=this.store.runs().filter(run=>run.projectId===projectId&&!run.workspaceId&&run.execution==='completed').flatMap(run=>{
      try{const snapshot=generalEvidenceSnapshot(this.store,run,()=>{throw Error('NO_MANIFEST');});
        return snapshot.manifest?[{run,files:snapshot.manifest.files}]:[];
      }catch{return [];}
    });
    this.store.transaction(()=>{
      for(const item of list.items.filter(item=>item.role==='output')){
        let file;try{file=readOutputDeliverable(root,item.path);}catch{continue;}
        const id=deliverableId(projectId,item.path),last=this.records(projectId,id).at(-1);
        const matches=sources.filter(source=>source.files.some(f=>f.path===item.path&&f.sha256===file.sha256)),run=matches.length===1?matches[0].run:null;
        if(last?.sha256===file.sha256&&last.size===file.size&&last.runId===(run?.id??null))continue;
        const version:DeliverableVersion={id:randomUUID(),deliverableId:id,path:item.path,size:file.size,sha256:file.sha256,
          taskId:run?.taskId??null,runId:run?.id??null,runAt:run?.updatedAt??null,observedAt:new Date().toISOString()};
        this.store.db.prepare('INSERT INTO deliverable_versions VALUES(?,?,?,?)').run(version.id,projectId,id,JSON.stringify(version));
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
  list(projectId:string,root:string,id:string){
    return this.records(projectId,id).map(version=>{
      let available=false;try{this.retained(projectId,root,version);available=true;}catch{}
      return {...version,available};
    });
  }
  references(projectId:string){return this.records(projectId);}
  download(projectId:string,root:string,id:string,versionId:string){
    const version=this.records(projectId,id).find(v=>v.id===versionId);
    if(!version)throw new AppError('DELIVERABLE_NOT_FOUND',404);
    return this.retained(projectId,root,version);
  }
}
