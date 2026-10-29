import {createHash} from 'node:crypto';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {TaskGraphBaseline,TaskGraphFacts,TaskGraphInput,TaskGraphMetadata,TaskGraphRevision,TaskGraphState} from '../shared/task-graph.ts';
import type {Store} from './store.ts';
import {Studio} from './studio.ts';
import {AppError} from './errors.ts';

const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=1024&&v.trim()===v&&!/[\x00-\x1f\x7f]/.test(v);
const fields=(v:unknown,required:string[],optional:string[]=[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const unique=(values:string[])=>new Set(values).size===values.length;
function metadata(value:TaskGraphMetadata):boolean{
  if(value.contracts!==undefined&&(!Array.isArray(value.contracts)||value.contracts.length>100||!value.contracts.every(c=>fields(c,['id','digest'])&&id(c.id)&&text(c.digest))||!unique(value.contracts.map(c=>c.id))))return false;
  const scope=value.impactScope;
  return scope===undefined||(fields(scope,['files','resources'])&&[scope.files,scope.resources].every(list=>Array.isArray(list)&&list.length<=100&&list.every(text)&&unique(list)));
}
function validateInput(input:TaskGraphInput){
  if(!fields(input,['planningVersionId','contentHash','expectedRevision','nodes','edges'])||!id(input.planningVersionId)||typeof input.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(input.contentHash)
    ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||input.expectedRevision>=Number.MAX_SAFE_INTEGER
    ||!Array.isArray(input.nodes)||input.nodes.length>1000||!Array.isArray(input.edges)||input.edges.length>10000
    ||!input.nodes.every(n=>fields(n,['taskId'],['contracts','impactScope'])&&id(n.taskId)&&metadata(n))
    ||!input.edges.every(e=>fields(e,['taskId','dependsOn'],['contracts','impactScope'])&&id(e.taskId)&&id(e.dependsOn)&&metadata(e)))throw new AppError('INVALID_FIELDS',400);
  if(Buffer.byteLength(JSON.stringify(input),'utf8')>1024*1024)throw new AppError('TASK_GRAPH_TOO_LARGE',413);
  const ids=new Set(input.nodes.map(n=>n.taskId));
  if(ids.size!==input.nodes.length)throw new AppError('TASK_GRAPH_DUPLICATE_NODE',400);
  const pairs=new Set<string>(),remaining=new Map([...ids].map(taskId=>[taskId,0])),dependents=new Map([...ids].map(taskId=>[taskId,[] as string[]]));
  for(const edge of input.edges){
    if(!ids.has(edge.taskId)||!ids.has(edge.dependsOn))throw new AppError('TASK_GRAPH_UNKNOWN_TASK',400);
    if(edge.taskId===edge.dependsOn)throw new AppError('TASK_GRAPH_SELF_EDGE',400);
    const key=JSON.stringify([edge.taskId,edge.dependsOn]);if(pairs.has(key))throw new AppError('TASK_GRAPH_DUPLICATE_EDGE',400);pairs.add(key);
    remaining.set(edge.taskId,remaining.get(edge.taskId)!+1);dependents.get(edge.dependsOn)!.push(edge.taskId);
  }
  const queue=[...ids].filter(taskId=>remaining.get(taskId)===0);
  for(let i=0;i<queue.length;i++)for(const next of dependents.get(queue[i])!){remaining.set(next,remaining.get(next)!-1);if(remaining.get(next)===0)queue.push(next);}
  if(queue.length!==ids.size)throw new AppError('TASK_GRAPH_CYCLE',400);
}
function current(graph:Pick<TaskGraphRevision,'projectId'|'planningVersionId'|'contentHash'>,baseline:TaskGraphBaseline):boolean{
  const v=baseline.version;
  return !!v&&v.projectId===graph.projectId&&v.id===graph.planningVersionId&&v.contentHash===graph.contentHash&&v.state==='approved'&&baseline.currentVersionId===v.id
    &&typeof v.approvedAt==='string'&&Number.isFinite(Date.parse(v.approvedAt))&&typeof v.approvedBy==='string'&&!!v.approvedBy.trim()
    &&createHash('sha256').update(JSON.stringify(v.draft)).digest('hex')===v.contentHash;
}
/** Pure projection. Stale and explicit blockers override verified completion; no execution or I/O. */
export function deriveTaskGraphState(graph:TaskGraphRevision,baseline:TaskGraphBaseline,facts:TaskGraphFacts):TaskGraphState{
  const ids=new Set(graph.nodes.map(n=>n.taskId));
  if(!fields(facts,['verifiedDoneIds','blocked'])||!Array.isArray(facts.verifiedDoneIds)||!facts.verifiedDoneIds.every(taskId=>ids.has(taskId))||!unique(facts.verifiedDoneIds)
    ||!Array.isArray(facts.blocked)||!facts.blocked.every(b=>fields(b,['taskId','reasonCodes'])&&ids.has(b.taskId)&&Array.isArray(b.reasonCodes)&&b.reasonCodes.length>0&&b.reasonCodes.length<=100&&b.reasonCodes.every(code=>typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(code))&&unique(b.reasonCodes))
    ||!unique(facts.blocked.map(b=>b.taskId)))throw new AppError('TASK_GRAPH_FACTS_INVALID',400);
  const stale=!current(graph,baseline),blocked=new Map(facts.blocked.map(b=>[b.taskId,b.reasonCodes])),done=new Set(facts.verifiedDoneIds.filter(taskId=>!blocked.has(taskId)));
  return {stale,nodes:graph.nodes.map(({taskId})=>{
    if(stale)return {taskId,state:'stale',reasonCodes:['TASK_GRAPH_BASELINE_CHANGED']};
    const reasons=blocked.get(taskId);if(reasons)return {taskId,state:'blocked',reasonCodes:[...reasons]};
    if(done.has(taskId))return {taskId,state:'done'};
    const predecessors=graph.edges.filter(e=>e.taskId===taskId&&!done.has(e.dependsOn)).map(e=>e.dependsOn);
    return predecessors.length?{taskId,state:'waiting',predecessors}:{taskId,state:'ready'};
  })};
}

/** One graph per project/planning version. Append-only revisions; Store owns connection lifetime. */
export class TaskGraphService {
  private store:Store;private studio:Studio;
  constructor(store:Store){
    this.store=store;this.studio=new Studio(store);
    store.db.exec('CREATE TABLE IF NOT EXISTS task_graph_revisions(project_id TEXT NOT NULL,planning_version_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),body TEXT NOT NULL,PRIMARY KEY(project_id,planning_version_id,revision))');
  }
  private project(projectId:string){
    if(!id(projectId))throw new AppError('INVALID_FIELDS',400);
    if(!this.store.projects().some(p=>p.id===projectId))throw new AppError('PROJECT_NOT_FOUND',404);
  }
  private baseline(projectId:string,versionId:string):TaskGraphBaseline{
    const version=(this.studio.read(projectId,'plans') as PlanningVersion[]).find(v=>v.id===versionId)??null;
    const head=version?.lineageId?this.store.db.prepare('SELECT version_id FROM planning_heads WHERE lineage_id=?').get(version.lineageId):undefined;
    return {version,currentVersionId:typeof head?.version_id==='string'?head.version_id:null};
  }
  save(projectId:string,input:TaskGraphInput):TaskGraphRevision{
    this.project(projectId);validateInput(input);
    return this.store.transaction(()=>{
      const latest=this.store.db.prepare('SELECT revision,body FROM task_graph_revisions WHERE project_id=? AND planning_version_id=? ORDER BY revision DESC LIMIT 1').get(projectId,input.planningVersionId);
      if(Number(latest?.revision??0)!==input.expectedRevision)throw new AppError('REVISION_CONFLICT',409);
      if(latest&&JSON.parse(String(latest.body)).contentHash!==input.contentHash)throw new AppError('TASK_GRAPH_BASELINE_CHANGED',409);
      const baseline=this.baseline(projectId,input.planningVersionId);
      if(!baseline.version)throw new AppError('VERSION_NOT_FOUND',404);
      if(baseline.version.state==='draft')throw new AppError('NOT_APPROVED',422);
      if(!current({projectId,...input},baseline))throw new AppError('TASK_GRAPH_BASELINE_CHANGED',409);
      const tasks=new Map((this.studio.read(projectId,'tasks') as SavedTask[]).map(task=>[task.id,task]));
      for(const node of input.nodes){
        const task=tasks.get(node.taskId);if(!task)throw new AppError('TASK_GRAPH_UNKNOWN_TASK',400);
        if(task.projectId!==projectId||task.planningVersionId!==input.planningVersionId)throw new AppError('TASK_GRAPH_TASK_SCOPE',409);
      }
      const graph:TaskGraphRevision={projectId,planningVersionId:input.planningVersionId,contentHash:input.contentHash,revision:input.expectedRevision+1,createdAt:new Date().toISOString(),nodes:structuredClone(input.nodes),edges:structuredClone(input.edges)};
      this.store.db.prepare('INSERT INTO task_graph_revisions(project_id,planning_version_id,revision,body) VALUES(?,?,?,?)').run(projectId,input.planningVersionId,graph.revision,JSON.stringify(graph));
      return graph;
    });
  }
  read(projectId:string,planningVersionId:string,revision?:number):TaskGraphRevision{
    this.project(projectId);
    if(!id(planningVersionId)||(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1)))throw new AppError('INVALID_FIELDS',400);
    const row=revision===undefined?this.store.db.prepare('SELECT body FROM task_graph_revisions WHERE project_id=? AND planning_version_id=? ORDER BY revision DESC LIMIT 1').get(projectId,planningVersionId)
      :this.store.db.prepare('SELECT body FROM task_graph_revisions WHERE project_id=? AND planning_version_id=? AND revision=?').get(projectId,planningVersionId,revision);
    if(!row)throw new AppError('TASK_GRAPH_NOT_FOUND',404);return JSON.parse(String(row.body));
  }
  history(projectId:string,planningVersionId:string):TaskGraphRevision[]{
    this.project(projectId);if(!id(planningVersionId))throw new AppError('INVALID_FIELDS',400);
    return this.store.db.prepare('SELECT body FROM task_graph_revisions WHERE project_id=? AND planning_version_id=? ORDER BY revision').all(projectId,planningVersionId).map(row=>JSON.parse(String(row.body)));
  }
  view(projectId:string,planningVersionId:string,facts:TaskGraphFacts,revision?:number):TaskGraphState{
    // Read graph and planning head in one snapshot, including concurrent planning edits.
    return this.store.transaction(()=>deriveTaskGraphState(this.read(projectId,planningVersionId,revision),this.baseline(projectId,planningVersionId),facts));
  }
}
