import type {Store} from './store.ts';
import {AppError} from './errors.ts';
import {FailureIndex} from './failure-index.ts';
import {FailureCaseStore,type FailureCaseReader} from './failure-cases.ts';
import {HarnessStore,type HarnessPromotionGrant,type HarnessRollback} from './harness-store.ts';
import {HarnessEvaluation,type HarnessEvaluationPorts,type HarnessEvaluationRunner,type HarnessEvaluationRequest,type HarnessPromotionApproval} from './harness-evaluation.ts';
import {HarnessEffects} from './harness-effects.ts';
import {generateHarnessCandidates} from './harness-candidates.ts';
import {classifyHarnessCandidate} from './harness-policy.ts';
import type {HarnessEvidence,HarnessProjectView,HarnessTarget} from '../shared/harness.ts';

/** HE-7 wiring facade (docs/ORBIT-HE-D1.md 2(e)). It owns the only HarnessStore instance with the HE-4
 * approval port, so a pointer promotion is possible only with a fresh, user-approved, live-passed evaluation.
 * No runner is built here: without an injected one, evaluation is refused (no model call, no live runner). */
export interface HarnessServiceOptions {
  /** Injected only by tests/hosts; server/main.ts injects none (live evaluation needs separate user approval). */
  runner?:HarnessEvaluationRunner;
  /** Server-owned normal/protected suites. Default empty: evaluation stays HARNESS_EVAL_SUITE_INCOMPLETE. */
  suite?:HarnessEvaluationPorts['suite'];
}
export interface HarnessUserProposal {requestId:string;target:HarnessTarget;line:string;evidence:HarnessEvidence|null;confirmed:true}

export class HarnessService {
  private store:Store;private index:FailureIndex;private runner:HarnessEvaluationRunner|null;
  readonly versions:HarnessStore;private evaluation:HarnessEvaluation;private effects:HarnessEffects;
  private caseStore:FailureCaseStore|null=null;private caseReader:FailureCaseReader;
  constructor(store:Store,options:HarnessServiceOptions={}){
    this.store=store;this.index=new FailureIndex(store);this.runner=options.runner??null;
    // Reads never create failure_cases (FE-4): without the table every case is simply absent.
    const cases:FailureCaseReader=this.caseReader={
      getCase:caseId=>{if(!this.casesExist())throw new AppError('FAILURE_CASE_NOT_FOUND',404);return (this.caseStore??=new FailureCaseStore(store)).getCase(caseId);},
      listCases:familyId=>this.casesExist()?(this.caseStore??=new FailureCaseStore(store)).listCases(familyId):[],
    };
    const unavailable:HarnessEvaluationRunner={mode:'fake',runCase:()=>Promise.reject(new AppError('HARNESS_EVAL_RUNNER_UNAVAILABLE',409))};
    let evaluation:HarnessEvaluation|null=null;
    this.versions=new HarnessStore(store,{cases,promotions:{getApprovedPromotion:requestId=>evaluation?.getApprovedPromotion(requestId)??null}});
    evaluation=this.evaluation=new HarnessEvaluation(store,{harness:this.versions,cases,runner:options.runner??unavailable,
      suite:options.suite??{normalCases:()=>[],protectedCases:()=>[]}});
    this.effects=new HarnessEffects(store,{harness:this.versions,evaluation,failures:this.index});
  }
  private casesExist(){return !!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='failure_cases'").get();}
  private project(projectId:string){if(!this.store.projects().some(p=>p.id===projectId))throw new AppError('PROJECT_NOT_FOUND',404);}

  /** Read-only. Adds line text, evidence, AX06 status and approval freshness to the HE-6 effects view. */
  view(projectId:string):HarnessProjectView{
    this.project(projectId);
    const effects=this.effects.view(projectId);
    return {projectId,runnerMode:this.runner?.mode??null,targets:effects.targets.map(t=>{
      let stored:ReturnType<HarnessStore['listVersions']>=[];
      try{stored=t.state==='ok'?this.versions.listVersions(projectId,t.target):[];}catch{/* the effects view already reports the error */}
      const byId=new Map(stored.map(s=>[s.version.versionId,s]));
      return {...t,versions:t.versions.flatMap(v=>{
        const s=byId.get(v.versionId);
        if(!s)return [];
        const classification=v.revision===0?{status:'eligible' as const}:classifyHarnessCandidate({class:s.version.class,target:s.version.target,lines:s.version.lines,origin:s.provenance.origin,evidence:s.provenance.evidence});
        return [{...v,lines:[...s.version.lines],evidence:s.provenance.evidence,classification,
          approvals:v.approvals.map(a=>({...a,fresh:this.evaluation.getApprovedPromotion(a.requestId)?.expectedSequence===t.pointerSequence}))}];
      })};
    })};
  }

  generate(projectId:string){
    this.project(projectId);
    const result=generateHarnessCandidates(projectId,{failures:this.index,cases:this.caseReader,harness:this.versions});
    return {stored:result.stored.map(s=>s.version.versionId),blocked:result.blocked.map(d=>({target:d.candidate.target,ruleId:d.ruleId,classification:d.classification})),skipped:result.skipped};
  }

  /** User-origin proposal (HE-D1 2(b) "사용자 제안"): one appended line on the active pointer. Evidence is optional, but
   * any cited case must reproduce a failure of this project; without failing cases it can never pass HE-4 evaluation. */
  propose(projectId:string,input:HarnessUserProposal){
    this.project(projectId);
    if(input.confirmed!==true)throw new AppError('HARNESS_APPROVAL_REQUIRED',409);
    if(typeof input.line!=='string')throw new AppError('HARNESS_INVALID',400);
    if(input.evidence!==null){
      const known=new Set(this.index.list(projectId).map(r=>r.id));
      const ids=Array.isArray(input.evidence?.caseIds)?input.evidence.caseIds:[];
      for(const caseId of ids){
        let failureId:string;
        try{failureId=this.caseReader.getCase(caseId).failureId;}catch{throw new AppError('HARNESS_PROVENANCE',409);}
        if(!known.has(failureId))throw new AppError('HARNESS_PROVENANCE',409);
      }
    }
    const parent=this.versions.current(projectId,input.target);
    const record=this.versions.append({projectId,requestId:input.requestId,parentId:parent.versionId,
      candidate:{class:'execution_guidance',target:input.target,lines:[...parent.lines,input.line],origin:'user',evidence:input.evidence}});
    return {versionId:record.version.versionId,revision:record.version.revision,digest:record.version.digest};
  }

  async evaluate(projectId:string,input:Omit<HarnessEvaluationRequest,'projectId'>){
    this.project(projectId);
    if(!this.runner)throw new AppError('HARNESS_EVAL_RUNNER_UNAVAILABLE',409);
    const r=await this.evaluation.evaluate({...input,projectId});
    return {evaluationId:r.evaluationId,verdict:r.verdict,runnerMode:r.runnerMode,reasons:r.reasons,candidateDigest:r.candidateDigest,evaluationDigest:r.evaluationDigest,
      verified:r.verdict==='passed'&&r.runnerMode==='live'};
  }

  approve(projectId:string,input:Omit<HarnessPromotionApproval,'projectId'>&{expectedSequence:number}){
    this.project(projectId);
    const {expectedSequence,...approval}=input;
    return this.evaluation.approvePromotion({...approval,projectId},expectedSequence);
  }

  /** The only promotion path: HarnessStore re-reads the grant through getApprovedPromotion inside its transaction. */
  promote(projectId:string,input:Omit<HarnessPromotionGrant,'projectId'>){this.project(projectId);return this.versions.promote({...input,projectId});}
  rollback(projectId:string,input:Omit<HarnessRollback,'projectId'>){this.project(projectId);return this.versions.rollback({...input,projectId});}
}
