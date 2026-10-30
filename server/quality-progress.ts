import {lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {listDeliverables} from './deliverables.ts';
import {readWorkspaceSnapshot} from './workspace-fingerprint.ts';
import {generalAttemptPath,type WorkerSpace,type WorkerSpaceManifest} from './worker-spaces.ts';
import type {WorkerReservation} from '../shared/parallel-workers.ts';
import type {CompletionBinding,CompletionEvidence} from '../shared/task-completion.ts';
import type {NumericSourceCheck} from '../shared/quality-progress.ts';
import {createHash} from 'node:crypto';
import type {Store} from './store.ts';
import type {Run} from '../shared/types.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {QualityLoopRecord,QualityRepairResult} from '../shared/quality-loop-record.ts';
import type {CheckRecord,VerificationView} from '../shared/verification.ts';
import type {DeliverableList} from '../shared/deliverables.ts';
import type {QualityDimension,QualityProgress,QualityProgressEvidence,QualityEvidenceBinding,QualityStatus,QualityNextAction} from '../shared/quality-progress.ts';
import {providerExecutionEvidence} from './provider-evidence.ts';

export interface QualityProgressReaders {
 deliverables?:(projectId:string)=>DeliverableList;
 checkerDigest?:string;
 verification?:(workspaceId:string,runId:string)=>VerificationView;
}
interface ArtifactCheck {
 id:string;loopId:string;sourceRunId:string;projectId?:string;taskId?:string;planningVersionId?:string;
 baselineDigest:string;artifactId?:string;artifactDigest:string;evidenceSource?:'local'|'mock';
 checkerDigest?:string;completionBinding?:CompletionBinding;artifactScope?:'task_manifest'|'project_inventory';
 numericSource?:{path:string;check:NumericSourceCheck}[];formatStatus?:QualityStatus;
 scope:string;files:{path:string;digest:string}[];result:{status:string;issue:string|null};
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dimension=(status:QualityStatus='not_run',evidenceIds:string[]=[],blockers:string[]=[],nextAction:QualityNextAction|null=null):QualityDimension=>({status,evidenceIds,blockers,nextAction});
const empty=():QualityProgress=>({execution:dimension('not_run',[],[],'execute_task'),format:dimension('not_run',[],['QUALITY_EVIDENCE_MISSING'],'verify_artifacts'),codeVerification:dimension('not_run',[],['QUALITY_EVIDENCE_MISSING'],'verify_code'),semantic:dimension('not_run',[],['QUALITY_EVIDENCE_MISSING'],'run_quality_review'),independentReview:dimension('not_run',[],['QUALITY_EVIDENCE_MISSING'],'run_independent_review'),repair:dimension(),revalidation:dimension(),userApproval:dimension('not_run',[],['QUALITY_APPROVAL_MISSING'],'request_user_approval'),evidence:[]});
/** Reads only existing tables. Never constructs services whose constructors recover or migrate data. */
function records<T>(store:Store,table:'quality_artifact_checks'|'quality_loops'|'verification_checks'|'worker_reservations'|'worker_spaces'|'integration_queue'|'quality_native_receipts'):T[]{
 if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return [];
 return store.db.prepare(`SELECT body FROM ${table} ORDER BY rowid`).all().flatMap(row=>{try{const v=JSON.parse(String(row.body));return v&&typeof v==='object'?[v as T]:[];}catch{return [];}});
}
/** Bump versions whenever checker semantics or the general evidence policy changes. */
export function generalCheckerDigest(policyVersion='cqg-general-v1',checkerVersion='format-numeric-semantic-v2'):string {
 return hash({policyVersion,checkerVersion});
}
export function workerEvidenceRecords(store:Store,run:Run){
 const reservations=records<WorkerReservation>(store,'worker_reservations').filter(r=>r.attempt?.dispatchRequestId&&store.findRequest(r.attempt.dispatchRequestId)?.run.id===run.id);
 if(reservations.length>1)throw Error('QUALITY_WORKER_BINDING_AMBIGUOUS');
 const reservation=reservations[0];
 const spaces=records<WorkerSpace>(store,'worker_spaces').filter(s=>s.reservationId===reservation?.reservationId);
 if(spaces.length>1)throw Error('QUALITY_WORKER_BINDING_AMBIGUOUS');
 return {reservation,space:spaces[0]};
}
/** Read saved PW manifests only. Never call WorkerSpaces.finish (transaction) from a reader. */
export function generalEvidenceSnapshot(store:Store,run:Run,inventory:()=>DeliverableList,checkArtifacts=false){
 const {reservation,space}=workerEvidenceRecords(store,run);
 if(!reservation){
  const listed=inventory();
  const digest=!listed.truncated&&!listed.skipped&&listed.items.every(i=>i.size<=32*1024*1024)?hash(listed.items.map(i=>({path:i.path,digest:i.sha256}))):null;
  return {listed,digest,artifactId:run.projectId!,artifactScope:'project_inventory' as const,manifest:null,space:null,reservation:null};
 }
 if(!space||space.kind!=='general'||space.state!=='ready'||space.projectId!==run.projectId||space.attemptId!==reservation.attempt.id
  ||reservation.attempt.taskId!==run.taskId||reservation.batch.planningVersionId!==run.planningVersionId||reservation.batch.planningHash!==run.planningContentHash)throw Error('QUALITY_WORKER_BINDING_MISMATCH');
 const project=store.projects().find(p=>p.id===run.projectId);
 const stat=lstatSync(space.path,{bigint:true});
 if(!project||space.path!==generalAttemptPath(project.path,space.attemptId)||realpathSync(space.path)!==space.path||!stat.isDirectory()
  ||`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`!==space.identity)throw Error('QUALITY_WORKER_IDENTITY_CHANGED');
 const entries=records<{space:WorkerSpace;manifest:WorkerSpaceManifest}>(store,'integration_queue').filter(i=>i.space?.reservationId===space.reservationId);
 if(entries.length!==1)throw Error('QUALITY_TASK_MANIFEST_UNAVAILABLE');
 const manifest=entries[0].manifest;
 if(!manifest||manifest.reservationId!==space.reservationId||!manifest.inputsUnchanged||manifest.outOfScope||!space.inputDigest)throw Error('QUALITY_TASK_MANIFEST_UNAVAILABLE');
 const listed=listDeliverables(space.path,[],checkArtifacts);
 if(listed.skipped||listed.truncated||listed.items.some(i=>i.size>32*1024*1024))throw Error('QUALITY_ARTIFACT_UNAVAILABLE');
 const outputs=listed.items.filter(i=>i.role==='output');
 if(outputs.length!==manifest.files.length||manifest.files.some(f=>f.status!=='present'||f.outOfScope||!outputs.some(i=>i.path===f.path&&i.sha256===f.sha256)))throw Error('QUALITY_ARTIFACT_CHANGED');
 const source=readWorkspaceSnapshot(space.path,'0'.repeat(40),listed.items.map(i=>{
  const stat=lstatSync(join(space.path,i.path));
  if(stat.isSymbolicLink()||stat.nlink!==1)throw Error('QUALITY_WORKER_IDENTITY_CHANGED');
  return {path:i.path,mode:stat.mode&0o111?'100755':'100644'};
 }));
 if(source.sourceDigest!==manifest.sourceDigest)throw Error('QUALITY_ARTIFACT_CHANGED');
 return {listed,digest:hash(manifest),artifactId:space.attemptId,artifactScope:'task_manifest' as const,manifest,space,reservation};
}
/** Null means absent in persisted provenance, never a wildcard or today's policy. */
export function capturedCompletionBinding(binding:QualityEvidenceBinding,extra:Partial<CompletionBinding>={}):CompletionBinding {
 return {...binding,graphRevision:null,contractDigest:null,policyDigest:null,configDigest:null,artifactScope:null,baseSha:null,inputSnapshotDigest:null,...extra};
}

function fromEvidence(e:QualityProgressEvidence,status:QualityStatus,nextAction:QualityNextAction):QualityDimension{
 const state=e.freshness==='stale'?'stale':status==='blocked'?'blocked':e.freshness!=='current'?'unknown':['passed','completed'].includes(status)&&['mock','unknown'].includes(e.evidenceSource)?'recorded':status;
 const blockers=[...e.blockers,...(state==='recorded'?['QUALITY_OBSERVED_EVIDENCE_REQUIRED']:[])];
 return dimension(state,[e.id],blockers,state==='passed'?null:nextAction);
}

/** One request-scoped collector shares file observations across runs. */
export class QualityProgressCollector {
 private artifacts:ArtifactCheck[];private loops:QualityLoopRecord[];private checks:CheckRecord[];
 private lists=new Map<string,DeliverableList|null>();
 private store:Store;private readers:QualityProgressReaders;
 constructor(store:Store,readers:QualityProgressReaders={}){
  this.store=store;this.readers=readers;
  this.artifacts=records(store,'quality_artifact_checks');this.loops=records(store,'quality_loops');this.checks=records(store,'verification_checks');
 }
 read(projectId:string,task:SavedTask,run:Run|undefined,plan:PlanningVersion|undefined,planCurrent:boolean):QualityProgress{
  const q=empty();if(!run)return q;
  const provenance=providerExecutionEvidence(this.store,run,null);
  q.execution=dimension(run.execution==='completed'?'completed':['starting','running','interrupting'].includes(run.execution)?'running':run.execution==='failed'?'failed':'unknown',[],provenance.source==='unknown'?['EXECUTION_PROVENANCE_UNKNOWN']:provenance.source==='mock'?['EXECUTION_MOCK']:[]);
  q.execution.evidenceSource=provenance.source;
  if(!provenance.executionObserved)q.execution.blockers.push('EXECUTION_OBSERVATION_UNAVAILABLE');
  let view:VerificationView|null=null,currentDigest:string|null=null;
  let general:ReturnType<typeof generalEvidenceSnapshot>|null=null,generalIssue:string|null=null;
  if(run.workspaceId){try{view=this.readers.verification?.(run.workspaceId,run.id)??null;currentDigest=view?.sourceDigest??null;}catch{/* Unavailable observations never reuse an old hash. */}}
  else{
   if(!this.lists.has(projectId)){try{this.lists.set(projectId,this.readers.deliverables?.(projectId)??null);}catch{this.lists.set(projectId,null);}}
   try{general=generalEvidenceSnapshot(this.store,run,()=>{const list=this.lists.get(projectId);if(!list)throw Error('QUALITY_ARTIFACT_UNAVAILABLE');return list;});currentDigest=general.digest;}
   catch(error){generalIssue=error instanceof Error&&/^QUALITY_[A-Z_]+$/.test(error.message)?error.message:'QUALITY_ARTIFACT_UNAVAILABLE';}
  }
  const binding:QualityEvidenceBinding={projectId,taskId:task.id,runId:run.id,planningVersionId:run.planningVersionId??null,planningContentHash:run.planningContentHash??null,acceptanceDigest:run.acceptanceDigest??null,artifactId:run.workspaceId??general?.artifactId??projectId,artifactDigest:currentDigest};
  const assess=(e:QualityProgressEvidence)=>{
   const b=e.binding;
   if((run.projectId!==undefined&&run.projectId!==projectId)||b.projectId!==projectId||b.taskId!==task.id||b.runId!==run.id||b.artifactId!==binding.artifactId){e.freshness='mismatch';e.blockers.push('QUALITY_BINDING_MISMATCH');}
   else if(!plan||!b.planningVersionId||!b.planningContentHash||!run.planningContentHash){e.freshness='unavailable';e.blockers.push('QUALITY_BASELINE_UNAVAILABLE');}
   else if(!planCurrent||plan.state!=='approved'||b.planningVersionId!==plan.id||b.planningContentHash!==plan.contentHash||run.planningVersionId!==plan.id||run.planningContentHash!==plan.contentHash){e.freshness='stale';e.blockers.push('QUALITY_BASELINE_CHANGED');}
   else if(!currentDigest||!b.artifactDigest){e.freshness='unavailable';e.blockers.push('QUALITY_ARTIFACT_UNAVAILABLE');}
   else if(b.artifactDigest!==currentDigest){e.freshness='stale';e.blockers.push('QUALITY_ARTIFACT_CHANGED');}
   if(!run.workspaceId){
    if(generalIssue){e.freshness=generalIssue==='QUALITY_ARTIFACT_CHANGED'?'stale':'unavailable';e.blockers.push(generalIssue);}
    if(!e.checkerDigest){if(e.freshness==='current')e.freshness='unavailable';e.blockers.push('QUALITY_CHECKER_BINDING_MISSING');}
    else if(e.checkerDigest!==(this.readers.checkerDigest??generalCheckerDigest())){if(e.freshness==='current')e.freshness='stale';e.blockers.push('QUALITY_CHECKER_CHANGED');}
   }
   q.evidence.push(e);return e;
  };
  const loops=this.loops.filter(l=>l.sourceRunId===run.id&&l.result&&Array.isArray(l.steps));
  for(const c of this.artifacts.filter(c=>c.sourceRunId===run.id&&c.result)){
   const l=loops.find(l=>l.id===c.loopId);
   const e=assess({id:c.id,kind:'artifact_check',evidenceSource:c.evidenceSource??'unknown',freshness:'current',recordedStatus:c.formatStatus??c.result.status,blockers:[],checkerDigest:c.checkerDigest,artifactScope:c.artifactScope,numericSource:c.numericSource,
    binding:{...binding,acceptanceDigest:c.completionBinding?.acceptanceDigest??null,projectId:c.projectId??l?.projectId??null,taskId:c.taskId??l?.taskId??null,planningVersionId:c.planningVersionId??l?.baseline.id??null,planningContentHash:c.baselineDigest,artifactId:c.artifactId??l?.result.artifact.id??null,artifactDigest:c.artifactDigest},files:c.files?.map(({path,digest})=>({path,digest}))});
   if(l&&(l.projectId!==projectId||l.taskId!==task.id)){e.freshness='mismatch';e.blockers.push('QUALITY_LOOP_BINDING_MISMATCH');}
   q.format=fromEvidence(e,(c.formatStatus??c.result.status)==='passed'?'passed':(c.formatStatus??c.result.status)==='failed'?'failed':'unknown','verify_artifacts');
  }
  const checks=this.checks.filter(c=>c.runId===run.id);
  for(const c of checks){
   const e=assess({id:c.id,kind:'verification_check',evidenceSource:c.evidenceSource??'unknown',freshness:'current',recordedStatus:c.verdict,blockers:[],binding:{...binding,projectId:c.projectId,taskId:c.taskId??binding.taskId,planningVersionId:c.planningVersionId??binding.planningVersionId,planningContentHash:c.planningContentHash??binding.planningContentHash,artifactId:c.workspaceId,artifactDigest:c.finishedDigest,acceptanceDigest:c.acceptanceDigest??null}});
   if(view&&(!view.commands.some(command=>command.id===c.commandId&&command.configDigest===c.configDigest)
    ||this.store.workspaces().find(w=>w.id===c.workspaceId)?.baseSha!==c.baseSha)){
    e.freshness='stale';e.blockers.push('QUALITY_VERIFICATION_CONFIGURATION_CHANGED');
   }
   if(view?.acceptance?.state==='changed'){e.freshness='stale';e.blockers.push('QUALITY_ACCEPTANCE_CHANGED');}
   if(view?.acceptance?.state==='unavailable'){e.freshness='unavailable';e.blockers.push('QUALITY_BASELINE_UNAVAILABLE');}
   if(c.acceptanceDigest!==run.acceptanceDigest){e.freshness='stale';e.blockers.push('QUALITY_ACCEPTANCE_CHANGED');}
   if(c.verdict==='stale'||(c.finishedDigest&&c.sourceDigest!==c.finishedDigest)){e.freshness='stale';e.blockers.push('QUALITY_ARTIFACT_CHANGED');}
  }
  let codeBindingsCurrent=false;
  if(checks.length){
   const ids=checks.map(c=>c.id),es=q.evidence.filter(e=>e.kind==='verification_check');
   const status:QualityStatus=view?.canApprove?'passed':es.some(e=>e.freshness==='stale')||view?.acceptance?.state==='changed'?'stale':checks.some(c=>c.execution==='running')?'running':checks.at(-1)?.verdict==='failed'?'failed':'unknown';
   const required=view?.commands.map(command=>[...checks].reverse().find(c=>c.commandId===command.id))??[];
   codeBindingsCurrent=required.length>0&&required.every(c=>c&&es.find(e=>e.id===c.id)?.freshness==='current');
   const observed=codeBindingsCurrent&&required.every(c=>c?.evidenceSource==='local');
   q.codeVerification=dimension(status==='passed'&&!codeBindingsCurrent?'unknown':status==='passed'&&!observed?'recorded':status,ids,[...new Set(es.flatMap(e=>e.blockers)),...(!view?['QUALITY_VERIFICATION_VIEW_UNAVAILABLE']:[]),...(status==='passed'&&!observed?['QUALITY_OBSERVED_EVIDENCE_REQUIRED']:[])],status==='passed'&&observed?null:'verify_code');
  }
  for(const l of loops){
   const ai=l.steps.filter(s=>s.kind==='review'||s.kind==='repair');
   const source=l.producer?.evidenceSource==='mock'||ai.some(s=>s.evidence?.evidenceSource==='mock')?'mock':l.producer?.evidenceSource==='native'&&ai.length>0&&ai.every(s=>s.state==='completed'&&s.evidence?.evidenceSource==='native')?'native':'unknown';
   const reviewSteps=l.steps.filter(s=>s.kind==='review'&&s.state==='completed');
   const receipts=records<{id:string;loopId:string;sourceRunId:string;baselineDigest:string;artifactDigest:string;checkerDigest?:string;artifactScope?:'task_manifest'|'project_inventory'}>(this.store,'quality_native_receipts');
   const selected=reviewSteps.filter(s=>s.result&&'artifactDigest' in s.result&&s.result.artifactDigest===l.result.artifact.digest).map(s=>receipts.find(r=>r.id===s.id&&r.loopId===l.id&&r.sourceRunId===run.id&&r.baselineDigest===l.baseline.digest&&r.artifactDigest===l.result.artifact.digest));
   const checkerDigest=selected.length&&selected.every(r=>r?.checkerDigest&&r.checkerDigest===selected[0]?.checkerDigest)?selected[0]!.checkerDigest:undefined;
   const e=assess({id:l.id,kind:'quality_loop',evidenceSource:source,freshness:'current',recordedStatus:l.result.status,blockers:[],checkerDigest,artifactScope:run.workspaceId?'workspace':selected[0]?.artifactScope,binding:{...binding,projectId:l.projectId,taskId:l.taskId,planningVersionId:l.baseline?.id??null,planningContentHash:l.baseline?.digest??null,artifactId:l.result.artifact?.id??null,artifactDigest:l.result.artifact?.digest??null}});
   const issue=l.result.issue;
   if(issue)e.blockers.push(issue);
   const identity=this.store.getCodexModelAttribution(run.id);
   const modelUnknown=!!identity||!l.producer?.modelId||l.producer.source!=='native_observed';
   if(modelUnknown)e.blockers.push('QUALITY_PRODUCER_MODEL_UNKNOWN');
   const status:QualityStatus=modelUnknown||l.recoveryRequired||l.result.status==='blocked'?'blocked':l.result.status==='passed'?'passed':['reviewing','repairing'].includes(l.result.status)?'running':'failed';
   // Accepted round opinions are independent of local verification failures added by the engine.
   const round=l.result.rounds?.at(-1);
   const reviewed=!modelUnknown&&!l.recoveryRequired&&round?.artifact.digest===l.result.artifact.digest&&l.reviewers.length>0&&round.reviews.length===l.reviewers.length
    &&l.reviewers.every(reviewer=>round.reviews.some(r=>r.reviewerId===reviewer.id
     &&r.result.baselineDigest===l.baseline.digest&&r.result.artifactDigest===l.result.artifact.digest
     &&r.result.criteria.length===task.acceptanceCriteria.length&&task.acceptanceCriteria.every(c=>r.result.criteria.some(value=>value.criterion===c))
     &&l.steps.some(step=>step.kind==='review'&&step.state==='completed'&&step.evidence?.source==='native_observed'
      &&!!step.evidence.modelId&&!!step.evidence.sessionId&&JSON.stringify(step.result)===JSON.stringify(r.result))));
   const semantic=reviewed?round.reviews.every(r=>r.result.criteria.every(c=>c.status==='met')&&!r.result.findings.length)?'passed':'failed':status==='passed'?'unknown':status;
   q.semantic=fromEvidence(e,semantic,'run_quality_review');
   q.independentReview=fromEvidence(e,reviewed?'completed':status==='passed'?'unknown':status,'run_independent_review');
   if(!reviewed&&status==='passed'){q.semantic.blockers.push('QUALITY_REVIEW_EVIDENCE_MISSING');q.independentReview.blockers.push('QUALITY_REVIEW_EVIDENCE_MISSING');}
   const repairs=l.steps.filter(s=>s.kind==='repair');
   if(repairs.length){
    const repair=repairs.at(-1)!,result=repair.result as QualityRepairResult|null;
    q.repair=fromEvidence(e,repair.state==='completed'?'completed':repair.state==='intent'?'running':'failed','repair_artifacts');
    const verification=l.steps.filter(s=>s.kind==='verification'&&s.index>repair.index).at(-1);
    const resultChecks=verification?.result&&'checkIds' in verification.result?verification.result.checkIds:[];
    const verified=verification?.state==='completed'&&verification.result&&'status' in verification.result&&verification.result.status==='passed'
     &&(!run.workspaceId||q.codeVerification.status==='passed')&&resultChecks.length>0&&resultChecks.every(id=>q.evidence.some(check=>check.id===id&&['artifact_check','verification_check'].includes(check.kind)&&check.freshness==='current'&&check.evidenceSource==='local'&&check.recordedStatus==='passed'));
    const matched=result?.artifact?.digest===l.result.artifact.digest;
    q.revalidation=fromEvidence(e,matched&&verified&&l.verification.status==='passed'?'passed':'unknown','reverify_artifacts');
    if(!verified)q.revalidation.blockers.push('QUALITY_REVALIDATION_EVIDENCE_MISSING');
   }
  }
  if(view?.approval){
   const a=view.approval,e=assess({id:a.id,kind:'user_approval',evidenceSource:'local',freshness:'current',recordedStatus:'approved',blockers:[],binding:{...binding,runId:a.runId,artifactId:a.workspaceId,artifactDigest:a.sourceDigest}});
   if(!codeBindingsCurrent&&e.freshness==='current'){e.freshness='unavailable';e.blockers.push('QUALITY_APPROVAL_EVIDENCE_UNAVAILABLE');}
   if(!view.approvalCurrent&&e.freshness==='current'){e.freshness='stale';e.blockers.push('QUALITY_APPROVAL_STALE');}
   q.userApproval=fromEvidence(e,'passed','request_user_approval');
  }
  return q;
 }
 /** CQG-4 can pass this projection directly to CQG-1; unavailable capture stays null. */
 completionEvidence(quality:QualityProgress,run:Run,view?:VerificationView):CompletionEvidence & {taskManifest:WorkerSpaceManifest|null} {
  const bindings:Record<string,CompletionBinding>={};
  const gateResults:CompletionEvidence['gateResults']=[];
  for(const e of quality.evidence){
   const artifact=this.artifacts.find(c=>c.id===e.id);
   const check=this.checks.find(c=>c.id===e.id);
   const receipt=records<{loopId:string;artifactDigest:string;completionBinding?:CompletionBinding}>(this.store,'quality_native_receipts').find(r=>r.loopId===e.id&&r.artifactDigest===e.binding.artifactDigest);
   const approval=view?.approval?.id===e.id?view.approval:undefined;
   bindings[e.id]=artifact?.completionBinding??check?.completionBinding??approval?.completionBinding??receipt?.completionBinding??capturedCompletionBinding(e.binding,{configDigest:check?.configDigest??e.checkerDigest??null,baseSha:check?.baseSha??null,artifactScope:check?'workspace':null});
   if(artifact){
    gateResults.push({gate:'artifact_format',evidenceId:e.id,status:artifact.formatStatus??'unknown'});
    const numeric=artifact.numericSource;
    gateResults.push({gate:'numeric_source',evidenceId:e.id,status:numeric?.length&&numeric.every(n=>Array.isArray(n.check.results)&&n.check.results.length&&n.check.results.every(r=>r.status==='verified')&&n.check.status==='passed')?'passed':numeric?.some(n=>n.check.status==='needs_review')?'failed':'unknown'});
   }
  }
  let taskManifest:WorkerSpaceManifest|null=null;
  if(!run.workspaceId)try{taskManifest=generalEvidenceSnapshot(this.store,run,()=>{throw Error('NO_INVENTORY');}).manifest;}catch{/* Missing manifest stays unavailable. */}
  const loop=this.loops.filter(l=>l.sourceRunId===run.id).at(-1);
  const producer=loop?{model:loop.producer,binding:capturedCompletionBinding({projectId:loop.projectId,taskId:loop.taskId,runId:loop.sourceRunId,planningVersionId:loop.baseline.id,planningContentHash:loop.baseline.digest,
   acceptanceDigest:run.acceptanceDigest??null,artifactId:loop.artifact?.id??null,artifactDigest:loop.artifact?.digest??null})}:undefined;
  return {quality,bindings,producer,checks:this.checks.filter(c=>c.runId===run.id),commands:view?.commands??[],loops:this.loops.filter(l=>l.sourceRunId===run.id),gateResults,approvals:view?.approval?[view.approval]:[],checkSetDigest:view?.checkSetDigest??null,taskManifest};
 }

}
