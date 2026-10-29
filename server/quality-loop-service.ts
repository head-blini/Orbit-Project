import {createHash,randomUUID} from 'node:crypto';
import type {Run} from '../shared/types.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {QualityLoopInput,QualityLoopResult} from '../shared/quality-loop.ts';
import type {QualityLoopRecord,QualityLoopPreview,QualityLoopStart,QualityServicePorts,QualitySelection,QualityStep,QualityStepContext,QualityModelEvidence,QualityVerificationResult,QualityRepairResult} from '../shared/quality-loop-record.ts';
import {Store} from './store.ts';
import {Studio} from './studio.ts';
import {buildExecutionBrief} from './planning/execution.ts';
import {AppError} from './errors.ts';
import {qualityEvidenceBlocked,runQualityLoop} from './quality-loop.ts';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=<T>(value:T):T=>structuredClone(value);
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const provider=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(value)&&value!=='unknown';
const model=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=160&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value)&&value.toLowerCase()!=='unknown';
const exact=(value:unknown,keys:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const modelKey=(e:QualityModelEvidence)=>e.source==='native_observed'&&provider(e.providerId)&&model(e.modelId)&&e.sessionId&&e.runId?`${e.providerId}/${e.modelId}`:null;
const issue=(error:unknown)=>error instanceof Error&&/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)?error.message:'QUALITY_STEP_FAILED';
const emptyVerification=():QualityVerificationResult=>({status:'unknown',checkIds:[],issue:'QUALITY_VERIFICATION_NOT_RUN'});

/** Durable intents surround the existing policy loop. Replay consumes saved results, never re-dispatches a recorded intent. */
export class QualityLoopService {
  private pending=new Map<string,Promise<void>>();
  private controllers=new Map<string,AbortController>();private recovering=false;private starting=false;private recoveryFinished:Promise<void>|null=null;
  private store:Store;private ports:QualityServicePorts;private studio:Studio;
  constructor(store:Store,ports:QualityServicePorts){
    this.store=store;this.ports=ports;this.studio=new Studio(store);
    store.db.exec('CREATE TABLE IF NOT EXISTS quality_loops(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request_digest TEXT NOT NULL,project_id TEXT NOT NULL,body TEXT NOT NULL)');
    for(const record of this.records())if(['reviewing','repairing'].includes(record.result.status)||record.steps.some(step=>step.state==='intent')){
      record.recoveryRequired=true;record.result.status='blocked';record.result.issue='QUALITY_RESTART_RECOVERY_REQUIRED';this.save(record);
    }
  }
  get active(){return this.pending.size>0||this.recovering||this.starting;}
  records(projectId?:string):QualityLoopRecord[]{return this.store.db.prepare('SELECT body FROM quality_loops ORDER BY rowid DESC').all().map(row=>JSON.parse(String(row.body)) as QualityLoopRecord).filter(record=>!projectId||record.projectId===projectId);}
  record(loopId:string):QualityLoopRecord{const row=this.store.db.prepare('SELECT body FROM quality_loops WHERE id=?').get(loopId);if(!row)throw new AppError('QUALITY_LOOP_NOT_FOUND',404);return JSON.parse(String(row.body));}
  ensureAvailable(projectId?:string){if(this.active)throw new AppError('QUALITY_LOOP_BUSY');if(this.records(projectId).some(r=>r.recoveryRequired))throw new AppError('QUALITY_RECOVERY_REQUIRED');}
  private save(record:QualityLoopRecord){
    record.updatedAt=new Date().toISOString();
    this.store.transaction(()=>{this.store.db.prepare('UPDATE quality_loops SET body=? WHERE id=?').run(JSON.stringify(record),record.id);this.store.append('quality.updated',record.sourceRunId,{projectId:record.projectId,qualityLoopId:record.id,status:record.result.status,round:record.result.rounds.length,issue:record.result.issue});});
  }
  private source(projectId:string,runId:string){
    const run=this.store.getRun(runId);if(!run)throw new AppError('RUN_NOT_FOUND',404);
    const runProject=run.projectId??this.store.workspaces().find(w=>w.id===run.workspaceId)?.projectId;
    if(runProject!==projectId||run.execution!=='completed'||!run.taskId||!run.planningVersionId||!run.planningContentHash)throw new AppError('QUALITY_SOURCE_INVALID');
    const version=(this.studio.read(projectId,'plans') as PlanningVersion[]).find(v=>v.id===run.planningVersionId);
    const task=(this.studio.read(projectId,'tasks') as SavedTask[]).find(t=>t.id===run.taskId);
    if(!version||!task)throw new AppError('QUALITY_BASELINE_UNAVAILABLE');
    const brief=buildExecutionBrief(task,version);
    if(brief.planningContentHash!==run.planningContentHash||JSON.stringify(brief.requirementLabels)!==JSON.stringify(run.requirementLabels))throw new AppError('QUALITY_BASELINE_CHANGED');
    return {run,version,task};
  }
  preview(projectId:string,sourceRunId:string,reviewers:QualitySelection[],limits:QualityLoopInput['limits']):QualityLoopPreview{
    if(!id(projectId)||!id(sourceRunId)||!Array.isArray(reviewers)||reviewers.length<1||reviewers.length>5||reviewers.some(r=>!exact(r,['id','providerId','modelId'])||!id(r.id)||!provider(r.providerId)||!model(r.modelId))||new Set(reviewers.map(r=>r.id)).size!==reviewers.length)throw new AppError('INVALID_FIELDS',400);
    if(!exact(limits,['maxRepairs','maxCalls','timeoutMs'])||!Number.isSafeInteger(limits.maxRepairs)||limits.maxRepairs<0||limits.maxRepairs>20||!Number.isSafeInteger(limits.maxCalls)||limits.maxCalls<1||limits.maxCalls>100||!Number.isSafeInteger(limits.timeoutMs)||limits.timeoutMs<1||limits.timeoutMs>3600000)throw new AppError('QUALITY_LIMITS_INVALID',400);
    const {run,version,task}=this.source(projectId,sourceRunId),snapshot=this.ports.snapshot(run);
    if(!snapshot.artifact.id||!digest(snapshot.artifact.digest))throw new AppError('QUALITY_ARTIFACT_UNAVAILABLE');
    const baseline={id:version.id,digest:version.contentHash,criteria:[...task.acceptanceCriteria]};
    const value={projectId,sourceRunId,taskId:task.id,baseline,version,task,...snapshot,reviewers:clone(reviewers),limits:clone(limits)};
    return {...value,previewDigest:hash(value)};
  }
  start(input:QualityLoopStart):QualityLoopRecord{
    if(!exact(input,['requestId','projectId','sourceRunId','reviewers','limits','expectedPreviewDigest','confirmed'])||typeof input.requestId!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(input.requestId)||input.confirmed!==true||!digest(input.expectedPreviewDigest))throw new AppError('QUALITY_CONFIRMATION_REQUIRED',400);
    const requestDigest=hash(input),prior=this.store.db.prepare('SELECT body,request_digest FROM quality_loops WHERE request_id=?').get(input.requestId);
    if(prior){if(prior.request_digest!==requestDigest)throw new AppError('IDEMPOTENCY_CONFLICT');return JSON.parse(String(prior.body));}
    this.ensureAvailable(input.projectId);this.starting=true;
    try{
    const preview=this.preview(input.projectId,input.sourceRunId,input.reviewers,input.limits);
    if(preview.previewDigest!==input.expectedPreviewDigest)throw new AppError('QUALITY_PREVIEW_CHANGED');
    const run=this.source(input.projectId,input.sourceRunId).run;this.ports.guard(run);
    const now=new Date().toISOString(),result:QualityLoopResult={status:'reviewing',issue:null,calls:0,repairs:0,rounds:[],artifact:clone(preview.artifact)};
    if(!modelKey(preview.producer)){result.status='blocked';result.issue='QUALITY_PRODUCER_MODEL_UNKNOWN';}
    const record:QualityLoopRecord={...preview,id:randomUUID(),requestId:input.requestId,createdAt:now,updatedAt:now,recoveryRequired:false,result,steps:[],verification:emptyVerification()};
    this.store.transaction(()=>{this.store.db.prepare('INSERT INTO quality_loops VALUES(?,?,?,?,?)').run(record.id,record.requestId,requestDigest,record.projectId,JSON.stringify(record));this.store.append('quality.created',run.id,{projectId:record.projectId,qualityLoopId:record.id});});
    if(result.status==='reviewing')this.launch(record.id);
    return this.record(record.id);
    }finally{this.starting=false;}
  }
  private context(record:QualityLoopRecord,stepId:string,artifact=record.result.artifact):QualityStepContext{
    const {run,version,task}=this.source(record.projectId,record.sourceRunId);
    if(hash(version)!==hash(record.version)||hash(task)!==hash(record.task))throw new AppError('QUALITY_BASELINE_CHANGED');
    return {loopId:record.id,stepId,signal:this.controllers.get(record.id)?.signal??new AbortController().signal,sourceRun:run,version:clone(record.version),task:clone(record.task),artifact:clone(artifact)};
  }
  private launch(loopId:string){
    const controller=new AbortController();this.controllers.set(loopId,controller);
    const task=Promise.resolve().then(()=>this.execute(loopId,controller)).finally(()=>{this.pending.delete(loopId);this.controllers.delete(loopId);});this.pending.set(loopId,task);
  }
  interrupt(loopId:string){this.record(loopId);this.controllers.get(loopId)?.abort();}
  async settled(loopId:string){await this.pending.get(loopId);return this.record(loopId);}
  private async execute(loopId:string,controller:AbortController){
    let record=this.record(loopId),index=0,stepIssue:string|null=null;
    const remaining=Math.max(1,Date.parse(record.createdAt)+record.limits.timeoutMs-Date.now());
    const timer=setTimeout(()=>controller.abort(),remaining);
    const bounded=async<T>(work:()=>Promise<T>):Promise<T>=>{
      if(controller.signal.aborted)throw new AppError('QUALITY_PROCESS_STOP_UNCONFIRMED');
      let abort=()=>{};
      const stopped=new Promise<never>((_,reject)=>{abort=()=>reject(new AppError('QUALITY_PROCESS_STOP_UNCONFIRMED'));controller.signal.addEventListener('abort',abort,{once:true});});
      try{return await Promise.race([work(),stopped]);}finally{controller.signal.removeEventListener('abort',abort);}
    };
    const step=async(kind:QualityStep['kind'],request:unknown,work:(context:QualityStepContext)=>Promise<{result:NonNullable<QualityStep['result']>;evidence:QualityModelEvidence|null}>)=>{
      const position=index++,requestDigest=hash({kind,request});let current=record.steps[position];
      if(current){
        if(current.requestDigest!==requestDigest||current.kind!==kind)throw new AppError('QUALITY_REPLAY_MISMATCH');
        if(current.state==='completed')return clone(current);
        throw new AppError(current.state==='intent'?'QUALITY_RECOVERY_REQUIRED':current.issue??'QUALITY_STEP_FAILED');
      }
      current={id:randomUUID(),index:position,kind,state:'intent',requestDigest,startedAt:new Date().toISOString(),finishedAt:null,issue:null,evidence:null,result:null};
      const context=this.context(record,current.id,(request as {artifact?:QualityLoopRecord['artifact']})?.artifact??record.result.artifact);
      try{this.ports.guard(context.sourceRun);}catch(error){stepIssue=issue(error);throw error;}
      record.steps.push(current);this.save(record);
      try{
        const out=await bounded(()=>work(context)),text=JSON.stringify(out);
        if(text.length>512*1024||qualityEvidenceBlocked(out))throw new AppError('QUALITY_EVIDENCE_BLOCKED');
        current.result=clone(out.result);current.evidence=clone(out.evidence);current.state='completed';current.finishedAt=new Date().toISOString();this.save(record);return clone(current);
      }catch(error){
        stepIssue=issue(error);current.issue=stepIssue;
        // Only the native receipt may prove that a rejected operation actually stopped.
        let stopped=false;
        if(!controller.signal.aborted&&this.ports.recover){try{const receipt=await bounded(()=>this.ports.recover!(clone(current),context));if(receipt&&'failureIssue' in receipt&&receipt.processStopped===true&&/^[A-Z][A-Z0-9_]{1,100}$/.test(receipt.failureIssue)){current.state='failed';current.finishedAt=new Date().toISOString();current.issue=receipt.failureIssue;stepIssue=receipt.failureIssue;stopped=true;}}catch{/* Unknown process state remains quarantined. */}}
        record.recoveryRequired=!stopped;this.save(record);throw error;
      }
    };
    const verify=async(artifact:QualityLoopRecord['artifact'])=>{
      const saved=await step('verification',{artifact},async context=>({result:await this.ports.verify(context),evidence:null}));
      record.verification=clone(saved.result as QualityVerificationResult);this.save(record);
      if(record.verification.status==='unknown')throw new AppError(record.verification.issue??'QUALITY_VERIFICATION_UNKNOWN');
      return record.verification.status==='passed'?[]:record.verification.failures?.length?clone(record.verification.failures):[{reviewerId:'local-verification',criterion:null,status:'not_met' as const,evidence:record.verification.issue??'Required checks failed'}];
    };
    try{
      const key=modelKey(record.producer);if(!key)throw new AppError('QUALITY_PRODUCER_MODEL_UNKNOWN');
      const input:QualityLoopInput={baseline:record.baseline,artifact:record.artifact,producer:{modelKey:key,sessionId:record.producer.sessionId!},reviewers:record.reviewers.map(r=>({id:r.id,modelKey:`${r.providerId}/${r.modelId}`})),limits:record.limits};
      const result=await runQualityLoop(input,{
        publish:value=>{record.result=clone(value);this.save(record);},
        verify:async request=>{try{return await verify(request.artifact);}catch(error){stepIssue=issue(error);throw error;}},
        review:async request=>{
          const selection=record.reviewers.find(r=>r.id===request.reviewer.id)!;
          const saved=await step('review',{...request,signal:undefined},async context=>{const out=await this.ports.review({...request,signal:controller.signal},context,selection);return {result:out.review,evidence:out.evidence};});
          const evidence=saved.evidence,key=evidence?modelKey(evidence):null;
          if(!key||key!==request.reviewer.modelKey||evidence!.runId===record.producer.runId||record.steps.some(s=>s.id!==saved.id&&s.evidence?.runId===evidence!.runId)){stepIssue='QUALITY_MODEL_MISMATCH';throw new AppError(stepIssue);}
          const review=saved.result as import('../shared/quality-loop.ts').QualityReview;
          if(review.modelKey!==key||review.sessionId!==evidence!.sessionId){stepIssue='QUALITY_MODEL_MISMATCH';throw new AppError(stepIssue);}
          return clone(review);
        },
        repair:async request=>{
          const saved=await step('repair',{...request,signal:undefined},async context=>{const result=await this.ports.repair({...request,signal:controller.signal},context);return {result,evidence:result.evidence};});
          const repaired=saved.result as QualityRepairResult,key=modelKey(repaired.evidence);
          if(!key||repaired.evidence.runId===record.producer.runId||record.steps.some(s=>s.id!==saved.id&&s.evidence?.runId===repaired.evidence.runId)){stepIssue='QUALITY_REPAIR_MODEL_UNKNOWN';throw new AppError(stepIssue);}
          return {artifact:clone(repaired.artifact),modelKey:key,sessionId:repaired.evidence.sessionId!};
        },
      });
      record.result=result;
      if(stepIssue)record.result.issue=stepIssue;
      if(record.steps.some(s=>s.state==='intent'))record.recoveryRequired=true;
      this.save(record);
    }catch(error){record.result.status='blocked';record.result.issue=issue(error);this.save(record);}
    finally{clearTimeout(timer);controller.abort();}
  }
  /** No caller-supplied result or 'confirmed stopped' flag can turn an unknown execution into a successful step. */
  async resume(loopId:string):Promise<QualityLoopRecord>{
    if(this.active)throw new AppError('QUALITY_LOOP_BUSY');
    this.recovering=true;
    let recoveredDone=()=>{};this.recoveryFinished=new Promise(resolve=>{recoveredDone=resolve;});
    const controller=new AbortController();this.controllers.set(loopId,controller);
    const timer=setTimeout(()=>controller.abort(),5000);
    try{
    const record=this.record(loopId);
    if(!record.recoveryRequired)throw new AppError('QUALITY_NOT_RECOVERABLE');
    for(const step of record.steps.filter(s=>s.state==='intent')){
      let abort=()=>{};const stopped=new Promise<never>((_,reject)=>{abort=()=>reject(new AppError('QUALITY_PROCESS_STOP_UNCONFIRMED'));controller.signal.addEventListener('abort',abort,{once:true});});
      let recovered:Awaited<ReturnType<NonNullable<QualityServicePorts['recover']>>>;
      try{if(controller.signal.aborted)throw new AppError('QUALITY_PROCESS_STOP_UNCONFIRMED');recovered=await Promise.race([this.ports.recover?.(clone(step),this.context(record,step.id))??Promise.resolve(null),stopped]);}finally{controller.signal.removeEventListener('abort',abort);}
      if(!recovered)throw new AppError('QUALITY_PROCESS_STOP_UNCONFIRMED');
      const text=JSON.stringify(recovered);if(text.length>512*1024||qualityEvidenceBlocked(recovered))throw new AppError('QUALITY_EVIDENCE_BLOCKED');
      if('failureIssue' in recovered){if(recovered.processStopped!==true||!/^[A-Z][A-Z0-9_]{1,100}$/.test(recovered.failureIssue))throw new AppError('QUALITY_EVIDENCE_INVALID');step.state='failed';step.issue=recovered.failureIssue;}
      else{step.result=clone(recovered.result);step.evidence=clone(recovered.evidence);step.state='completed';step.issue=null;}
      step.finishedAt=new Date().toISOString();this.save(record);
    }
    this.ports.guard(this.context(record,'resume').sourceRun);
    record.recoveryRequired=false;const failed=record.steps.find(s=>s.state==='failed');record.result.status=failed?'failed':'reviewing';record.result.issue=failed?.issue??null;this.save(record);if(!failed)this.launch(loopId);return this.record(loopId);
    }finally{clearTimeout(timer);if(this.controllers.get(loopId)===controller)this.controllers.delete(loopId);this.recovering=false;recoveredDone();this.recoveryFinished=null;}
  }
  async close(){for(const controller of this.controllers.values())controller.abort();await Promise.allSettled([...this.pending.values(),...(this.recoveryFinished?[this.recoveryFinished]:[])]);}
}
