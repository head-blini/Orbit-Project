import type {QualityLoopInput,QualityLoopPorts,QualityLoopResult,QualityReview,QualityRound} from '../shared/quality-loop.ts';
import {containsCredential} from './privacy.ts';
import {inspectOutbound} from './guardrails/outbound.ts';
const digest=(s:string)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const nonempty=(s:unknown):s is string=>typeof s==='string'&&s.trim().length>0;
const knownModel=(s:unknown):s is string=>nonempty(s)&&!s.split('/').some(part=>part.toLowerCase()==='unknown');
const clone=<T>(value:T):T=>structuredClone(value);
// Random digit runs in SHA-256 digests and UUIDs match phone/national-id patterns (~1.4% of digests), so PII
// inspection skips only schema identifier fields whose value is such an identifier; free text and credentials stay fully inspected.
const identifierFields=new Set(['id','digest','baselineDigest','artifactDigest','sessionId','runId','executionId','checkIds']);
const opaqueIdentifier=(v:unknown)=>typeof v==='string'&&/^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(v);
const withoutIdentifiers=(key:string,v:unknown)=>!identifierFields.has(key)?v:opaqueIdentifier(v)?'':Array.isArray(v)?v.map(x=>opaqueIdentifier(x)?'':x):v;
export const qualityEvidenceBlocked=(value:unknown)=>containsCredential(JSON.stringify(value))||inspectOutbound(JSON.stringify(value,withoutIdentifiers)).length>0;
/** Bounded policy coordinator; native execution, approval and durable recovery remain owned by existing services.
 * Not exposed via HTTP until those adapters are wired. This function never spawns processes.
 */
export async function runQualityLoop(source:QualityLoopInput,ports:QualityLoopPorts):Promise<QualityLoopResult>{
  const input=clone(source),{baseline,limits}=input;
  const result:QualityLoopResult={status:'blocked',issue:null,calls:0,repairs:0,rounds:[],artifact:clone(input.artifact)};
  const emit=async()=>{const visible=clone(result);if(visible.status==='reviewing')for(const round of visible.rounds)round.reviews=[];await ports.publish(visible);};
  const finish=async(status:QualityLoopResult['status'],issue:string|null)=>{result.status=status;result.issue=issue;await emit();return clone(result);};
  if(!baseline.criteria.length||new Set(baseline.criteria).size!==baseline.criteria.length||!baseline.criteria.every(nonempty)||!digest(baseline.digest)||!digest(input.artifact.digest)||!knownModel(input.producer.modelKey)||!nonempty(input.producer.sessionId))return finish('blocked','QUALITY_BASELINE_OR_SOURCE_INVALID');
  if(!Number.isSafeInteger(limits.maxRepairs)||limits.maxRepairs<0||limits.maxRepairs>20||!Number.isSafeInteger(limits.maxCalls)||limits.maxCalls<1||limits.maxCalls>100||!Number.isSafeInteger(limits.timeoutMs)||limits.timeoutMs<1||limits.timeoutMs>3600000)return finish('blocked','QUALITY_LIMITS_INVALID');
  const models=input.reviewers.map(r=>r.modelKey);
  if(!models.length||!models.every(knownModel)||models.includes(input.producer.modelKey)||new Set(models).size!==models.length||new Set(input.reviewers.map(r=>r.id)).size!==models.length)return finish('blocked','INDEPENDENT_MODEL_REQUIRED');
  const sessions=new Set([input.producer.sessionId]);
  const controller=new AbortController(),deadline=Date.now()+limits.timeoutMs;
  const timer=setTimeout(()=>controller.abort(),limits.timeoutMs);
  async function bounded<T>(operation:()=>Promise<T>):Promise<T>{
    if(controller.signal.aborted)throw Error('QUALITY_TIME_LIMIT');
    let abort:()=>void=()=>{};
    const expired=new Promise<never>((_,reject)=>{abort=()=>reject(Error('QUALITY_PROCESS_STOP_UNCONFIRMED'));controller.signal.addEventListener('abort',abort,{once:true});});
    try{return await Promise.race([operation(),expired]);}finally{controller.signal.removeEventListener('abort',abort);}
  }
  const limited=(calls:number)=>controller.signal.aborted||Date.now()>=deadline||result.calls+calls>limits.maxCalls;
  function validate(review:QualityReview,modelKey:string){
    if(review.modelKey!==modelKey||!nonempty(review.sessionId)||sessions.has(review.sessionId)||review.baselineDigest!==baseline.digest||review.artifactDigest!==result.artifact.digest)throw Error('QUALITY_EVIDENCE_MISMATCH');
    if(!Array.isArray(review.criteria)||review.criteria.length!==baseline.criteria.length||new Set(review.criteria.map(c=>c.criterion)).size!==baseline.criteria.length||!review.criteria.every(c=>baseline.criteria.includes(c.criterion)&&['met','not_met','unclear'].includes(c.status)&&nonempty(c.evidence)&&c.evidence.length<=4000)||!Array.isArray(review.findings)||review.findings.length>50||!review.findings.every(f=>nonempty(f)&&f.length<=4000))throw Error('QUALITY_EVIDENCE_INVALID');
    if(qualityEvidenceBlocked(review))throw Error('QUALITY_EVIDENCE_BLOCKED');
    sessions.add(review.sessionId);
  }
  try{
    while(true){
      if(limited(input.reviewers.length))return await finish('limit_reached','QUALITY_CALL_OR_TIME_LIMIT');
      const round:QualityRound={number:result.repairs+1,artifact:clone(result.artifact),reviews:[],failures:[]};result.rounds.push(round);result.status='reviewing';await emit();
      // Each request contains the same immutable baseline/source and no other opinion, including prior rounds.
      // Serial dispatch supports existing single-runner locks while preserving informational independence.
      for(const reviewer of input.reviewers){
        if(limited(1))return await finish('limit_reached','QUALITY_CALL_OR_TIME_LIMIT');
        result.calls++;const review=await bounded(()=>ports.review({baseline:clone(baseline),artifact:clone(result.artifact),reviewer:clone(reviewer),signal:controller.signal}));
        if(limited(0))return await finish('limit_reached','QUALITY_CALL_OR_TIME_LIMIT');
        validate(review,reviewer.modelKey);round.reviews.push({reviewerId:reviewer.id,result:clone(review)});await emit();
      }
      for(const {reviewerId,result:review} of round.reviews){
        for(const c of review.criteria)if(c.status!=='met')round.failures.push({reviewerId,criterion:c.criterion,status:c.status,evidence:c.evidence});
        for(const evidence of review.findings)round.failures.push({reviewerId,criterion:null,status:'not_met',evidence});
      }
      if(ports.verify){
        const failures=await bounded(()=>ports.verify!({baseline:clone(baseline),artifact:clone(result.artifact),signal:controller.signal}));
        if(!Array.isArray(failures)||failures.length>100||!failures.every(f=>nonempty(f.reviewerId)&&(f.criterion===null||baseline.criteria.includes(f.criterion))&&['not_met','unclear'].includes(f.status)&&nonempty(f.evidence)&&f.evidence.length<=4000))throw Error('QUALITY_EVIDENCE_INVALID');
        if(qualityEvidenceBlocked(failures))throw Error('QUALITY_EVIDENCE_BLOCKED');
        round.failures.push(...clone(failures));
        if(limited(0))return await finish('limit_reached','QUALITY_CALL_OR_TIME_LIMIT');
      }
      if(!round.failures.length)return await finish('passed',null);
      if(result.repairs>=limits.maxRepairs||limited(1+input.reviewers.length))return await finish('limit_reached','QUALITY_REPAIR_OR_CALL_LIMIT');
      result.status='repairing';await emit();result.calls++;
      const repair=await bounded(()=>ports.repair({baseline:clone(baseline),artifact:clone(result.artifact),failures:clone(round.failures),signal:controller.signal}));
      if(limited(0))return await finish('limit_reached','QUALITY_CALL_OR_TIME_LIMIT');
      if(!knownModel(repair.modelKey)||models.includes(repair.modelKey)||!nonempty(repair.sessionId)||sessions.has(repair.sessionId)||repair.artifact.id!==result.artifact.id||!digest(repair.artifact.digest))throw Error('QUALITY_REPAIR_EVIDENCE_INVALID');
      sessions.add(repair.sessionId);result.artifact=clone(repair.artifact);result.repairs++;await emit();
    }
  }catch(error){
    const code=error instanceof Error?error.message:'';
    const issue=['QUALITY_MODEL_MISMATCH','QUALITY_QUOTA_EXHAUSTED','QUALITY_PERMISSION_DENIED','QUALITY_EXECUTION_LOST','QUALITY_EVIDENCE_MISMATCH','QUALITY_EVIDENCE_INVALID','QUALITY_EVIDENCE_BLOCKED','QUALITY_REPAIR_EVIDENCE_INVALID','QUALITY_MODEL_UNKNOWN','QUALITY_SOURCE_CHANGED','QUALITY_PROCESS_STOP_UNCONFIRMED'].includes(code)?code:'QUALITY_STEP_FAILED';
    return await finish(controller.signal.aborted?'limit_reached':'failed',controller.signal.aborted?'QUALITY_PROCESS_STOP_UNCONFIRMED':issue);
  }
  finally{clearTimeout(timer);}
}
