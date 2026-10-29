import {listMaterials} from './materials.ts';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Projects} from './projects.ts';
import type {RpcPort} from './rpc.ts';
import type {Store} from './store.ts';
import type {PlanningDraft,PlanningVersion} from '../shared/parallel.ts';
import type {PlanningAgentPreview,PlanningAgentView,PlanningSuggestion,StartPlanningSuggestionInput} from '../shared/planning-agent.ts';
import {AppError} from './errors.ts';
import {Studio} from './studio.ts';
import {runCodexPlanning} from './codex-planning.ts';
import {runClaudePlanning,type ClaudePlanningOptions} from './claude-planning.ts';
import {ProjectAiPreferencesService} from './project-ai-preferences.ts';
import type {ProjectAiRuntime} from '../shared/project-ai-preferences.ts';
import {buildPlanningPrompt,buildClaudePlanningPrompt,planningOutputSchema} from './planning/agent-input.ts';
import {normalizeStoredPlanningDraft} from './planning/parser.ts';
import {serializePlanningExport} from './planning/export.ts';

const timeoutMs=60000,turnLimit=1 as const;
const scope=(runtime:ProjectAiRuntime)=>`미리 본 요청을 별도의 읽기 전용 ${runtime==='codex'?'Codex':'Claude Code'} 세션에 전송합니다. Native CLI는 읽기 전용이어도 파일을 읽을 수 있으며 컨텍스트 로딩·세션 보존·제공자 전송은 Model Hub 게이트웨이 통제 범위 밖입니다. 1개 요청·60초 제한 뒤 종료 관찰 시간이 추가될 수 있습니다. 구독 사용량·실제 과금 상한은 보장하지 않습니다. 검증된 제안도 별도 저장 전에는 기획 초안이 아니며 승인·Task·Run을 만들지 않습니다.`;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quarantined=(record:PlanningSuggestion)=>record.execution!=='running'&&!record.processStopped&&!record.recoveredAt;
function exact(value:unknown,keys:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new AppError('INVALID_FIELDS',400);}
const publicIssue=(value:unknown)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(value)?value:'PLANNING_FAILED';
function checkedProposal(proposal:PlanningDraft|null,runtime:ProjectAiRuntime):PlanningDraft {
  try{
    if(!proposal||Buffer.byteLength(JSON.stringify(proposal),'utf8')>256*1024)throw new Error();
    const parsed=normalizeStoredPlanningDraft(proposal);
    if(!parsed.ok||!isDeepStrictEqual(parsed.draft,proposal)||proposal.source!=='import'
      ||!isDeepStrictEqual(proposal.provenance,{kind:'in_app_agent',providerId:runtime,externalUrl:null}))throw new Error();
    serializePlanningExport(proposal,'json');return structuredClone(proposal);
  }catch{throw new AppError('PLANNING_PROPOSAL_INVALID',422);}
}

/** Durable launch/save receipts. Raw requests and rejected output are never stored. */
export class PlanningAgentService {
  private store:Store;private projects:Projects|undefined;private factory:(workspace:string,write:boolean)=>RpcPort;
  private externalBusy:(projectId:string)=>boolean;private guard:(workspaceId:string)=>void;private runner:typeof runCodexPlanning;private studio:Studio;
  private preferences:ProjectAiPreferencesService;private claudeOptions:ClaudePlanningOptions;
  private pending:{id:string;workspaceId:string|null;controller:AbortController;task:Promise<void>}|null=null;
  private unpersisted=new Map<string,PlanningSuggestion>();
  constructor(store:Store,projects:Projects|undefined,factory:(workspace:string,write:boolean)=>RpcPort,externalBusy:(projectId:string)=>boolean=()=>false,guard:(workspaceId:string)=>void=()=>{},runner:typeof runCodexPlanning=runCodexPlanning,claudeOptions:ClaudePlanningOptions={}){
    this.store=store;this.projects=projects;this.factory=factory;this.externalBusy=externalBusy;this.guard=guard;this.runner=runner;this.studio=new Studio(store);
    this.preferences=new ProjectAiPreferencesService(store);this.claudeOptions=claudeOptions;
    store.db.exec('CREATE TABLE IF NOT EXISTS planning_suggestions(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,project_id TEXT NOT NULL,body TEXT NOT NULL);');
    for(const record of this.records())if(record.execution==='running')this.save({...record,execution:'lost',proposal:null,outputDigest:null,processStopped:false,recoveredAt:null,finishedAt:new Date().toISOString(),durationMs:null,issue:'PLANNING_INTERRUPTED_BY_RESTART'});
  }
  get active(){return this.pending!==null;}
  /** Narrow read-only projection of the persistence-failure quarantine. */
  analyticsOverlay(id:string){const value=this.unpersisted.get(id);return value?{execution:value.execution,finishedAt:value.finishedAt,durationMs:value.durationMs}:null;}
  private decode(body:unknown):PlanningSuggestion{return {runtime:'codex',...JSON.parse(String(body))};}
  private records():PlanningSuggestion[]{return this.store.db.prepare('SELECT body FROM planning_suggestions ORDER BY rowid DESC').all().map(row=>{const record=this.decode(row.body);return structuredClone(this.unpersisted.get(record.id)??record);});}
  record(id:string):PlanningSuggestion {if(!uuid(id))throw new AppError('INVALID_FIELDS',400);const pending=this.unpersisted.get(id);if(pending)return structuredClone(pending);const row=this.store.db.prepare('SELECT body FROM planning_suggestions WHERE id=?').get(id);if(!row)throw new AppError('PLANNING_SUGGESTION_NOT_FOUND',404);return this.decode(row.body);}
  private save(record:PlanningSuggestion){
    this.store.transaction(()=>{this.store.db.prepare('UPDATE planning_suggestions SET body=? WHERE id=?').run(JSON.stringify(record),record.id);this.audit(record);});this.unpersisted.delete(record.id);return record;
  }
  private audit(record:PlanningSuggestion){this.store.append('planning_suggestion.updated',null,{suggestionId:record.id,projectId:record.projectId,workspaceId:record.workspaceId,runtime:record.runtime,execution:record.execution,savedPlanningVersionId:record.savedPlanningVersionId});}
  private context(projectId:string,workspaceId?:string|null){
    if(!uuid(projectId))throw new AppError('INVALID_FIELDS',400);
    const project=this.store.projects().find(project=>project.id===projectId);if(!project)throw new AppError('PROJECT_NOT_FOUND',404);
    if(project.kind==='general'){if(workspaceId!==null&&workspaceId!==undefined)throw new AppError('GIT_REQUIRED',409);return null;}
    if(!uuid(workspaceId))throw new AppError('INVALID_FIELDS',400);
    const workspace=this.store.workspaces().find(value=>value.id===workspaceId);if(!workspace)throw new AppError('WORKSPACE_NOT_FOUND',404);
    if(workspace.projectId!==projectId)throw new AppError('WORKSPACE_MISMATCH',409);return workspace;
  }
  private owned(projectId:string,id:string,workspaceId?:string|null){const record=this.record(id);if(record.projectId!==projectId||record.workspaceId!==(workspaceId??null))throw new AppError('WORKSPACE_MISMATCH',409);this.context(projectId,workspaceId);return record;}
  private validated(projectId:string,workspaceId?:string|null){
    const context=this.context(projectId,workspaceId);if(!this.projects)throw new AppError('PLANNING_UNAVAILABLE',404);
    if(!context){
      const project=this.projects.generalProject(projectId);
      // Planning reads with cwd at the project folder; a registered user folder has no isolated planning space yet.
      if(this.projects.isRegisteredFolder(projectId))throw new AppError('ISOLATION_REQUIRED',409);
      return {id:null,path:project.path,baseSha:null};
    }
    const workspace=this.projects.validate(context.id);if(workspace.projectId!==projectId)throw new AppError('WORKSPACE_MISMATCH',409);return workspace;
  }
  private selection(projectId:string){const preferences=this.preferences.read(projectId);return {runtime:this.store.projects().find(project=>project.id===projectId)?.kind==='general'?'claude-code' as const:preferences.planning,preferencesRevision:preferences.revision};}
  private previewHash(projectId:string,workspace:{id:string|null;path:string;baseSha:string|null},inputDigest:string,runtime:ProjectAiRuntime,preferencesRevision:number){
    // Material contents bind the preview: replacing a material makes an approved preview stale.
    const materials=workspace.id===null?listMaterials(workspace.path).map(({path,sha256})=>({path,sha256})):[];
    return hash({policy:'orbit-native-planning-v2',schema:planningOutputSchema,projectId,workspaceId:workspace.id,path:workspace.path,baseSha:workspace.baseSha,inputDigest,materials,runtime,preferencesRevision,timeoutMs,turnLimit});
  }
  ensureAvailable(workspaceId?:string){
    if(this.pending)throw new AppError('PLANNING_BUSY',409);
    if(workspaceId&&this.records().some(record=>(record.workspaceId===workspaceId||record.workspaceId===null&&record.projectId===workspaceId)&&quarantined(record)))throw new AppError('PLANNING_RECOVERY_REQUIRED',409);
  }
  view(projectId:string,workspaceId?:string|null):PlanningAgentView {
    this.context(projectId,workspaceId);const records=this.records().filter(record=>record.projectId===projectId&&record.workspaceId===(workspaceId??null)),{runtime}=this.selection(projectId);
    return {projectId,workspaceId:workspaceId??null,runtime,records:[...records.filter(quarantined),...records.filter(record=>!quarantined(record))],busy:this.active||this.externalBusy(projectId),recoveryRequired:records.some(quarantined),timeoutMs,turnLimit,scope:scope(runtime)};
  }
  preview(projectId:string,input:{workspaceId?:string|null;text:string}):PlanningAgentPreview {
    exact(input,Object.hasOwn(input??{},'workspaceId')?['workspaceId','text']:['text']);this.context(projectId,input.workspaceId);this.ensureAvailable(input.workspaceId??projectId);if(input.workspaceId)this.guard(input.workspaceId);
    if(this.externalBusy(projectId))throw new AppError('PLANNING_BUSY',409);if(!this.projects)throw new AppError('PLANNING_UNAVAILABLE',404);
    const workspace=this.validated(projectId,input.workspaceId),selection=this.selection(projectId),prompt=selection.runtime==='claude-code'?buildClaudePlanningPrompt(input.text,workspace.id===null?listMaterials(workspace.path).map(item=>item.path):[]):buildPlanningPrompt(input.text);
    return {projectId,workspaceId:workspace.id,...selection,...prompt,previewDigest:this.previewHash(projectId,workspace,prompt.inputDigest,selection.runtime,selection.preferencesRevision),timeoutMs,turnLimit,scope:scope(selection.runtime)};
  }
  start(projectId:string,input:StartPlanningSuggestionInput):PlanningSuggestion {
    exact(input,['requestId','text','expectedPreviewDigest','confirmed',...(Object.hasOwn(input??{},'workspaceId')?['workspaceId']:[])]);
    if(typeof input.requestId!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(input.requestId)||!digest(input.expectedPreviewDigest)||typeof input.confirmed!=='boolean')throw new AppError('INVALID_FIELDS',400);
    this.context(projectId,input.workspaceId);const prompt=buildPlanningPrompt(input.text);if(!input.confirmed)throw new AppError('PLANNING_CONFIRMATION_REQUIRED',409);
    const requestDigest=hash({projectId,requestId:input.requestId,workspaceId:input.workspaceId??null,inputDigest:prompt.inputDigest,expectedPreviewDigest:input.expectedPreviewDigest,confirmed:true});
    const prior=this.store.db.prepare('SELECT body,digest FROM planning_suggestions WHERE request_id=?').get(input.requestId);
    if(prior){if(prior.digest!==requestDigest)throw new AppError('IDEMPOTENCY_CONFLICT',409);return this.record((JSON.parse(String(prior.body)) as PlanningSuggestion).id);}
    const preview=this.preview(projectId,{workspaceId:input.workspaceId,text:input.text});if(preview.previewDigest!==input.expectedPreviewDigest)throw new AppError('PLANNING_PREVIEW_STALE',409);
    const record:PlanningSuggestion={id:randomUUID(),requestId:input.requestId,projectId,workspaceId:input.workspaceId??null,runtime:preview.runtime,preferencesRevision:preview.preferencesRevision,inputDigest:preview.inputDigest,previewDigest:preview.previewDigest,
      execution:'running',proposal:null,outputDigest:null,issue:null,threadId:null,turnId:null,processStopped:false,recoveredAt:null,createdAt:new Date().toISOString(),finishedAt:null,durationMs:null,timeoutMs,turnLimit,savedPlanningVersionId:null};
    this.store.transaction(()=>{
      const size=this.store.db.prepare('SELECT count(*) AS count,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM planning_suggestions WHERE project_id=?').get(projectId)!;
      if(Number(size.count)>=100||Number(size.bytes)+Buffer.byteLength(JSON.stringify(record))+256*1024+4096>16*1024*1024)throw new AppError('PLANNING_HISTORY_QUOTA',413);
      this.store.db.prepare('INSERT INTO planning_suggestions VALUES(?,?,?,?,?)').run(record.id,record.requestId,requestDigest,projectId,JSON.stringify(record));this.audit(record);
    });
    const controller=new AbortController(),task=Promise.resolve().then(()=>this.execute(record,preview.instructions,controller.signal)).catch(()=>{
      // The durable intent remains running if storage fails. Keep an in-memory
      // quarantine now; a restart will recover that durable intent as lost.
      this.unpersisted.set(record.id,{...record,execution:'lost',proposal:null,outputDigest:null,processStopped:false,issue:'PLANNING_PERSISTENCE_UNCERTAIN',finishedAt:new Date().toISOString()});
    }).finally(()=>{if(this.pending?.id===record.id)this.pending=null;});
    this.pending={id:record.id,workspaceId:record.workspaceId,controller,task};return record;
  }
  private async execute(record:PlanningSuggestion,instructions:string,signal:AbortSignal){
    const began=performance.now();let attempted=false;
    try{
      const workspace=this.validated(record.projectId,record.workspaceId),runtime=record.runtime??'codex';
      // Rebind the actual launch to the exact context shown in the preview.
      const current=this.previewHash(record.projectId,workspace,record.inputDigest,runtime,record.preferencesRevision??0);
      if(current!==record.previewDigest)throw new Error();attempted=true;
      const input={workspacePath:workspace.path,instructions,timeoutMs,signal,onStarted:(ids:{threadId:string;turnId:string})=>{this.save({...this.record(record.id),threadId:ids.threadId,turnId:ids.turnId});}};
      const result=await (runtime==='claude-code'?runClaudePlanning(input,{...this.claudeOptions,beforeDispatch:()=>{
        const latest=this.validated(record.projectId,record.workspaceId),selection=this.selection(record.projectId);
        if(record.workspaceId)this.guard(record.workspaceId);
        if(signal.aborted||this.previewHash(record.projectId,latest,record.inputDigest,selection.runtime,selection.preferencesRevision)!==record.previewDigest)throw new Error('PLANNING_PREVIEW_STALE');
        this.claudeOptions.beforeDispatch?.();
      }}):this.runner(input,this.factory));
      let execution=result.execution,issue=result.issue===null?null:publicIssue(result.issue),proposal:PlanningDraft|null=null;
      if(!['completed','failed','interrupted','timed_out','lost'].includes(execution)){execution='failed';issue='PLANNING_FAILED';}
      if(result.processStopped!==true){execution='lost';issue='PLANNING_PROCESS_UNCERTAIN';}
      else if(execution==='completed')try{proposal=checkedProposal(result.proposal,runtime);}catch{execution='failed';issue='PLANNING_PROPOSAL_INVALID';}
      this.save({...this.record(record.id),execution,issue,proposal,outputDigest:proposal?hash(proposal):null,threadId:result.threadId,turnId:result.turnId,processStopped:result.processStopped===true,finishedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-began)});
    }catch{this.save({...this.record(record.id),execution:attempted?'lost':'failed',proposal:null,outputDigest:null,issue:attempted?'PLANNING_PROCESS_UNCERTAIN':'PLANNING_WORKSPACE_CHANGED',processStopped:!attempted,finishedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-began)});}
  }
  interrupt(projectId:string,id:string,workspaceId?:string|null){this.owned(projectId,id,workspaceId);if(this.pending?.id===id)this.pending.controller.abort();return this.record(id);}
  recover(projectId:string,input:{workspaceId?:string|null;suggestionId:string;confirmedStopped:boolean}):PlanningSuggestion {
    exact(input,['suggestionId','confirmedStopped',...(Object.hasOwn(input??{},'workspaceId')?['workspaceId']:[])]);if(typeof input.confirmedStopped!=='boolean')throw new AppError('INVALID_FIELDS',400);
    const record=this.owned(projectId,input.suggestionId,input.workspaceId);if(!input.confirmedStopped)throw new AppError('PLANNING_STOP_CONFIRMATION_REQUIRED',409);
    if(record.execution==='running'||this.pending?.id===record.id)throw new AppError('PLANNING_RECOVERY_UNAVAILABLE',409);
    if(record.processStopped||record.recoveredAt)return record;return this.save({...record,recoveredAt:new Date().toISOString()});
  }
  saveDraft(projectId:string,id:string,input:{workspaceId?:string|null;expectedOutputDigest:string}):PlanningVersion {
    exact(input,['expectedOutputDigest',...(Object.hasOwn(input??{},'workspaceId')?['workspaceId']:[])]);const record=this.owned(projectId,id,input.workspaceId);
    if(!digest(input.expectedOutputDigest))throw new AppError('INVALID_FIELDS',400);
    if(record.execution!=='completed'||!record.processStopped||!record.proposal)throw new AppError('PLANNING_PROPOSAL_UNAVAILABLE',409);
    const proposal=checkedProposal(record.proposal,record.runtime??'codex');if(hash(proposal)!==record.outputDigest||record.outputDigest!==input.expectedOutputDigest)throw new AppError('PLANNING_PROPOSAL_STALE',409);
    // Studio commits its own receipt first. A crash before linking is safely retried
    // with this deterministic key; nesting these Store transactions is forbidden.
    const version=this.studio.mutate(projectId,'plans',undefined,undefined,{requestId:'planning-'+id,input:{format:'json',source:'import',text:serializePlanningExport(proposal,'json').text}}) as PlanningVersion;
    if(record.savedPlanningVersionId!==version.id)this.save({...record,savedPlanningVersionId:version.id});return version;
  }
  async settle(){await this.pending?.task;}
  async close(){const pending=this.pending;if(pending){pending.controller.abort();await pending.task;}}
}
