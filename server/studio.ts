import { createHash,randomUUID } from 'node:crypto';
import type { Store } from './store.ts';
import { AppError } from './errors.ts';
import { SqlitePlanningRepository,PlanningError } from './planning/repository.ts';
import type { PlanningInput } from './planning/parser.ts';
import { SqliteArtifactRepository } from './visualization/artifacts.ts';
import type { ArtifactInput,ArtifactRecord,PlanningVersion,SavedTask,TaskDraft } from '../shared/parallel.ts';
import type { PlanningComparison } from '../shared/planning-revisions.ts';
import { buildExecutionBrief } from './planning/execution.ts';
import { comparePlanningVersions } from './planning/comparison.ts';
import { serializePlanningExport } from './planning/export.ts';
import { serializePresentation } from './visualization/pptx.ts';
import { parseMermaid } from '../web/visualization/mermaid.ts';
import { toPresentationDocument } from '../web/visualization/presentation.ts';

export function exact(data:Record<string,unknown>,keys:string[]){
  if(Object.keys(data).sort().join(',')!==keys.sort().join(','))throw new AppError('INVALID_FIELDS',400);
}

/** Local sessions have access to registered projects, never arbitrary paths or foreign record IDs. */
export class Studio {
  private store:Store;private planning:SqlitePlanningRepository;private artifacts:SqliteArtifactRepository;
  constructor(store:Store){
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS planning_versions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,lineage_id TEXT NOT NULL,body TEXT NOT NULL,original_input TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_heads(lineage_id TEXT PRIMARY KEY,version_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_tasks(project_id TEXT NOT NULL,version_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(project_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,id,revision));
      CREATE TABLE IF NOT EXISTS studio_requests(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);`);
    this.planning=new SqlitePlanningRepository(store.db);this.artifacts=new SqliteArtifactRepository(store.db);
  }
  private project(id:string){if(!this.store.projects().some(project=>project.id===id))throw new AppError('PROJECT_NOT_FOUND',404);}
  private change<T extends PlanningVersion|ArtifactRecord|SavedTask[]>(projectId:string,operation:string,data:Record<string,unknown>,work:()=>T):T {
    this.project(projectId);
    return this.store.transaction(()=>{
      const requestId=data.requestId;
      const digest=createHash('sha256').update(JSON.stringify({projectId,operation,data})).digest('hex');
      if(requestId!==undefined){
        if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(requestId))throw new AppError('INVALID_REQUEST_ID',400);
        const previous=this.store.db.prepare('SELECT digest,result FROM studio_requests WHERE request_id=?').get(requestId);
        if(previous){if(previous.digest!==digest)throw new AppError('IDEMPOTENCY_CONFLICT',409);return JSON.parse(previous.result as string) as T;}
      }
      // A finite local project budget bounds list/history responses and prevents unbounded imports.
      const usage=this.store.db.prepare(`SELECT (SELECT COALESCE(SUM(length(CAST(body AS BLOB))+length(CAST(original_input AS BLOB))),0) FROM planning_versions WHERE project_id=?) + (SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM artifacts WHERE project_id=?) AS bytes`).get(projectId,projectId)!;
      const count=this.store.db.prepare('SELECT (SELECT COUNT(*) FROM planning_versions WHERE project_id=?) + (SELECT COUNT(*) FROM artifacts WHERE project_id=?) AS count').get(projectId,projectId)!;
      const addsVersion=['planning.created','planning.revised','artifact.created','artifact.revised'].includes(operation);
      if(addsVersion&&(Number(usage.bytes)>16*1024*1024||Number(count.count)>=200))throw new AppError('STUDIO_QUOTA',413);
      const result=work();
      if(requestId!==undefined)this.store.db.prepare('INSERT INTO studio_requests VALUES(?,?,?)').run(requestId as string,digest,JSON.stringify(result));
      const evidence=Array.isArray(result)?{planningVersionId:data.id,taskIds:result.map(task=>task.id),count:result.length}:
        {id:result.id,revision:result.revision,...('state' in result?{state:result.state}:{} )};
      this.store.append(operation,null,{projectId,actor:'local-user',...evidence});
      return result;
    });
  }
  read(projectId:string,kind:string,id?:string):unknown {
    this.project(projectId);
    if(kind==='plans')return this.planning.list(projectId);
    if(kind==='artifacts')return id?this.artifacts.history(projectId,id):this.artifacts.list(projectId);
    return this.store.db.prepare('SELECT body FROM planning_tasks WHERE project_id=? ORDER BY rowid').all(projectId).flatMap(row=>JSON.parse(row.body as string));
  }
  execution(projectId:string,taskId:string){
    const task=(this.read(projectId,'tasks') as SavedTask[]).find(task=>task.id===taskId);
    if(!task)throw new AppError('TASK_NOT_FOUND',404);
    const version=this.planning.list(projectId).find(version=>version.id===task.planningVersionId);
    if(!version)throw new AppError('VERSION_NOT_FOUND',404);
    const head=this.store.db.prepare('SELECT version_id FROM planning_heads WHERE lineage_id=?').get(version.lineageId!);
    if(head?.version_id!==version.id)throw new AppError('PLANNING_VERSION_STALE',409);
    return {...buildExecutionBrief(task,version),taskId:task.id};
  }
  comparePlanning(projectId:string,targetId:string,baseId:string):PlanningComparison {
    this.project(projectId);
    const versions=this.planning.list(projectId),base=versions.find(v=>v.id===baseId),target=versions.find(v=>v.id===targetId);
    if(!base||!target)throw new AppError('VERSION_NOT_FOUND',404);
    const tasks=this.read(projectId,'tasks') as SavedTask[],comparison=comparePlanningVersions(base,target,tasks);
    const head=this.store.db.prepare('SELECT version_id FROM planning_heads WHERE lineage_id=?').get(target.lineageId!);
    const targetCurrent=head?.version_id===target.id,availableLabels=target.draft.requirements.map(r=>r.label);
    const targetTasks=tasks.filter(t=>t.planningVersionId===target.id);
    const existingLabels=availableLabels.filter(label=>targetTasks.some(task=>task.requirementLabels.includes(label)));
    const view={...comparison,targetCurrent,canReplan:targetCurrent&&target.state==='approved'&&!target.draft.openQuestions.length,availableLabels,existingLabels};
    // Both predecessor and target tasks are bound, even when an unchanged
    // requirement has no impact row. New provenance requires a fresh preview.
    const taskIdentities=tasks.filter(t=>t.planningVersionId===base.id||t.planningVersionId===target.id).map(t=>({id:t.id,planningVersionId:t.planningVersionId,requirementLabels:t.requirementLabels}));
    const previewDigest=createHash('sha256').update(JSON.stringify({view,head:head?.version_id??null,taskIdentities})).digest('hex');
    return {...view,previewDigest};
  }
  private saveTasks(projectId:string,id:string,drafts:TaskDraft[],baseId?:string):SavedTask[] {
    const row=this.store.db.prepare('SELECT body FROM planning_tasks WHERE project_id=? AND version_id=?').get(projectId,id);
    const existing:SavedTask[]=row?JSON.parse(row.body as string):[],all=[...existing];
    const predecessors=baseId?(this.read(projectId,'tasks') as SavedTask[]).filter(task=>task.planningVersionId===baseId):[];
    const result=drafts.map(draft=>{
      const previous=existing.find(task=>task.requirementLabels.length===1&&task.requirementLabels[0]===draft.requirementLabels[0]);
      if(previous)return previous;
      const task:SavedTask={...draft,id:randomUUID(),projectId,state:'draft',verification:'not_run',createdAt:new Date().toISOString(),
        ...(baseId?{replannedFrom:{planningVersionId:baseId,taskIds:predecessors.filter(old=>old.requirementLabels.some(label=>draft.requirementLabels.includes(label))).map(old=>old.id)}}:{})};
      all.push(task);return task;
    });
    if(!row)this.store.db.prepare('INSERT INTO planning_tasks VALUES(?,?,?)').run(projectId,id,JSON.stringify(all));
    else if(all.length!==existing.length)this.store.db.prepare('UPDATE planning_tasks SET body=? WHERE project_id=? AND version_id=?').run(JSON.stringify(all),projectId,id);
    return result;
  }
  exportPlanning(projectId:string,id:string,revision:number,hash:string,format:'json'|'markdown'){
    this.project(projectId);
    const record=this.planning.list(projectId).find(version=>version.id===id);
    if(!record)throw new AppError('VERSION_NOT_FOUND',404);
    if(record.revision!==revision||record.contentHash!==hash)throw new AppError('REVISION_CONFLICT',409);
    const exported=serializePlanningExport(record.draft,format);
    return {bytes:Buffer.from(exported.text,'utf8'),mime:exported.mime,filename:`orbit-plan-${record.id}-v${record.revision}.${exported.extension}`};
  }
  exportArtifact(projectId:string,id:string,revision:number,hash:string,format:'pptx'|'markdown'){
    this.project(projectId);
    const record=this.artifacts.history(projectId,id).find(record=>record.revision===revision);
    if(!record||record.contentHash!==hash)throw new AppError('REVISION_CONFLICT',409);
    const filename=`orbit-${record.id}-v${record.revision}`;
    if(format==='markdown'){
      const fence='`'.repeat(Math.max(3,...Array.from(record.source.matchAll(/`+/g),match=>match[0].length+1)));
      const text=`# Orbit Artifact\n\nVersion: ${record.revision}\nSHA-256: ${record.contentHash}\n\n${fence}${record.kind==='mermaid'?'mermaid':'json'}\n${record.source}\n${fence}\n`;
      return {bytes:Buffer.from(text,'utf8'),mime:'text/markdown; charset=utf-8',filename:filename+'.md'};
    }
    const parsed=record.kind==='mermaid'?parseMermaid(record.source):JSON.parse(record.source);
    const document=record.kind==='presentation'?parsed:toPresentationDocument({nodes:parsed.nodes,edges:parsed.edges});
    return {bytes:Buffer.from(serializePresentation(document)),mime:'application/vnd.openxmlformats-officedocument.presentationml.presentation',filename:filename+'.pptx'};
  }
  mutate(projectId:string,kind:string,id:string|undefined,action:string|undefined,data:Record<string,unknown>):unknown {
    if(!id){
      exact(data,['requestId','input']);
      return this.change(projectId,kind==='plans'?'planning.created':'artifact.created',data,()=>kind==='plans'?this.planning.create(projectId,data.input as PlanningInput):this.artifacts.create(projectId,data.input as ArtifactInput));
    }
    if(action==='revisions'){
      exact(data,['requestId','expectedRevision','input']);
      return this.change(projectId,`${kind==='plans'?'planning':'artifact'}.revised`,{...data,id},()=>kind==='plans'?this.planning.revise(projectId,id,data.expectedRevision as number,data.input as PlanningInput):this.artifacts.revise(projectId,id,data.expectedRevision as number,data.input as ArtifactInput));
    }
    if(kind==='plans'&&action==='approve'){
      exact(data,['expectedRevision']);return this.change(projectId,'planning.approved',{...data,id},()=>this.planning.approve(projectId,id,data.expectedRevision as number));
    }
    if(kind==='plans'&&action==='task-drafts'){
      exact(data,[]);return this.change(projectId,'planning.tasks_created',{id},()=>{
        const drafts=this.planning.toTasks(projectId,id);
        return this.saveTasks(projectId,id,drafts);
      });
    }
    if(kind==='plans'&&action==='replan'){
      exact(data,['requestId','baseVersionId','expectedPreviewDigest','requirementLabels']);
      if(typeof data.requestId!=='string'||typeof data.baseVersionId!=='string'||!/^[a-f0-9-]{36}$/.test(data.baseVersionId)
        ||typeof data.expectedPreviewDigest!=='string'||!/^[a-f0-9]{64}$/.test(data.expectedPreviewDigest)
        ||!Array.isArray(data.requirementLabels)||data.requirementLabels.length<1||data.requirementLabels.length>100
        ||!data.requirementLabels.every(value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value))
        ||new Set(data.requirementLabels).size!==data.requirementLabels.length)throw new AppError('INVALID_FIELDS',400);
      const baseId=data.baseVersionId,labels=(data.requirementLabels as string[]).slice().sort();
      // Canonical fields make property order and selection order irrelevant to a receipt.
      return this.change(projectId,'planning.replanned',{requestId:data.requestId,baseVersionId:baseId,expectedPreviewDigest:data.expectedPreviewDigest,requirementLabels:labels,id},()=>{
        const view=this.comparePlanning(projectId,id,baseId);
        if(!view.targetCurrent)throw new AppError('PLANNING_VERSION_STALE',409);
        if(view.target.state!=='approved')throw new AppError('NOT_APPROVED',422);
        if(!view.canReplan)throw new AppError('UNRESOLVED_QUESTIONS',422);
        if(view.previewDigest!==data.expectedPreviewDigest)throw new AppError('PLANNING_PREVIEW_STALE',409);
        if(labels.some(label=>!view.availableLabels.includes(label)))throw new AppError('INVALID_REQUIREMENT_SELECTION',400);
        const drafts=this.planning.toTasks(projectId,id).filter(draft=>labels.includes(draft.requirementLabels[0]));
        return this.saveTasks(projectId,id,drafts,baseId);
      });
    }
    throw new AppError('NOT_FOUND',404);
  }
}

export function studioError(error:unknown):AppError|undefined {
  const code=error instanceof PlanningError?error.code:error instanceof Error?error.message:'';
  const statuses:Record<string,number>={INVALID_ID:400,INVALID_DRAFT:400,INVALID_PROJECT:400,INVALID_ARTIFACT:400,INVALID_PRESENTATION:422,ARTIFACT_KIND_IMMUTABLE:400,VERSION_NOT_FOUND:404,ARTIFACT_NOT_FOUND:404,REVISION_CONFLICT:409,NOT_APPROVED:422,INCOMPLETE_DRAFT:422};
  return statuses[code]?new AppError(code,statuses[code]):undefined;
}
