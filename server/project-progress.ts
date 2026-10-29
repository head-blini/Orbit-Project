import {createHash} from 'node:crypto';
import {CODE_GATES,GENERAL_GATES,type CompletionPolicy,type CompletionEvidence,type CompletionBinding} from '../shared/task-completion.ts';
import {completionPolicyDigest,evaluateTaskCompletion} from './task-completion.ts';
import {deriveTaskGraphState,TaskGraphService} from './task-graph.ts';
import type {TaskGraphRevision} from '../shared/task-graph.ts';
import type {Run} from '../shared/types.ts';
import {capturedCompletionBinding,generalCheckerDigest,generalEvidenceSnapshot,QualityProgressCollector,type QualityProgressReaders} from './quality-progress.ts';
import {readCapabilityExecution} from './capability-execution.ts';
import type {CapabilityRouteDecision} from '../shared/capability-routing.ts';
import type {QualityLoopRecord} from '../shared/quality-loop-record.ts';
import type {Store} from './store.ts';
import type {Studio} from './studio.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {CheckRecord} from '../shared/verification.ts';
import {buildProjectProgress,type ProgressSignals,type ProjectProgress} from '../shared/project-progress.ts';
import {AppError} from './errors.ts';
import {isAbsolute} from 'node:path';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface CompletionReaders extends QualityProgressReaders {
 policy?:(projectId:string)=>CompletionPolicy|undefined;
 /** Trusted persisted provenance adapter; never a request payload. */
 evidence?:(quality:CompletionEvidence,run:Run)=>CompletionEvidence;
}
/** Host configuration only. Missing entries retain the conservative wait policy. */
export function readCompletionPolicies(raw:string|undefined):{projectPath:string;policy:CompletionPolicy}[]{
 if(raw===undefined)return [];
 try{
  if(raw.length>64000)throw Error();
  const values=JSON.parse(raw);
  if(!Array.isArray(values)||values.length>100)throw Error();
  const exact=(v:object,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
  for(const entry of values){
   if(!exact(entry,['projectPath','policy'])||typeof entry.projectPath!=='string'||!isAbsolute(entry.projectPath))throw Error();
   const p=entry.policy;
   if(!exact(p,['projectKind','requiredGates','gateCommandMap','notApplicable','requireIndependentReview','dependencyRelease'])
    ||!['code','general'].includes(p.projectKind)||typeof p.requireIndependentReview!=='boolean'
    ||!['wait','quality_passed','quality_passed_and_user_approval'].includes(p.dependencyRelease)
    ||!Array.isArray(p.requiredGates)||!p.requiredGates.length||new Set(p.requiredGates).size!==p.requiredGates.length
    ||!p.requiredGates.every((g:string)=>((p.projectKind==='code'?CODE_GATES:GENERAL_GATES) as readonly string[]).includes(g))
    ||!p.gateCommandMap||typeof p.gateCommandMap!=='object'||Array.isArray(p.gateCommandMap)
    ||!Object.entries(p.gateCommandMap).every(([gate,ids])=>(CODE_GATES as readonly string[]).includes(gate)&&Array.isArray(ids)&&ids.every(id=>typeof id==='string'&&!!id.trim())&&new Set(ids).size===ids.length)
    ||!Array.isArray(p.notApplicable)||!p.notApplicable.every((n:{gate:string;reason:string;approvedBy:string;approvedAt:string})=>exact(n,['gate','reason','approvedBy','approvedAt'])&&p.requiredGates.includes(n.gate)&&[n.reason,n.approvedBy,n.approvedAt].every(v=>typeof v==='string'&&!!v.trim())&&Number.isFinite(Date.parse(n.approvedAt))))throw Error();
  }
  if(new Set(values.map(v=>v.projectPath)).size!==values.length)throw Error();
  return values;
 }catch{throw Error('INVALID_COMPLETION_CONFIGURATION');}
}
export function defaultCompletionPolicy(kind:'code'|'general'):CompletionPolicy {
 return {projectKind:kind,requiredGates:[...(kind==='code'?CODE_GATES:GENERAL_GATES)],gateCommandMap:{},notApplicable:[],requireIndependentReview:kind==='general',dependencyRelease:'wait'};
}


/** Read-only collector for the project progress board. It only reads recorded state. */
export class ProjectProgressService {
  private store:Store;private studio:Studio;private graphs:TaskGraphService;private qualityReaders:CompletionReaders;
  constructor(store:Store,studio:Studio,qualityReaders:CompletionReaders={}){this.store=store;this.studio=studio;this.graphs=new TaskGraphService(store);this.qualityReaders=qualityReaders;}
  read(projectId:string,signals:ProgressSignals):ProjectProgress{
    return this.store.transaction(()=>this.collect(projectId,signals));
  }
  /** Graph, baseline and completion records share one SQLite snapshot. */
  graph(projectId:string,versionId:string,revision?:number){
    const graphs=this.graphs;
    return this.store.transaction(()=>{
      const graph=graphs.read(projectId,versionId,revision),progress=this.collect(projectId,{},graph);
      const version=(this.studio.read(projectId,'plans') as PlanningVersion[]).find(p=>p.id===versionId)??null;
      const head=version?.lineageId?this.store.db.prepare('SELECT version_id FROM planning_heads WHERE lineage_id=?').get(version.lineageId):undefined;
      const tasks=progress.tasks.filter(t=>graph.nodes.some(n=>n.taskId===t.id));
      const reasons:Partial<Record<string,string>>={lost:'TASK_RUN_LOST',error:'TASK_RUN_FAILED',verification_failed:'TASK_VERIFICATION_FAILED'};
      const facts={verifiedDoneIds:tasks.filter(t=>t.completion?.verifiedDone).map(t=>t.id),blocked:tasks.filter(t=>reasons[t.stage]).map(t=>({taskId:t.id,reasonCodes:[reasons[t.stage]!]}))};
      return {graph,progress,state:deriveTaskGraphState(graph,{version,currentVersionId:typeof head?.version_id==='string'?head.version_id:null},facts)};
    });
  }
  private collect(projectId:string,signals:ProgressSignals,selectedGraph?:TaskGraphRevision):ProjectProgress{
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
    const quality=new QualityProgressCollector(this.store,this.qualityReaders);
    for(const task of progress.tasks){
      const saved=tasks.find(t=>t.id===task.id)!;
      const plan=plans.find(p=>p.id===saved.planningVersionId);
      for(const run of task.runs)run.quality=quality.read(projectId,saved,runs.find(r=>r.id===run.id),plan,task.planCurrent);
      task.quality=task.runs.find(r=>r.id===task.latestRunId)?.quality??quality.read(projectId,saved,undefined,plan,task.planCurrent);
      const run=runs.find(r=>r.id===task.latestRunId);
      const project=this.store.projects().find(p=>p.id===projectId)!;
      const policy=this.qualityReaders.policy?.(projectId)??defaultCompletionPolicy(project.kind==='code'?'code':'general');
      let graph=selectedGraph;
      if(!graph&&this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_graph_revisions'").get()){
        const row=this.store.db.prepare('SELECT body FROM task_graph_revisions WHERE project_id=? AND planning_version_id=? ORDER BY revision DESC LIMIT 1').get(projectId,saved.planningVersionId);
        if(row)graph=JSON.parse(String(row.body));
      }
      let view;try{if(run?.workspaceId)view=this.qualityReaders.verification?.(run.workspaceId,run.id);}catch{/* Missing current files fail closed. */}
      let evidence:CompletionEvidence=run?quality.completionEvidence(task.quality,run,view):{quality:task.quality,bindings:{},checks:[],commands:[],loops:[],gateResults:[],approvals:[]};
      if(run&&this.qualityReaders.evidence)evidence=this.qualityReaders.evidence(evidence,run);
      let artifactId=run?.workspaceId??null,artifactDigest=view?.sourceDigest??null,inputSnapshotDigest:string|null=null;
      if(run&&!run.workspaceId)try{const snapshot=generalEvidenceSnapshot(this.store,run,()=>{throw Error('NO_MANIFEST');});artifactId=snapshot.artifactId;artifactDigest=snapshot.digest;inputSnapshotDigest=snapshot.space?.inputDigest??null;}catch{/* Never substitute project inventory for task outputs. */}
      const contracts=new Map<string,string>();for(const c of [...(graph?.nodes??[]),...(graph?.edges??[])].flatMap(n=>n.contracts??[]))contracts.set(c.id,c.digest);
      const binding:CompletionBinding=capturedCompletionBinding({projectId,taskId:saved.id,runId:run?.id??null,planningVersionId:plan?.id??null,planningContentHash:plan?.contentHash??null,acceptanceDigest:run?.acceptanceDigest??null,artifactId,artifactDigest},
        {graphRevision:graph&&graph.planningVersionId===saved.planningVersionId&&graph.nodes.some(n=>n.taskId===saved.id)?String(graph.revision):null,contractDigest:graph?digest([...contracts].map(([id,digest])=>({id,digest}))):null,
         policyDigest:completionPolicyDigest(policy),configDigest:run?.workspaceId?digest((view?.commands??[]).map(c=>({id:c.id,digest:c.configDigest}))):this.qualityReaders.checkerDigest??generalCheckerDigest(),
         artifactScope:project.kind==='code'?'workspace':'task_manifest',baseSha:this.store.workspaces().find(w=>w.id===run?.workspaceId)?.baseSha??null,inputSnapshotDigest});
      task.completion=evaluateTaskCompletion(evidence,policy,binding);
      if(!task.planCurrent||plan?.state!=='approved'||policy.projectKind!==project.kind){
        task.completion.qualityPassed=false;task.completion.verifiedDone=false;
        task.completion.reasonCodes.push('CQG_BASELINE_OR_PROJECT_KIND_CHANGED');
      }
    }
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
