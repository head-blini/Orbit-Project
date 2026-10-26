import {createHash,randomUUID} from 'node:crypto';
import type {Projects} from './projects.ts';
import type {RpcPort} from './rpc.ts';
import type {Store} from './store.ts';
import {AppError} from './errors.ts';
import {safeText} from './privacy.ts';
import {terminal} from '../shared/types.ts';
import {buildReviewInput} from './review-input.ts';
import {runCodexReview} from './codex-review.ts';
import type {ReviewPreview,ReviewRecord,ReviewView,StartReviewInput,RecoverReviewInput} from '../shared/reviews.ts';

const timeoutMs=60000,turnLimit=1 as const;
const scope='명시적으로 미리 본 정제 Diff 텍스트만 별도의 읽기 전용 Codex 리뷰 세션에 보냅니다. 실제 파일 전체·실행 결과를 증명하지 않으며 리뷰 완료는 테스트 통과·사용자 승인·병합이 아닙니다. Native CLI의 세션 저장과 제공자 전송은 Model Hub 게이트웨이 통제 범위 밖입니다. 1개 리뷰 turn·60초 제한 뒤 종료 관찰 시간이 추가될 수 있으며 구독 사용량·실제 과금 상한은 보장하지 않습니다.';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quarantined=(record:ReviewRecord)=>record.execution!=='running'&&!record.processStopped&&!record.recoveredAt;
function exact(value:unknown,keys:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new AppError('INVALID_FIELDS',400);}
const publicIssue=(value:unknown)=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(value)?value:'REVIEW_FAILED';

/** Owns intent and evidence; the official native protocol remains in codex-review. */
export class ReviewService {
  private store:Store;private projects:Projects|undefined;private factory:(workspace:string,write:boolean)=>RpcPort;
  private externalBusy:()=>boolean;private guard:(workspaceId:string)=>void;private runner:typeof runCodexReview;
  private pending:{id:string;workspaceId:string;controller:AbortController;task:Promise<void>}|null=null;
  constructor(store:Store,projects:Projects|undefined,factory:(workspace:string,write:boolean)=>RpcPort,externalBusy:()=>boolean=()=>false,guard:(workspaceId:string)=>void=()=>{},runner:typeof runCodexReview=runCodexReview){
    this.store=store;this.projects=projects;this.factory=factory;this.externalBusy=externalBusy;this.guard=guard;this.runner=runner;
    store.db.exec('CREATE TABLE IF NOT EXISTS native_reviews(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,project_id TEXT NOT NULL,body TEXT NOT NULL);');
    for(const record of this.records())if(record.execution==='running')this.save({...record,execution:'lost',processStopped:false,recoveredAt:null,finishedAt:new Date().toISOString(),durationMs:null,issue:'REVIEW_INTERRUPTED_BY_RESTART'});
  }
  get active(){return this.pending!==null;}
  private records():ReviewRecord[]{return this.store.db.prepare('SELECT body FROM native_reviews ORDER BY rowid DESC').all().map(row=>JSON.parse(String(row.body)));}
  record(id:string):ReviewRecord {const row=this.store.db.prepare('SELECT body FROM native_reviews WHERE id=?').get(id);if(!row)throw new AppError('REVIEW_NOT_FOUND',404);return JSON.parse(String(row.body));}
  private save(record:ReviewRecord){
    this.store.transaction(()=>{this.store.db.prepare('UPDATE native_reviews SET body=? WHERE id=?').run(JSON.stringify(record),record.id);
      this.store.append('review.updated',null,{reviewId:record.id,projectId:record.projectId,workspaceId:record.workspaceId,execution:record.execution});});return record;
  }
  private context(workspaceId:string,runId:string|null){
    if(!uuid(workspaceId)||runId!==null&&!uuid(runId))throw new AppError('INVALID_FIELDS',400);
    const workspace=this.store.workspaces().find(value=>value.id===workspaceId);if(!workspace)throw new AppError('WORKSPACE_NOT_FOUND',404);
    const run=runId?this.store.getRun(runId):null;if(runId&&(!run||run.workspaceId!==workspaceId||!terminal(run.execution)))throw new AppError('REVIEW_RUN_NOT_TERMINAL',409);
    return workspace;
  }
  ensureAvailable(workspaceId?:string){
    if(this.pending)throw new AppError('REVIEW_BUSY',409);
    if(workspaceId&&this.records().some(record=>record.workspaceId===workspaceId&&quarantined(record)))throw new AppError('REVIEW_RECOVERY_REQUIRED',409);
  }
  view(workspaceId:string,runId:string|null):ReviewView {
    this.context(workspaceId,runId);
    const records=this.records().filter(record=>record.workspaceId===workspaceId);
    const ordered=[...records.filter(quarantined),...records.filter(record=>!quarantined(record))];
    let sourceDigest:string|null=null,sourceIssue:string|null=null;
    try{if(!this.projects)throw new Error();sourceDigest=this.projects.fingerprint(workspaceId);if(!digest(sourceDigest))throw new Error();}catch{sourceDigest=null;sourceIssue='REVIEW_SOURCE_UNAVAILABLE';}
    return {workspaceId,runId,records:ordered.slice(0,20),sourceDigest,sourceIssue,busy:this.active||this.externalBusy(),recoveryRequired:records.some(quarantined),timeoutMs,turnLimit,scope};
  }
  preview(workspaceId:string,runId:string|null):ReviewPreview {
    this.context(workspaceId,runId);this.ensureAvailable(workspaceId);this.guard(workspaceId);if(this.externalBusy())throw new AppError('REVIEW_BUSY',409);
    if(!this.projects)throw new AppError('REVIEW_UNAVAILABLE',404);
    const workspace=this.projects.writable(workspaceId),sourceDigest=this.projects.fingerprint(workspaceId),diff=this.projects.diff(workspaceId);
    if(!digest(sourceDigest)||this.projects.fingerprint(workspaceId)!==sourceDigest||diff.workspaceId!==workspaceId||diff.baseSha!==workspace.baseSha)throw new AppError('REVIEW_SOURCE_CHANGED',409);
    const input=buildReviewInput(diff),facts={policy:'orbit-native-review-v1',projectId:workspace.projectId,workspaceId,runId,baseSha:workspace.baseSha,sourceDigest,inputDigest:input.inputDigest,timeoutMs,turnLimit};
    return {projectId:workspace.projectId,workspaceId,runId,baseSha:workspace.baseSha,sourceDigest,inputDigest:input.inputDigest,previewDigest:hash(facts),
      instructions:input.instructions,files:input.files.map(file=>({...file})),patchBytes:input.patchBytes,timeoutMs,turnLimit,scope:scope+' '+input.scope};
  }
  start(input:StartReviewInput):ReviewRecord {
    exact(input,['requestId','workspaceId','runId','expectedPreviewDigest','confirmed']);
    if(typeof input.requestId!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(input.requestId)||!uuid(input.workspaceId)||input.runId!==null&&!uuid(input.runId)||!digest(input.expectedPreviewDigest)||typeof input.confirmed!=='boolean')throw new AppError('INVALID_FIELDS',400);
    if(!input.confirmed)throw new AppError('REVIEW_CONFIRMATION_REQUIRED',409);
    const requestDigest=hash({requestId:input.requestId,workspaceId:input.workspaceId,runId:input.runId,expectedPreviewDigest:input.expectedPreviewDigest,confirmed:input.confirmed});
    const prior=this.store.db.prepare('SELECT body,digest FROM native_reviews WHERE request_id=?').get(input.requestId);
    if(prior){if(prior.digest!==requestDigest)throw new AppError('IDEMPOTENCY_CONFLICT',409);return JSON.parse(String(prior.body));}
    const preview=this.preview(input.workspaceId,input.runId);if(preview.previewDigest!==input.expectedPreviewDigest)throw new AppError('REVIEW_PREVIEW_STALE',409);
    const record:ReviewRecord={id:randomUUID(),requestId:input.requestId,projectId:preview.projectId,workspaceId:input.workspaceId,runId:input.runId,baseSha:preview.baseSha,sourceDigest:preview.sourceDigest,finishedDigest:null,
      inputDigest:preview.inputDigest,previewDigest:preview.previewDigest,files:preview.files,execution:'running',response:'',issue:null,threadId:null,turnId:null,processStopped:false,recoveredAt:null,
      createdAt:new Date().toISOString(),finishedAt:null,durationMs:null,timeoutMs,turnLimit};
    this.store.transaction(()=>{
      const size=this.store.db.prepare('SELECT count(*) AS count,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM native_reviews WHERE project_id=?').get(record.projectId)!;
      if(Number(size.count)>=100||Number(size.bytes)+Buffer.byteLength(JSON.stringify(record))+64000*6+4096>16*1024*1024)throw new AppError('REVIEW_HISTORY_QUOTA',413);
      this.store.db.prepare('INSERT INTO native_reviews VALUES(?,?,?,?,?)').run(record.id,record.requestId,requestDigest,record.projectId,JSON.stringify(record));
      this.store.append('review.updated',null,{reviewId:record.id,projectId:record.projectId,workspaceId:record.workspaceId,execution:record.execution});
    });
    const controller=new AbortController(),task=Promise.resolve().then(()=>this.execute(record,preview.instructions,controller.signal)).finally(()=>{if(this.pending?.id===record.id)this.pending=null;});
    this.pending={id:record.id,workspaceId:record.workspaceId,controller,task};return record;
  }
  private async execute(record:ReviewRecord,instructions:string,signal:AbortSignal){
    const began=performance.now();let attempted=false;
    try{
      const workspace=this.projects!.writable(record.workspaceId);
      if(this.projects!.fingerprint(record.workspaceId)!==record.sourceDigest){this.save({...record,execution:'stale',issue:'REVIEW_SOURCE_CHANGED',processStopped:true,finishedAt:new Date().toISOString(),durationMs:0});return;}
      attempted=true;
      const result=await this.runner({workspacePath:workspace.path,instructions,timeoutMs,signal,onStarted:ids=>{
        const current=this.record(record.id);if(current.execution==='running')this.save({...current,threadId:ids.threadId,turnId:ids.turnId});
      }},this.factory);
      let finishedDigest:string|null=null;try{const value=this.projects!.fingerprint(record.workspaceId);if(digest(value))finishedDigest=value;}catch{/* Evidence remains unavailable. */}
      let execution=result.execution,issue=result.issue===null?null:publicIssue(result.issue),response='';
      if(typeof result.response==='string'&&result.response.length<=64000)response=safeText(result.response);
      else{execution='failed';issue='REVIEW_OUTPUT_LIMIT';}
      if(execution==='completed'&&!response.trim()){execution='failed';issue='REVIEW_RESULT_MISSING';}
      const finalExecution=!result.processStopped?'lost':execution==='completed'&&finishedDigest!==record.sourceDigest?'stale':execution;
      this.save({...this.record(record.id),execution:finalExecution,issue:!result.processStopped?'REVIEW_PROCESS_UNCERTAIN':finalExecution==='stale'?'REVIEW_SOURCE_CHANGED':issue,
        response,threadId:result.threadId,turnId:result.turnId,processStopped:result.processStopped,finishedDigest,finishedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-began)});
    }catch{this.save({...this.record(record.id),execution:attempted?'lost':'failed',issue:attempted?'REVIEW_PROCESS_UNCERTAIN':'REVIEW_SOURCE_UNAVAILABLE',processStopped:!attempted,finishedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-began)});}
  }
  interrupt(workspaceId:string,reviewId:string){const record=this.record(reviewId);if(record.workspaceId!==workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);if(this.pending?.id===reviewId)this.pending.controller.abort();return this.record(reviewId);}
  recover(input:RecoverReviewInput):ReviewRecord {
    exact(input,['reviewId','confirmedStopped']);if(!uuid(input.reviewId)||typeof input.confirmedStopped!=='boolean')throw new AppError('INVALID_FIELDS',400);
    if(!input.confirmedStopped)throw new AppError('REVIEW_STOP_CONFIRMATION_REQUIRED',409);
    const record=this.record(input.reviewId);if(record.execution==='running'||this.pending?.id===record.id)throw new AppError('REVIEW_RECOVERY_UNAVAILABLE',409);
    if(record.processStopped||record.recoveredAt)return record;
    return this.save({...record,recoveredAt:new Date().toISOString()});
  }
  async settle(){await this.pending?.task;}
  async close(){const pending=this.pending;if(pending){pending.controller.abort();await pending.task;}}
}
