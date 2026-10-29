import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,lstatSync,mkdirSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import type {Store} from './store.ts';
import {Projects,canonical} from './projects.ts';
import type {ParallelWorkerService} from './parallel-workers.ts';
import type {WorkerSpaces,WorkerSpace,WorkerSpaceManifest} from './worker-spaces.ts';
import type {WorkerFence} from '../shared/parallel-workers.ts';
import type {VerificationService} from './verification-service.ts';
import type {MergeService} from './merge-service.ts';
import {assertWorkspaceManifest,readWorkspaceSnapshot,type WorkspaceFileSnapshot} from './workspace-fingerprint.ts';
import * as git from './merge-git.ts';
import {completionPolicyDigest,evaluateTaskCompletion} from './task-completion.ts';
import type {CompletionBinding,CompletionEvidence,CompletionPolicy,TaskCompletion} from '../shared/task-completion.ts';
import type {VerificationResult} from './verification.ts';

const zero='0'.repeat(40);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const finished=(status:string)=>status==='applied'||status==='refused';
const live=new Set<string>();
export interface IntegrationPolicy {
  approvedBaseline:string;
  /** Trusted project default; required even for a local-only repository. */
  defaultBranch:string;
  requiredChecks:string[];
  completionPolicy?:CompletionPolicy;
}
/** Read-only, trusted server evidence adapter. Bindings must have been captured
 * on this candidate; callers must never rebind worker passes to these values.
 * No adapter means no auto-apply. It must not run checks or invoke providers. */
export interface IntegrationCompletionEvidence {
  subject:{integrationId:string;candidateDigest:string;targetDigest:string|null};
  binding:CompletionBinding;evidence:CompletionEvidence;
}
export type IntegrationCompletionReader=(item:Readonly<IntegrationItem>)=>IntegrationCompletionEvidence|null;
export interface IntegrationInput {requestId:string;fence:WorkerFence;targetBranch:string|null}
export interface IntegrationItem {
  id:string;requestId:string;inputDigest:string;fence:WorkerFence;projectId:string;space:WorkerSpace;
  approvedBaseline:string;requiredChecks:string[];defaultBranch:string;configDigest:string;
  baseSha:string|null;sourceSha:string|null;manifest:WorkerSpaceManifest;targetBranch:string|null;
  target:git.MergeTarget|null;candidate:git.MergeCandidate|null;candidatePath:string|null;candidateDigest:string|null;
  status:'queued'|'building'|'verifying'|'applying'|'applied'|'refused'|'blocked';reason:string|null;
  attempts:number;released:boolean;generalTargetDigest:string|null;applyStarted:boolean;
  completionPolicyDigest?:string|null;completion?:TaskCompletion;
}
function scan(root:string):git.MergeSnapshot {
  canonical(root);const files:{path:string;mode:string}[]=[];let count=0;
  const visit=(path:string)=>{for(const name of readdirSync(path)){
    if(++count>2000)throw new Error('INTEGRATION_TREE_TOO_LARGE');
    const child=join(path,name),stat=lstatSync(child);
    if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||(stat.isFile()&&stat.nlink!==1))throw new Error('INTEGRATION_PATH_ALIAS');
    if(stat.isDirectory())visit(child);else files.push({path:relative(root,child).split('\\').join('/'),mode:stat.mode&0o111?'100755':'100644'});
  }};visit(root);assertWorkspaceManifest(files);return readWorkspaceSnapshot(root,zero,files);
}
function write(root:string,file:WorkspaceFileSnapshot){
  if(file.presence!=='present')throw new Error('INTEGRATION_GENERAL_DELETE_UNSUPPORTED');
  const path=join(root,file.path);let ancestor=dirname(path);while(!existsSync(ancestor))ancestor=dirname(ancestor);canonical(ancestor);
  mkdirSync(dirname(path),{recursive:true});canonical(dirname(path));
  writeFileSync(path,file.bytes,{flag:'wx',mode:file.mode==='100755'?0o755:0o644});
  chmodSync(path,file.mode==='100755'?0o755:0o644);
}

/** One durable server-wide slot in the authoritative Store. Construction and GET
 * never dispatch. Caller wires drain/reconcile at explicit server lifecycle points.
 * Policy and services are trusted server dependencies, never browser supplied. */
export class IntegrationQueue {
  private store:Store;private projects:Projects;private workers:ParallelWorkerService;private spaces:WorkerSpaces;
  private verification:VerificationService;private merge:MergeService;private policy:(projectId:string)=>IntegrationPolicy;
  private readCompletion:IntegrationCompletionReader;
  constructor(store:Store,projects:Projects,workers:ParallelWorkerService,spaces:WorkerSpaces,verification:VerificationService,merge:MergeService,policy:(projectId:string)=>IntegrationPolicy,readCompletion:IntegrationCompletionReader=()=>null){
    this.store=store;this.projects=projects;this.workers=workers;this.spaces=spaces;this.verification=verification;this.merge=merge;this.policy=policy;
    this.readCompletion=readCompletion;
    store.db.exec('CREATE TABLE IF NOT EXISTS integration_queue(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,slot INTEGER UNIQUE CHECK(slot=1),body TEXT NOT NULL);');
  }
  get(id:string):IntegrationItem {const row=this.store.db.prepare('SELECT body FROM integration_queue WHERE id=?').get(id);if(!row)throw new Error('INTEGRATION_NOT_FOUND');return JSON.parse(String(row.body));}
  list():IntegrationItem[]{return this.store.db.prepare('SELECT body FROM integration_queue ORDER BY rowid').all().map(row=>JSON.parse(String(row.body)));}
  get active(){return !!this.store.db.prepare('SELECT id FROM integration_queue WHERE slot=1').get();}
  private save(item:IntegrationItem){this.store.db.prepare('UPDATE integration_queue SET body=? WHERE id=?').run(JSON.stringify(item),item.id);return item;}
  private space(reservationId:string):WorkerSpace {
    const row=this.store.db.prepare('SELECT body FROM worker_spaces WHERE reservation_id=?').get(reservationId);
    if(!row)throw new Error('INTEGRATION_SPACE_MISSING');return JSON.parse(String(row.body));
  }
  enqueue(input:IntegrationInput):IntegrationItem {
    if(!/^[A-Za-z0-9_-]{8,80}$/.test(input.requestId))throw new Error('INTEGRATION_REQUEST_INVALID');
    const inputDigest=hash(input),prior=this.store.db.prepare('SELECT id,input_digest FROM integration_queue WHERE request_id=?').get(input.requestId);
    if(prior){if(prior.input_digest!==inputDigest)throw new Error('IDEMPOTENCY_CONFLICT');return this.get(String(prior.id));}
    const reservation=this.workers.read(input.fence.reservationId),space=this.space(reservation.reservationId),policy=this.policy(space.projectId);
    if(reservation.state!=='terminal_confirmed')throw new Error('INTEGRATION_TERMINAL_REQUIRED');
    const manifest=this.spaces.finish(input.fence);
    if(!/^[a-f0-9]{64}$/.test(policy.approvedBaseline)||policy.approvedBaseline!==reservation.batch.planningHash)throw new Error('INTEGRATION_BASELINE_CHANGED');
    const project=this.projects.list().find(p=>p.id===space.projectId)!;
    const item:IntegrationItem={id:randomUUID(),requestId:input.requestId,inputDigest,fence:structuredClone(input.fence),projectId:space.projectId,space,approvedBaseline:policy.approvedBaseline,requiredChecks:[...policy.requiredChecks],defaultBranch:policy.defaultBranch,configDigest:this.verification.integrationConfigDigest(project.path),baseSha:space.baseSha,sourceSha:space.baseSha,manifest,targetBranch:input.targetBranch,target:null,candidate:null,candidatePath:null,candidateDigest:null,status:'queued',reason:null,attempts:0,released:false,generalTargetDigest:null,applyStarted:false};
    item.completionPolicyDigest=policy.completionPolicy?completionPolicyDigest(policy.completionPolicy):null;
    this.store.transaction(()=>{
      if(this.list().some(i=>i.fence.reservationId===item.fence.reservationId))throw new Error('INTEGRATION_ALREADY_QUEUED');
      this.store.db.prepare('INSERT INTO integration_queue VALUES(?,?,?,NULL,?)').run(item.id,item.requestId,item.inputDigest,JSON.stringify(item));
    });return item;
  }
  private current(item:IntegrationItem){
    if(this.workers.read(item.fence.reservationId).state!=='terminal_confirmed')throw new Error('INTEGRATION_TERMINAL_REQUIRED');
    const p=this.policy(item.projectId);
    if(p.approvedBaseline!==item.approvedBaseline||p.defaultBranch!==item.defaultBranch||hash(p.requiredChecks)!==hash(item.requiredChecks)
      ||(p.completionPolicy?completionPolicyDigest(p.completionPolicy):null)!==(item.completionPolicyDigest??null))throw new Error('INTEGRATION_POLICY_CHANGED');
    if(hash(this.spaces.finish(item.fence))!==hash(item.manifest))throw new Error('INTEGRATION_SOURCE_CHANGED');
    const project=this.projects.list().find(p=>p.id===item.projectId);if(!project)throw new Error('INTEGRATION_PROJECT_MISSING');
    const protectedFiles=this.verification.integrationProtectedFiles(project.path);
    if(item.manifest.files.some(file=>protectedFiles.includes(file.path)))throw new Error('INTEGRATION_PROTECTED_VERIFICATION_FILE');
    if(item.manifest.outOfScope||!item.manifest.inputsUnchanged||item.manifest.files.some(f=>f.outOfScope))throw new Error('INTEGRATION_SCOPE');
  }
  private terminal(item:IntegrationItem,status:'applied'|'refused',reason:string|null=null){
    // Save outcome before release. A crash in this gap retries only idempotent release.
    this.save({...item,status,reason});this.workers.release(item.fence);
    this.store.transaction(()=>{this.save({...item,status,reason,released:true});this.store.db.prepare('UPDATE integration_queue SET slot=NULL WHERE id=?').run(item.id);});
  }
  private block(item:IntegrationItem,reason:string){this.save({...item,status:'blocked',reason});}
  private candidateChecks():{id:string;integrationId:string;approvedBaseline:string;configDigest:string;sourceDigest:string;commandId:string;status:string;result?:VerificationResult}[]{
    if(!this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='integration_checks'").get())return [];
    return this.store.db.prepare('SELECT id,body FROM integration_checks ORDER BY rowid').all().map(row=>({...JSON.parse(String(row.body)),id:String(row.id)}));
  }
  private assertCompletion(item:IntegrationItem,checkIds:Set<string>){
    const policy=this.policy(item.projectId).completionPolicy;
    if(!policy||policy.projectKind!==item.space.kind)throw new Error('INTEGRATION_COMPLETION_POLICY_REQUIRED');
    const captured=this.readCompletion(structuredClone(item));
    if(!captured)throw new Error('INTEGRATION_COMPLETION_EVIDENCE_REQUIRED');
    const subject=captured.subject;
    if(subject.integrationId!==item.id||subject.candidateDigest!==item.candidateDigest
      ||subject.targetDigest!==(item.target?.head??item.generalTargetDigest))throw new Error('INTEGRATION_COMPLETION_SUBJECT_MISMATCH');
    const reservation=this.workers.read(item.fence.reservationId);
    const binding:CompletionBinding={...captured.binding,projectId:item.projectId,taskId:reservation.attempt.taskId,
      planningVersionId:reservation.batch.planningVersionId,planningContentHash:item.approvedBaseline,
      graphRevision:String(reservation.batch.graphRevision),contractDigest:hash(reservation.batch.contractDigests),
      artifactId:item.id,artifactDigest:item.candidateDigest,artifactScope:item.space.kind==='code'?'workspace':'task_manifest',
      policyDigest:completionPolicyDigest(policy),configDigest:item.configDigest,baseSha:item.target?.head??null,inputSnapshotDigest:item.space.inputDigest};
    if(Object.keys(binding).some(key=>binding[key as keyof CompletionBinding]!==captured.binding[key as keyof CompletionBinding]))throw new Error('INTEGRATION_COMPLETION_BINDING_MISMATCH');
    const evidence=structuredClone(captured.evidence);
    if(item.space.kind==='code'){
      // Only records from this verification attempt count, even when a rebuild
      // happens to produce identical bytes. Worker check tables are never read.
      const checks=this.candidateChecks().filter(c=>checkIds.has(c.id));
      evidence.checks=evidence.checks.filter(c=>checks.some(row=>{
        const r=row.result;
        return row.id===c.id&&row.integrationId===item.id&&row.approvedBaseline===item.approvedBaseline
          &&row.configDigest===item.configDigest&&row.sourceDigest===item.candidateDigest&&row.commandId===c.commandId
          &&row.status==='passed'&&r?.status==='passed'&&r.workspaceId===item.id&&r.baseSha===binding.baseSha
          &&r.sourceDigest===item.candidateDigest&&r.finishedDigest===item.candidateDigest&&r.exitCode===0
          &&c.sourceDigest===r.sourceDigest&&c.finishedDigest===r.finishedDigest&&c.createdAt===r.startedAt;
      }));
      if(hash(evidence.commands.map(c=>({id:c.id,digest:c.configDigest})))!==item.configDigest)throw new Error('INTEGRATION_COMPLETION_CONFIG_MISMATCH');
    }
    item.completion=evaluateTaskCompletion(evidence,policy,binding);
    if(!item.completion.qualityPassed)throw new Error('INTEGRATION_COMPLETION_REFUSED:'+item.completion.reasonCodes.join(','));
  }
  async drain():Promise<void> {
    for(;;){
      const item=this.store.transaction(()=>{
        if(this.active||this.merge.active||this.verification.active)return null;
        const next=this.list().find(i=>i.status==='queued');if(!next)return null;
        this.store.db.prepare('UPDATE integration_queue SET slot=1 WHERE id=?').run(next.id);return this.save({...next,status:'building'});
      });
      if(!item)return;live.add(item.id);
      try{await this.process(item);}catch{const current=this.get(item.id);if(finished(current.status))this.save({...current,reason:'INTEGRATION_RELEASE_PENDING'});else this.block(current,'INTEGRATION_UNCERTAIN');}finally{live.delete(item.id);}
      if(this.active)return;
    }
  }
  private source(item:IntegrationItem):git.MergeSnapshot {
    const snapshot=item.space.kind==='code'?this.projects.workerChanges(item.space.workspaceId!):scan(item.space.path);
    const files=snapshot.files.filter(f=>item.manifest.files.some(m=>m.path===f.path));
    if(files.length!==item.manifest.files.length||files.some(f=>!item.manifest.files.some(m=>m.path===f.path&&m.status===f.presence&&m.sha256===(f.presence==='present'?bytesHash(f.bytes):null))))throw new Error('INTEGRATION_SOURCE_CHANGED');
    return {sourceDigest:snapshot.sourceDigest,files};
  }
  private async process(item:IntegrationItem){
    try{this.current(item);}catch{this.terminal(item,'refused','INTEGRATION_SCOPE_OR_SOURCE_CHANGED');return;}
    const project=item.space.kind==='code'?this.projects.mergeProject(item.projectId):this.projects.generalProject(item.projectId);
    for(let retry=0;retry<3;retry++){
      item={...item,status:'building',attempts:item.attempts+1,candidate:null,candidatePath:null,candidateDigest:null,completion:undefined};this.save(item);
      try{
        this.current(item);
        const source=this.source(item);
        if(item.space.kind==='code'){
          if(!item.targetBranch)throw new Error('INTEGRATION_TARGET_INVALID');
          item.target=git.inspectIntegrationTarget(project.path,item.targetBranch,item.defaultBranch);
          // Git metadata mutations share the same Store writer path as PW-3.
          const built=this.store.transaction(()=>git.prepareIntegrationCandidate(project.path,item.baseSha!,source,item.target!,randomUUID(),this.projects.mergeContext(item.space.workspaceId!).scratchRoot));
          item={...item,candidate:built.candidate,candidatePath:built.path,sourceSha:built.sourceSha};
        }else{
          if(item.targetBranch!==null)throw new Error('INTEGRATION_TARGET_INVALID');
          const path=join(project.path,'.orbit-integrations',randomUUID());canonical(project.path);
          if(existsSync(dirname(path)))canonical(dirname(path));mkdirSync(path,{recursive:true});item.candidatePath=path;
          const existing=join(project.path,'output');item.generalTargetDigest=existsSync(existing)?scan(existing).sourceDigest:null;if(existsSync(existing)){
            for(const file of scan(existing).files)write(path,{...file,path:'output/'+file.path});
          }
          for(const file of scan(item.space.path).files){
            if(!file.path.startsWith('inputs/')&&!file.path.startsWith('output/'))throw new Error('INTEGRATION_SCOPE');
            write(path,file);
          }
        }
      }catch(error){this.terminal(item,'refused',error instanceof Error&&/^INTEGRATION_[A-Z_]+$/.test(error.message)?error.message:'INTEGRATION_CANDIDATE_REFUSED');return;}
      const fingerprint=()=>item.space.kind==='code'?git.integrationCandidateSnapshot(project.path,item.target!,item.candidate!,item.candidatePath!).sourceDigest:scan(item.candidatePath!).sourceDigest;
      item.candidateDigest=fingerprint();item.status='verifying';this.save(item);
      const priorChecks=new Set(this.candidateChecks().map(c=>c.id));
      const result=await this.verification.verifyIntegration({id:item.id,projectPath:project.path,approvedBaseline:item.approvedBaseline,requiredChecks:item.requiredChecks,configDigest:item.configDigest,context:{workspaceId:item.id,cwd:item.candidatePath!,baseSha:item.target?.head??zero,fingerprint},assertCurrent:()=>this.current(item)});
      if(result==='blocked'){this.block(item,'INTEGRATION_REQUIRED_CHECK_BLOCKED');return;}
      if(result==='failed'){this.terminal(item,'refused','INTEGRATION_VERIFICATION_FAILED');return;}
      if(result==='stale')continue;
      const checkIds=new Set(this.candidateChecks().filter(c=>!priorChecks.has(c.id)&&c.integrationId===item.id).map(c=>c.id));
      const assertFresh=()=>{
        this.current(item);
        if(this.verification.integrationConfigDigest(project.path)!==item.configDigest||fingerprint()!==item.candidateDigest)throw new Error('INTEGRATION_STALE');
        if(item.space.kind==='general'&&(existsSync(join(project.path,'output'))?scan(join(project.path,'output')).sourceDigest:null)!==item.generalTargetDigest)throw new Error('INTEGRATION_STALE');
        if(item.target&&hash(git.inspectIntegrationTarget(project.path,item.targetBranch!,item.defaultBranch))!==hash(item.target))throw new Error('INTEGRATION_STALE');
      };
      const assertVerified=()=>{assertFresh();this.assertCompletion(item,checkIds);assertFresh();};
      try{assertVerified();}catch(error){
        if(error instanceof Error&&error.message.startsWith('INTEGRATION_COMPLETION_')){this.terminal(item,'refused',error.message);return;}
        continue;
      }
      item.status='applying';item.applyStarted=true;this.save(item);
      if(item.space.kind==='code'){
        const result=this.merge.applyIntegration({id:item.id,projectId:item.projectId,workspaceId:item.space.workspaceId!,sourceDigest:item.candidateDigest!,configDigest:item.configDigest,target:item.target!,candidate:item.candidate!},assertVerified);
        if(result.status!=='applied'){this.block(item,'INTEGRATION_APPLY_UNCERTAIN');return;}
      }else{
        try{
          assertVerified();const source=this.source(item);
          // All collisions are checked before the first output write.
          for(const file of source.files){if(!file.path.startsWith('output/')||file.presence!=='present'||existsSync(join(project.path,file.path)))throw new Error('INTEGRATION_CONFLICT');}
          for(const file of source.files)write(project.path,file);
          if(scan(join(project.path,'output')).sourceDigest!==scan(join(item.candidatePath!,'output')).sourceDigest)throw new Error('INTEGRATION_APPLY_UNCERTAIN');
        }catch{this.block(item,'INTEGRATION_APPLY_UNCERTAIN');return;}
      }
      this.terminal(item,'applied');return;
    }
    this.block(item,'INTEGRATION_REBUILD_LIMIT');
  }
  /** Startup recovery only after the previous process/verification is confirmed
   * stopped. Unknown or partial writes retain the global slot and reservation. */
  reconcile(id:string,confirmedStopped:boolean):IntegrationItem {
    if(!confirmedStopped||live.has(id))throw new Error('INTEGRATION_STOP_CONFIRMATION_REQUIRED');
    const item=this.get(id);
    if(finished(item.status)){if(!item.released)this.terminal(item,item.status as 'applied'|'refused',item.reason);return this.get(id);}
    if(!this.store.db.prepare('SELECT id FROM integration_queue WHERE slot=1 AND id=?').get(id))return item;
    if(item.candidate&&item.target){
      const project=this.projects.mergeProject(item.projectId);
      const observed=git.observeMergeApplication(project.path,item.target,item.candidate);
      if(observed==='applied'){
        // An actual MergeService intent is required; matching Git alone is insufficient.
        try{const record=this.merge.record(id);if(record.phase!=='apply'||record.candidate?.commitSha!==item.candidate.commitSha)throw new Error();
          const recovered=this.merge.recover({recordId:id,confirmedStopped:true});
          if(recovered.status!=='applied')throw new Error('INTEGRATION_RECOVERY_UNCERTAIN');
          this.terminal(item,'applied');
        }catch{this.block(item,'INTEGRATION_RECOVERY_UNCERTAIN');}
      }else this.block(item,observed==='not_applied'?'INTEGRATION_INTERRUPTED_NOT_APPLIED':'INTEGRATION_RECOVERY_UNCERTAIN');
    }else if(item.space.kind==='general'&&item.applyStarted){
      try{
        const project=this.projects.generalProject(item.projectId);
        if(!item.candidatePath||scan(item.candidatePath).sourceDigest!==item.candidateDigest
          ||scan(join(project.path,'output')).sourceDigest!==scan(join(item.candidatePath,'output')).sourceDigest)throw new Error();
        this.terminal(item,'applied');
      }catch{this.block(item,'INTEGRATION_RECOVERY_UNCERTAIN');}
    }else this.block(item,'INTEGRATION_RECOVERY_UNCERTAIN');
    return this.get(id);
  }
}
