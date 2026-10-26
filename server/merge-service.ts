import { createHash,randomUUID } from 'node:crypto';
import type { Store } from './store.ts';
import type { Projects } from './projects.ts';
import type { VerificationService } from './verification-service.ts';
import { AppError } from './errors.ts';
import { exact } from './studio.ts';
import { terminal } from '../shared/types.ts';
import type { MergeRecord,MergeView,PrepareMergeInput,ApplyMergeInput,RecoverMergeInput } from '../shared/merge.ts';
import * as nativeGit from './merge-git.ts';

type MergeOperations=Pick<typeof nativeGit,'inspectMergeTarget'|'prepareMergeCandidate'|'verifyMergeCandidate'|'applyMergeCandidate'|'observeMergeApplication'>;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const sha=(value:unknown):value is string=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const digest=(data:object)=>createHash('sha256').update(JSON.stringify(data,Object.keys(data).sort())).digest('hex');
const uncertain=(record:MergeRecord)=>record.phase==='apply'&&['applying','unknown','lost'].includes(record.status);
const scope='같은 base의 clean 대상 브랜치에만 fast-forward합니다. 원 worktree/index를 보존하고 hooks·서명·변환 필터를 실행하지 않습니다. 대상 파일과 브랜치가 변경됩니다. 외부 Git/편집기와 완전한 동시 변경 차단을 보장하지 않으며 실패 시 자동 reset·rollback·push하지 않습니다.';

/** Durable intent and authoritative approval gates; Git writes are a separate narrow boundary. */
export class MergeService {
  private store:Store;private projects:Projects|undefined;private verification:VerificationService;private externalBusy:()=>boolean;private git:MergeOperations;
  private working=false;
  constructor(store:Store,projects:Projects|undefined,verification:VerificationService,externalBusy:()=>boolean,git:MergeOperations=nativeGit){
    this.store=store;this.projects=projects;this.verification=verification;this.externalBusy=externalBusy;this.git=git;
    store.db.exec('CREATE TABLE IF NOT EXISTS merge_records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS merge_requests(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,record_id TEXT NOT NULL);');
    for(const record of this.records())if(record.status==='preparing'||record.status==='applying')this.save({...record,status:'lost',issue:'MERGE_INTERRUPTED_BY_RESTART'});
  }
  get active(){return this.working;}
  private records():MergeRecord[]{return this.store.db.prepare('SELECT body FROM merge_records ORDER BY rowid DESC').all().map(row=>JSON.parse(String(row.body)));}
  record(id:string):MergeRecord{
    const row=this.store.db.prepare('SELECT body FROM merge_records WHERE id=?').get(id);
    if(!row)throw new AppError('MERGE_NOT_FOUND',404);return JSON.parse(String(row.body));
  }
  ensureAvailable(workspaceId?:string){
    if(this.working)throw new AppError('MERGE_BUSY',409);
    const projectId=workspaceId?this.store.workspaces().find(item=>item.id===workspaceId)?.projectId:undefined;
    if(projectId&&this.records().some(record=>record.projectId===projectId&&uncertain(record)))throw new AppError('MERGE_RECOVERY_REQUIRED',409);
  }
  ensureProjectAvailable(projectId:string){
    this.ensureAvailable();if(this.records().some(record=>record.projectId===projectId&&uncertain(record)))throw new AppError('MERGE_RECOVERY_REQUIRED',409);
  }
  private save(record:MergeRecord){
    const next={...record,updatedAt:new Date().toISOString()};
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO merge_records VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(next.id,next.projectId,JSON.stringify(next));
      this.store.append('merge.'+next.status,next.runId,{mergeId:next.id,projectId:next.projectId,workspaceId:next.workspaceId,status:next.status,phase:next.phase});
    });return next;
  }
  private replay(operation:string,input:{requestId:string}){
    if(typeof input.requestId!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(input.requestId))throw new AppError('INVALID_REQUEST_ID',400);
    const expected=digest({operation,...input}),row=this.store.db.prepare('SELECT digest,record_id FROM merge_requests WHERE request_id=?').get(input.requestId);
    if(row){if(row.digest!==expected)throw new AppError('IDEMPOTENCY_CONFLICT',409);return this.record(String(row.record_id));}
    return null;
  }
  private intent(operation:string,input:{requestId:string},record:MergeRecord){
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO merge_records VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(record.id,record.projectId,JSON.stringify(record));
      this.store.db.prepare('INSERT INTO merge_requests VALUES(?,?,?)').run(input.requestId,digest({operation,...input}),record.id);
      this.store.append('merge.'+record.status,record.runId,{mergeId:record.id,projectId:record.projectId,workspaceId:record.workspaceId,status:record.status,phase:record.phase});
    });
  }
  private current(workspaceId:string,runId:string){
    if(!this.projects)throw new AppError('MERGE_UNAVAILABLE',404);
    const {workspace,project,scratchRoot}=this.projects.mergeContext(workspaceId),run=this.store.getRun(runId);
    if(!run||run.workspaceId!==workspace.id||workspace.projectId!==project.id||!terminal(run.execution))throw new AppError('MERGE_CONTEXT_MISMATCH',409);
    if(this.externalBusy()||this.verification.active)throw new AppError('MERGE_BUSY',409);
    const view=this.verification.view(workspaceId,runId);
    if(view.workspaceId!==workspaceId||view.runId!==runId||view.sourceIssue||view.quarantined||!view.approvalCurrent||!view.canApprove||!view.sourceDigest||!view.checkSetDigest||!view.approval
      ||view.approval.workspaceId!==workspaceId||view.approval.runId!==runId||view.approval.sourceDigest!==view.sourceDigest||view.approval.checkSetDigest!==view.checkSetDigest)
      throw new AppError('MERGE_VERIFICATION_REQUIRED',409);
    const target=this.git.inspectMergeTarget(project.path,workspace.baseSha);
    return {workspace,project,scratchRoot,view,target};
  }
  view(workspaceId:string,runId:string|null):MergeView{
    const workspace=this.store.workspaces().find(item=>item.id===workspaceId);if(!workspace)throw new AppError('WORKSPACE_NOT_READY',404);
    // Recovery must remain reachable when the latest Run differs or history exceeds 20.
    const records=this.records().filter(record=>record.workspaceId===workspaceId).sort((a,b)=>Number(uncertain(b))-Number(uncertain(a))||b.updatedAt.localeCompare(a.updatedAt));
    const recoveryRequired=this.records().some(record=>record.projectId===workspace.projectId&&uncertain(record));
    const result:MergeView={projectId:workspace.projectId,workspaceId,runId,available:false,issue:null,canPrepare:false,sourceDigest:null,checkSetDigest:null,approvalId:null,target:null,busy:this.working||this.externalBusy(),recoveryRequired,records:records.slice(0,20),scope};
    try{
      if(!runId)throw new AppError('MERGE_RUN_REQUIRED',409);
      const current=this.current(workspaceId,runId);
      Object.assign(result,{available:true,sourceDigest:current.view.sourceDigest,checkSetDigest:current.view.checkSetDigest,approvalId:current.view.approval!.id,target:current.target,canPrepare:!result.busy&&!recoveryRequired});
      if(recoveryRequired)result.issue='MERGE_RECOVERY_REQUIRED';
    }catch(error){result.issue=error instanceof AppError&&/^\w+$/.test(error.message)?error.message:'MERGE_UNAVAILABLE';}
    return result;
  }
  prepare(input:PrepareMergeInput):MergeRecord{
    exact(input as unknown as Record<string,unknown>,['requestId','workspaceId','runId','expectedSourceDigest','expectedCheckSetDigest','expectedApprovalId','expectedTargetBranch','expectedTargetHead']);
    if(!uuid(input.workspaceId)||!uuid(input.runId)||!uuid(input.expectedApprovalId)||!hash(input.expectedSourceDigest)||!hash(input.expectedCheckSetDigest)||!sha(input.expectedTargetHead)
      ||typeof input.expectedTargetBranch!=='string'||!input.expectedTargetBranch||input.expectedTargetBranch.length>200||/[\x00-\x1f\x7f]/.test(input.expectedTargetBranch))throw new AppError('INVALID_FIELDS',400);
    const prior=this.replay('prepare',input);if(prior)return prior;
    this.ensureAvailable(input.workspaceId);
    const current=this.current(input.workspaceId,input.runId);
    const matches=(value:ReturnType<MergeService['current']>)=>value.view.sourceDigest===input.expectedSourceDigest&&value.view.checkSetDigest===input.expectedCheckSetDigest&&value.view.approval!.id===input.expectedApprovalId&&value.target.branch===input.expectedTargetBranch&&value.target.head===input.expectedTargetHead;
    if(!matches(current))throw new AppError('MERGE_PREVIEW_STALE',409);
    if(this.records().filter(record=>record.projectId===current.project.id).length>=100)throw new AppError('MERGE_QUOTA',413);
    const snapshot=this.projects!.snapshot(input.workspaceId);if(snapshot.sourceDigest!==input.expectedSourceDigest)throw new AppError('MERGE_PREVIEW_STALE',409);
    const now=new Date().toISOString();let record:MergeRecord={id:randomUUID(),projectId:current.project.id,workspaceId:input.workspaceId,runId:input.runId,sourceDigest:input.expectedSourceDigest,checkSetDigest:input.expectedCheckSetDigest,approvalId:input.expectedApprovalId,target:current.target,candidate:null,phase:'prepare',status:'preparing',issue:null,completionBasis:null,createdAt:now,updatedAt:now};
    this.working=true;
    try{
      this.intent('prepare',input,record);
      const candidate=this.git.prepareMergeCandidate(current.project.path,current.workspace.baseSha,snapshot,record.id,current.scratchRoot);
      record={...record,candidate};this.git.verifyMergeCandidate(current.project.path,current.workspace.baseSha,snapshot,candidate);
      if(!matches(this.current(input.workspaceId,input.runId)))throw new AppError('MERGE_PREVIEW_STALE',409);
      return this.save({...record,status:'prepared'});
    }catch{return this.save({...record,status:'failed',issue:'MERGE_PREPARATION_FAILED'});}
    finally{this.working=false;}
  }
  apply(input:ApplyMergeInput):MergeRecord{
    exact(input as unknown as Record<string,unknown>,['requestId','recordId','expectedCommitSha','confirmed']);
    if(!uuid(input.recordId)||!sha(input.expectedCommitSha)||typeof input.confirmed!=='boolean')throw new AppError('INVALID_FIELDS',400);
    if(!input.confirmed)throw new AppError('MERGE_CONFIRMATION_REQUIRED',409);
    const prior=this.replay('apply',input);if(prior)return prior;
    const record=this.record(input.recordId);this.ensureAvailable(record.workspaceId);
    if(record.status!=='prepared'||!record.candidate||record.candidate.commitSha!==input.expectedCommitSha)throw new AppError('MERGE_PREVIEW_STALE',409);
    const assertCurrent=()=>{
      const current=this.current(record.workspaceId,record.runId);
      if(current.view.sourceDigest!==record.sourceDigest||current.view.checkSetDigest!==record.checkSetDigest||current.view.approval!.id!==record.approvalId
        ||current.target.branch!==record.target.branch||current.target.head!==record.target.head||current.target.treeSha!==record.target.treeSha)throw new AppError('MERGE_PREVIEW_STALE',409);
      return current;
    };
    const current=assertCurrent();
    const snapshot=this.projects!.snapshot(record.workspaceId);if(snapshot.sourceDigest!==record.sourceDigest)throw new AppError('MERGE_PREVIEW_STALE',409);
    this.git.verifyMergeCandidate(current.project.path,current.workspace.baseSha,snapshot,record.candidate);
    assertCurrent();
    this.working=true;
    try{
      this.intent('apply',input,{...record,phase:'apply',status:'applying',updatedAt:new Date().toISOString()});
      this.git.applyMergeCandidate(current.project.path,record.target,record.candidate);
      return this.save({...record,phase:'apply',status:'applied',issue:null,completionBasis:'git_and_bytes'});
    }catch{return this.save({...record,phase:'apply',status:'unknown',issue:'MERGE_APPLY_UNCERTAIN',completionBasis:null});}
    finally{this.working=false;}
  }
  recover(input:RecoverMergeInput):MergeRecord{
    exact(input as unknown as Record<string,unknown>,['recordId','confirmedStopped']);
    if(!uuid(input.recordId)||typeof input.confirmedStopped!=='boolean')throw new AppError('INVALID_FIELDS',400);
    if(!input.confirmedStopped)throw new AppError('MERGE_CONFIRMATION_REQUIRED',409);
    if(this.working||this.externalBusy()||this.verification.active)throw new AppError('MERGE_BUSY',409);
    const record=this.record(input.recordId);
    if(!['lost','unknown','applying'].includes(record.status))return record;
    if(record.phase==='prepare')return this.save({...record,status:'failed',issue:'MERGE_PREPARATION_INTERRUPTED'});
    let observed:'applied'|'not_applied'|'unknown'='unknown';
    try{if(this.projects&&record.candidate)observed=this.git.observeMergeApplication(this.projects.mergeProject(record.projectId).path,record.target,record.candidate);}catch{/* preserve unknown without raw diagnostics */}
    return this.save({...record,status:observed==='applied'?'applied':observed==='not_applied'?'failed':'unknown',issue:observed==='applied'?null:observed==='not_applied'?'MERGE_NOT_APPLIED':'MERGE_RECOVERY_UNCERTAIN',completionBasis:observed==='applied'?'observed_after_recovery':null});
  }
}
