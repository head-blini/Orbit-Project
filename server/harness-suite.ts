import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import {AppError} from './errors.ts';
import {containsCredential} from './privacy.ts';
import {currentGoalCompletion} from '../shared/goals.ts';
import type {ProjectProgress} from '../shared/project-progress.ts';
import type {CompletionBinding} from '../shared/task-completion.ts';
import type {HarnessSuiteCaseRecord,HarnessSuiteView,HarnessTarget} from '../shared/harness.ts';
import type {HarnessEvaluationPorts,HarnessSuiteCase} from './harness-evaluation.ts';

/** HE-SUITE: the server-owned normal/protected suite of docs/ORBIT-HE-D1.md 2(d) and default 6
 * ("정상 case는 사용자가 수동으로 등록한다(통과 Run의 digest manifest)"). A case is a digest manifest plus
 * provenance only; no prompt, output, path or other run content is ever copied. History is append-only:
 * removal appends an event, it never deletes. Protected cases use the same user registration flow, flagged
 * protected (HE-D1 does not define another selection rule). */
export interface HarnessSuiteRegistration {requestId:string;runId:string;taskId:string;target:HarnessTarget;protected:boolean;confirmed:true}
export interface HarnessSuiteRemoval {requestId:string;caseId:string;confirmed:true}
/** Server reader of the current CQG task completion (ProjectProgressService.read). Never a client claim. */
export type HarnessSuiteProgressReader=(projectId:string)=>ProjectProgress;

/** Only targets HE-4 can evaluate (Claude runtime; HE-D1 default 4). */
const SUITE_TARGETS:readonly HarnessTarget[]=['claude_task','repair'];
/** Matches HE-4 MAX_SUITE_CASES; a larger kind would make every evaluation HARNESS_EVAL_SUITE_INVALID. */
export const HARNESS_SUITE_MAX_CASES=64;

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function fail(code:string,status=409):never{throw new AppError(code,status);}
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v:unknown,keys:readonly string[])=>plain(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/u.test(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$(?![\s\S])/u.test(v);
/** Key-order independent digest of the captured completion binding. */
export const completionBindingDigest=(binding:CompletionBinding)=>sha(JSON.stringify(['orbit-completion-binding/1',Object.entries(binding).sort(([a],[b])=>a<b?-1:1)]));
/** The suite-case digest HE-4 fixes at evaluation start: content only, so any change to the manifest changes it. */
export const harnessSuiteCaseDigest=(c:Omit<HarnessSuiteCaseRecord,'digest'|'registeredAt'|'requestId'>)=>sha(JSON.stringify(['orbit-harness-suite-case/1',
  c.caseId,c.projectId,c.target,c.protected,c.runId,c.taskId,c.completionBindingDigest,c.policyDigest,c.artifactDigest]));

export class HarnessSuiteStore {
  private store:Store;
  constructor(store:Store){
    this.store=store;
    // SAVEPOINT: atomic standalone and inside a caller's transaction (same as HarnessStore).
    store.db.exec('SAVEPOINT harness_suite_init');
    try{
      store.db.exec(`CREATE TABLE IF NOT EXISTS harness_suite_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,request_id TEXT NOT NULL,
        request_digest TEXT NOT NULL,action TEXT NOT NULL,case_id TEXT NOT NULL,body TEXT NOT NULL,body_digest TEXT NOT NULL,UNIQUE(project_id,request_id));
        CREATE TRIGGER IF NOT EXISTS harness_suite_events_no_update BEFORE UPDATE ON harness_suite_events BEGIN SELECT RAISE(ABORT,'HARNESS_APPEND_ONLY'); END;
        CREATE TRIGGER IF NOT EXISTS harness_suite_events_no_delete BEFORE DELETE ON harness_suite_events BEGIN SELECT RAISE(ABORT,'HARNESS_APPEND_ONLY'); END;`);
      store.db.exec('RELEASE harness_suite_init');
    }catch(error){store.db.exec('ROLLBACK TO harness_suite_init; RELEASE harness_suite_init');throw error;}
  }

  /** Replays the append-only log. Any tampered row fails the whole read (HARNESS_INTEGRITY). */
  private events(projectId:string){
    return this.store.db.prepare('SELECT action,case_id,body,body_digest FROM harness_suite_events WHERE project_id=? ORDER BY seq').all(projectId).map(row=>{
      if(typeof row.body!=='string'||sha(row.body)!==row.body_digest)fail('HARNESS_INTEGRITY');
      const body=JSON.parse(String(row.body)) as {action:string;record?:HarnessSuiteCaseRecord;caseId?:string;at:string};
      if(body.action!==row.action||(body.record?.caseId??body.caseId)!==row.case_id)fail('HARNESS_INTEGRITY');
      if(body.record){
        const {digest,registeredAt:_r,requestId:_q,...rest}=body.record;
        if(body.record.projectId!==projectId||digest!==harnessSuiteCaseDigest(rest))fail('HARNESS_INTEGRITY');
      }
      return body;
    });
  }

  /** Read-only. Active cases (registered and not removed), oldest first. */
  list(projectId:string):HarnessSuiteCaseRecord[]{
    const active=new Map<string,HarnessSuiteCaseRecord>();
    for(const e of this.events(projectId)){if(e.action==='register'&&e.record)active.set(e.record.caseId,e.record);else if(e.action==='remove')active.delete(e.caseId!);}
    return [...active.values()];
  }

  /** HE-4 suite port. Throws on a corrupt log so evaluation cannot run on a silently shrunk suite. */
  port():HarnessEvaluationPorts['suite']{
    const pick=(projectId:string,target:HarnessTarget,protectedCase:boolean):HarnessSuiteCase[]=>
      this.list(projectId).filter(c=>c.target===target&&c.protected===protectedCase).map(c=>({caseId:c.caseId,digest:c.digest}));
    return {normalCases:(p,t)=>pick(p,t,false),protectedCases:(p,t)=>pick(p,t,true)};
  }

  view(projectId:string):HarnessSuiteView{
    let cases:HarnessSuiteCaseRecord[];
    try{cases=this.list(projectId);}catch(error){return {state:'error',error:error instanceof AppError?error.message:'HARNESS_INTEGRITY',targets:[],cases:[]};}
    return {state:'ok',error:null,cases,targets:SUITE_TARGETS.map(target=>({target,normal:cases.filter(c=>c.target===target&&!c.protected).length,
      protected:cases.filter(c=>c.target===target&&c.protected).length,
      digest:sha(JSON.stringify(['orbit-harness-suite-registered/1',target,cases.filter(c=>c.target===target).map(c=>[c.caseId,c.protected,c.digest])]))}))};
  }

  private replay(projectId:string,requestId:string,requestDigest:string){
    const prior=this.store.db.prepare('SELECT request_digest,body,body_digest FROM harness_suite_events WHERE project_id=? AND request_id=?').get(projectId,requestId);
    if(!prior)return null;
    if(prior.request_digest!==requestDigest)fail('HARNESS_REQUEST_CONFLICT');
    if(typeof prior.body!=='string'||sha(prior.body)!==prior.body_digest)fail('HARNESS_INTEGRITY');
    return JSON.parse(String(prior.body)) as {record?:HarnessSuiteCaseRecord;caseId?:string};
  }
  private append(projectId:string,requestId:string,requestDigest:string,action:'register'|'remove',caseId:string,body:object){
    const text=JSON.stringify(body);
    if(containsCredential(text))fail('HARNESS_UNSAFE_TEXT');
    this.store.db.prepare('INSERT INTO harness_suite_events(project_id,request_id,request_digest,action,case_id,body,body_digest) VALUES(?,?,?,?,?,?,?)')
      .run(projectId,requestId,requestDigest,action,caseId,text,sha(text));
  }

  /** Explicit user registration. Accepts only a run that is its task's latest run and whose CQG completion is
   * verifiedDone and current right now (verifiedDone already requires native producer evidence; mock, unknown
   * and stale decisions are refused by currentGoalCompletion). */
  register(projectId:string,input:HarnessSuiteRegistration,readProgress:HarnessSuiteProgressReader):HarnessSuiteCaseRecord{
    if(!exact(input,['requestId','runId','taskId','target','protected','confirmed'])||![projectId,input.requestId,input.runId,input.taskId].every(id)
      ||typeof input.protected!=='boolean'||typeof input.target!=='string')fail('HARNESS_SUITE_INVALID',400);
    if(input.confirmed!==true)fail('HARNESS_APPROVAL_REQUIRED');
    if(!SUITE_TARGETS.includes(input.target))fail('HARNESS_EVAL_RUNTIME_UNSUPPORTED');
    const requestDigest=sha(JSON.stringify(['register',projectId,input.requestId,input.runId,input.taskId,input.target,input.protected]));
    const replayed=()=>{const prior=this.replay(projectId,input.requestId,requestDigest);return prior?prior.record??fail('HARNESS_INTEGRITY'):null;};
    const done=replayed();
    if(done)return done;
    // The progress reader opens its own transaction, so the completion is read first and the append re-checks replay.
    const run=this.store.getRun(input.runId);
    if(!run||run.taskId!==input.taskId)fail('HARNESS_SUITE_RUN_NOT_FOUND',404);
    if(run.runtime!=='claude-code')fail('HARNESS_EVAL_RUNTIME_UNSUPPORTED');
    if(run.execution!=='completed')fail('HARNESS_SUITE_RUN_NOT_VERIFIED');
    const task=readProgress(projectId).tasks.find(t=>t.id===input.taskId);
    if(!task)fail('HARNESS_SUITE_RUN_NOT_FOUND',404);
    if(task.latestRunId!==input.runId)fail('HARNESS_SUITE_RUN_NOT_CURRENT');
    const completion=task.completion,binding=completion?.binding;
    if(!completion||!binding||!currentGoalCompletion(completion)||completion.reasonCodes.length
      ||binding.projectId!==projectId||binding.taskId!==input.taskId||binding.runId!==input.runId||!hex(completion.policyDigest))fail('HARNESS_SUITE_RUN_NOT_VERIFIED');
    return this.store.transaction(()=>{
      const raced=replayed();
      if(raced)return raced;
      const active=this.list(projectId);
      if(active.some(c=>c.runId===input.runId&&c.target===input.target))fail('HARNESS_SUITE_DUPLICATE');
      if(active.filter(c=>c.target===input.target&&c.protected===input.protected).length>=HARNESS_SUITE_MAX_CASES)fail('HARNESS_SUITE_FULL');
      const manifest={caseId:randomUUID(),projectId,target:input.target,protected:input.protected,runId:input.runId,taskId:input.taskId,
        completionBindingDigest:completionBindingDigest(binding),policyDigest:completion.policyDigest,artifactDigest:binding.artifactDigest};
      const record:HarnessSuiteCaseRecord={...manifest,digest:harnessSuiteCaseDigest(manifest),requestId:input.requestId,registeredAt:new Date().toISOString()};
      this.append(projectId,input.requestId,requestDigest,'register',record.caseId,{action:'register',record,at:record.registeredAt});
      return record;
    });
  }

  /** Explicit, confirmed removal; appends a 'remove' event. The registration stays in history. */
  remove(projectId:string,input:HarnessSuiteRemoval):{caseId:string;removed:true}{
    if(!exact(input,['requestId','caseId','confirmed'])||![projectId,input.requestId,input.caseId].every(id))fail('HARNESS_SUITE_INVALID',400);
    if(input.confirmed!==true)fail('HARNESS_APPROVAL_REQUIRED');
    const requestDigest=sha(JSON.stringify(['remove',projectId,input.requestId,input.caseId]));
    return this.store.transaction(()=>{
      if(this.replay(projectId,input.requestId,requestDigest))return {caseId:input.caseId,removed:true as const};
      if(!this.list(projectId).some(c=>c.caseId===input.caseId))fail('HARNESS_SUITE_CASE_NOT_FOUND',404);
      this.append(projectId,input.requestId,requestDigest,'remove',input.caseId,{action:'remove',caseId:input.caseId,at:new Date().toISOString()});
      return {caseId:input.caseId,removed:true as const};
    });
  }
}
