import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import type {Projects} from './projects.ts';
import {AppError} from './errors.ts';
import {exact} from './studio.ts';
import {readVerificationConfiguration,verificationCommandPreviews,type VerificationConfiguration} from './verification-service.ts';
import {runVerification} from './verification.ts';
import {normalizeWorkflowDefinition,workflowStepOrder} from './workflow-definition.ts';
import type {WorkflowVersion,WorkflowView,WorkflowPreview,WorkflowRun,WorkflowStatus,SaveWorkflowInput,StartWorkflowInput,RecoverWorkflowInput} from '../shared/workflows.ts';

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const scope='서버 등록 명령만 순차 실행합니다. Codex sandbox 밖의 로컬 OS 권한이며 명령의 외부 부작용을 격리하지 않습니다. Git-visible 소스의 전후 일치만 확인하고 ignored 의존성·중간 변경 후 원복은 증명하지 않습니다. 실제 결과는 AI 완료·코드 리뷰 승인·병합과 별개입니다. AI/외부 서비스 단계와 예약 실행은 미연결입니다.';
const quarantined=(r:WorkflowRun)=>r.status==='lost'&&!r.recoveredAt;

/** Finite, explicitly approved local check sequences; not a native AI orchestrator. */
export class WorkflowService {
  private store:Store;private projects:Projects|undefined;private config:VerificationConfiguration[];
  private externalBusy:()=>boolean;private guard:(workspaceId:string)=>void;
  private pending:{id:string;workspaceId:string;abort:AbortController;promise:Promise<void>}|null=null;
  constructor(store:Store,projects:Projects|undefined,configuration:VerificationConfiguration[]=[],externalBusy:()=>boolean=()=>false,guard:(workspaceId:string)=>void=()=>{}){
    this.store=store;this.projects=projects;this.config=readVerificationConfiguration(JSON.stringify(configuration));this.externalBusy=externalBusy;this.guard=guard;
    store.db.exec('CREATE TABLE IF NOT EXISTS workflow_versions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,workflow_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,UNIQUE(workflow_id,revision)); CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workflow_receipts(id TEXT PRIMARY KEY,digest TEXT NOT NULL,operation TEXT NOT NULL,target_id TEXT NOT NULL);');
    for(const r of this.runs())if(r.status==='running')this.saveRun({...r,status:'lost',finishedAt:new Date().toISOString(),issue:'WORKFLOW_INTERRUPTED_BY_RESTART',steps:r.steps.map(s=>({...s,status:s.status==='running'?'lost':s.status==='pending'?'skipped':s.status}))});
  }
  get active(){return this.pending!==null;}
  private project(id:string){const p=this.store.projects().find(p=>p.id===id);if(!p)throw new AppError('PROJECT_NOT_FOUND',404);return p;}
  private versions(projectId:string):WorkflowVersion[]{return this.store.db.prepare('SELECT body FROM workflow_versions WHERE project_id=? ORDER BY rowid DESC').all(projectId).map(row=>JSON.parse(String(row.body)));}
  private version(id:string):WorkflowVersion{const row=this.store.db.prepare('SELECT body FROM workflow_versions WHERE id=?').get(id);if(!row)throw new AppError('WORKFLOW_NOT_FOUND',404);return JSON.parse(String(row.body));}
  private head(projectId:string,workflowId:string){const version=this.versions(projectId).find(v=>v.workflowId===workflowId);if(!version)throw new AppError('WORKFLOW_NOT_FOUND',404);return version;}
  private runs():WorkflowRun[]{return this.store.db.prepare('SELECT body FROM workflow_runs ORDER BY rowid DESC').all().map(row=>JSON.parse(String(row.body)));}
  record(id:string):WorkflowRun{const row=this.store.db.prepare('SELECT body FROM workflow_runs WHERE id=?').get(id);if(!row)throw new AppError('WORKFLOW_RUN_NOT_FOUND',404);return JSON.parse(String(row.body));}
  private commands(projectId:string){return verificationCommandPreviews(this.config,this.project(projectId).path);}
  ensureAvailable(workspaceId?:string){
    if(this.pending)throw new AppError('WORKFLOW_BUSY',409);
    if(workspaceId&&this.runs().some(r=>r.workspaceId===workspaceId&&quarantined(r)))throw new AppError('WORKFLOW_RECOVERY_REQUIRED',409);
  }
  private replay(operation:string,requestId:string,value:unknown):string|null{
    if(typeof requestId!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(requestId))throw new AppError('INVALID_REQUEST_ID',400);
    const row=this.store.db.prepare('SELECT * FROM workflow_receipts WHERE id=?').get(requestId);
    if(!row)return null;if(row.operation!==operation||row.digest!==hash(value))throw new AppError('IDEMPOTENCY_CONFLICT',409);return String(row.target_id);
  }
  private receipt(operation:string,requestId:string,value:unknown,target:string){this.store.db.prepare('INSERT INTO workflow_receipts VALUES(?,?,?,?)').run(requestId,hash(value),operation,target);}
  private writeRun(r:WorkflowRun){this.store.db.prepare('INSERT INTO workflow_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(r.id,r.projectId,JSON.stringify(r));this.store.append('workflow.'+r.status,null,{workflowRunId:r.id,projectId:r.projectId,workspaceId:r.workspaceId,status:r.status});}
  private saveRun(r:WorkflowRun){this.store.transaction(()=>this.writeRun(r));return r;}
  save(projectId:string,input:SaveWorkflowInput):WorkflowVersion{
    exact(input as unknown as Record<string,unknown>,['requestId','workflowId','expectedRevision','name','steps']);this.project(projectId);
    if(input.workflowId!==null&&!uuid(input.workflowId))throw new AppError('INVALID_FIELDS',400);
    if(input.workflowId===null?input.expectedRevision!==null:!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision!<1)throw new AppError('INVALID_FIELDS',400);
    const definition=normalizeWorkflowDefinition({name:input.name,steps:input.steps}),canonical={projectId,...input,name:definition.name,steps:definition.steps};
    const prior=this.replay('save',input.requestId,canonical);if(prior)return this.version(prior);
    const commands=this.commands(projectId);if(definition.steps.some(s=>!commands.some(c=>c.id===s.commandId)))throw new AppError('WORKFLOW_COMMAND_UNAVAILABLE',409);
    const versions=this.versions(projectId);if(versions.length>=100)throw new AppError('WORKFLOW_QUOTA',413);
    const head=input.workflowId?this.head(projectId,input.workflowId):null;
    if(head&&head.revision!==input.expectedRevision)throw new AppError('WORKFLOW_VERSION_CONFLICT',409);
    const version:WorkflowVersion={id:randomUUID(),workflowId:input.workflowId??randomUUID(),projectId,revision:(head?.revision??0)+1,definition,definitionDigest:hash(definition),createdAt:new Date().toISOString()};
    this.store.transaction(()=>{this.store.db.prepare('INSERT INTO workflow_versions VALUES(?,?,?,?,?)').run(version.id,projectId,version.workflowId,version.revision,JSON.stringify(version));this.receipt('save',input.requestId,canonical,version.id);this.store.append('workflow.saved',null,{projectId,workflowId:version.workflowId,versionId:version.id,revision:version.revision});});return version;
  }
  view(projectId:string,workspaceId:string|null):WorkflowView{
    this.project(projectId);if(workspaceId&&!this.store.workspaces().some(w=>w.id===workspaceId&&w.projectId===projectId))throw new AppError('WORKSPACE_MISMATCH',409);
    const runs=this.runs().filter(r=>r.projectId===projectId&&(!workspaceId||r.workspaceId===workspaceId));
    runs.sort((a,b)=>Number(quarantined(b))-Number(quarantined(a))||b.createdAt.localeCompare(a.createdAt));
    return {projectId,workspaceId,commands:this.commands(projectId),versions:this.versions(projectId),runs:runs.slice(0,20),busy:this.active||this.externalBusy(),recoveryRequired:runs.some(quarantined),scope};
  }
  preview(workspaceId:string,workflowId:string):WorkflowPreview{
    if(!this.projects)throw new AppError('WORKFLOW_UNAVAILABLE',404);this.ensureAvailable(workspaceId);this.guard(workspaceId);if(this.externalBusy())throw new AppError('WORKFLOW_BUSY',409);
    const workspace=this.projects.writable(workspaceId),version=this.head(workspace.projectId,workflowId),commands=this.commands(workspace.projectId);
    const definition=normalizeWorkflowDefinition(version.definition),order=workflowStepOrder(definition);
    const steps=order.map(id=>{const step=definition.steps.find(s=>s.id===id)!,command=commands.find(c=>c.id===step.commandId);if(!command)throw new AppError('WORKFLOW_COMMAND_UNAVAILABLE',409);return {...step,dependsOn:[...step.dependsOn],command};});
    const totalTimeoutMs=steps.reduce((sum,s)=>sum+s.command.timeoutMs,0);if(totalTimeoutMs>600000)throw new AppError('WORKFLOW_DURATION_LIMIT',409);
    const sourceDigest=this.projects.fingerprint(workspace.id),configDigest=hash(steps.map(s=>({id:s.id,configDigest:s.command.configDigest})));
    if(!digest(sourceDigest))throw new AppError('WORKFLOW_SOURCE_UNAVAILABLE',409);
    const facts={projectId:workspace.projectId,workspaceId,workflowId,versionId:version.id,definitionDigest:version.definitionDigest,sourceDigest,baseSha:workspace.baseSha,configDigest};
    return {...facts,previewDigest:hash(facts),name:definition.name,steps,totalTimeoutMs,scope};
  }
  start(input:StartWorkflowInput):WorkflowRun{
    exact(input as unknown as Record<string,unknown>,['requestId','workspaceId','workflowId','expectedVersionId','expectedPreviewDigest','confirmed','retryOfId']);
    if(![input.workspaceId,input.workflowId,input.expectedVersionId].every(uuid)||!digest(input.expectedPreviewDigest)||typeof input.confirmed!=='boolean'||input.retryOfId!==null&&!uuid(input.retryOfId))throw new AppError('INVALID_FIELDS',400);
    if(!input.confirmed)throw new AppError('WORKFLOW_CONFIRMATION_REQUIRED',409);
    const replay=this.replay('run',input.requestId,input);if(replay)return this.record(replay);
    const preview=this.preview(input.workspaceId,input.workflowId);
    if(preview.versionId!==input.expectedVersionId||preview.previewDigest!==input.expectedPreviewDigest)throw new AppError('WORKFLOW_PREVIEW_STALE',409);
    let attempt=1;
    if(input.retryOfId){const prior=this.record(input.retryOfId);
      if(prior.projectId!==preview.projectId||prior.workspaceId!==preview.workspaceId||prior.versionId!==preview.versionId||prior.sourceDigest!==preview.sourceDigest||prior.configDigest!==preview.configDigest||['running','passed','lost'].includes(prior.status)||quarantined(prior))throw new AppError('WORKFLOW_RETRY_CONTEXT',409);
      if(this.runs().some(r=>r.retryOfId===prior.id))throw new AppError('WORKFLOW_RETRY_SUPERSEDED',409);
      attempt=prior.attempt+1;if(attempt>3)throw new AppError('WORKFLOW_RETRY_LIMIT',409);
    }
    const all=this.runs().filter(r=>r.projectId===preview.projectId),bytes=all.reduce((sum,r)=>sum+Buffer.byteLength(JSON.stringify(r)),0);
    if(all.length>=100||bytes+12*8000*6+16384>32*1024*1024)throw new AppError('WORKFLOW_QUOTA',413);
    const r:WorkflowRun={id:randomUUID(),projectId:preview.projectId,workspaceId:preview.workspaceId,workflowId:preview.workflowId,versionId:preview.versionId,definitionDigest:preview.definitionDigest,sourceDigest:preview.sourceDigest,baseSha:preview.baseSha,configDigest:preview.configDigest,status:'running',steps:preview.steps.map(({command,...s})=>({...s,status:'pending',startedAt:null,finishedAt:null,exitCode:null,durationMs:null,output:'',truncated:false,sourceDigest:null,finishedDigest:null})),retryOfId:input.retryOfId,attempt,createdAt:new Date().toISOString(),finishedAt:null,recoveredAt:null,issue:null};
    this.store.transaction(()=>{this.writeRun(r);this.receipt('run',input.requestId,input,r.id);});
    const abort=new AbortController(),promise=Promise.resolve().then(()=>this.execute(r,preview,abort.signal)).finally(()=>{if(this.pending?.id===r.id)this.pending=null;});
    this.pending={id:r.id,workspaceId:r.workspaceId,abort,promise};return r;
  }
  private async execute(initial:WorkflowRun,preview:WorkflowPreview,signal:AbortSignal){
    let record=initial,status:WorkflowStatus='passed';
    try{
      for(let index=0;index<preview.steps.length;index++){
        if(signal.aborted){status='interrupted';break;}
        this.guard(record.workspaceId);const workspace=this.projects!.writable(record.workspaceId),step=preview.steps[index];
        if(workspace.baseSha!==record.baseSha||this.projects!.fingerprint(workspace.id)!==record.sourceDigest){status='stale';break;}
        record={...record,steps:record.steps.map((s,i)=>i===index?{...s,status:'running',startedAt:new Date().toISOString()}:s)};this.saveRun(record);
        const {configDigest:_,...command}=step.command;
        const result=await runVerification(command,{workspaceId:workspace.id,cwd:workspace.path,baseSha:workspace.baseSha,signal,fingerprint:()=>{const value=this.projects!.fingerprint(workspace.id);if(value!==record.sourceDigest)throw new Error('WORKFLOW_SOURCE_CHANGED');return value;}});
        record={...record,steps:record.steps.map((s,i)=>i===index?{...s,status:result.status,finishedAt:new Date().toISOString(),exitCode:result.exitCode,durationMs:result.durationMs,output:result.output.slice(0,8000),truncated:result.output.length>8000,sourceDigest:result.sourceDigest,finishedDigest:result.finishedDigest}:s)};this.saveRun(record);
        if(result.status!=='passed'){status=result.status;break;}
      }
    }catch{status=signal.aborted?'interrupted':'failed';}
    if(signal.aborted&&status==='passed')status='interrupted';
    this.saveRun({...record,status,finishedAt:new Date().toISOString(),issue:status==='passed'?null:'WORKFLOW_'+status.toUpperCase(),steps:record.steps.map(s=>s.status==='pending'?{...s,status:'skipped'}:s.status==='running'?{...s,status:status==='passed'?'failed':status,finishedAt:new Date().toISOString()}:s)});
  }
  interrupt(workspaceId:string,runId:string){const r=this.record(runId);if(r.workspaceId!==workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);if(r.status!=='running')return r;if(this.pending?.id!==runId)throw new AppError('WORKFLOW_RECOVERY_REQUIRED',409);this.pending.abort.abort();return r;}
  recover(input:RecoverWorkflowInput){
    exact(input as unknown as Record<string,unknown>,['runId','confirmedStopped']);if(!uuid(input.runId)||typeof input.confirmedStopped!=='boolean')throw new AppError('INVALID_FIELDS',400);
    if(!input.confirmedStopped)throw new AppError('WORKFLOW_CONFIRMATION_REQUIRED',409);if(this.pending||this.externalBusy())throw new AppError('WORKFLOW_BUSY',409);
    const r=this.record(input.runId);if(r.status!=='lost')throw new AppError('WORKFLOW_NOT_LOST',409);if(r.recoveredAt)return r;return this.saveRun({...r,recoveredAt:new Date().toISOString()});
  }
  async settle(){await this.pending?.promise;}
  async close(){this.pending?.abort.abort();await this.settle();}
}
