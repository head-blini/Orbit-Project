import {createHash} from 'node:crypto';
import {CODE_GATES, GENERAL_GATES} from '../shared/task-completion.ts';
import type {CandidateCompletion, CandidateCompletionEvidence, IntegrationCandidateSubject, CodeGate, CompletionBinding, CompletionDecision, CompletionEvidence, CompletionGate, CompletionPolicy, TaskCompletion} from '../shared/task-completion.ts';
import type {QualityModelEvidence} from '../shared/quality-loop-record.ts';
import type {QualityFreshness} from '../shared/quality-progress.ts';

const present = (v:unknown):v is string => typeof v==='string' && v.trim().length>0;
const sorted = (v:string[]) => [...new Set(v)].sort();
/** Stable field ordering; gate/command order is not policy semantics. */
export function completionPolicyDigest(policy:CompletionPolicy):string {
  return createHash('sha256').update(JSON.stringify({projectKind:policy.projectKind,
    requiredGates:sorted(policy.requiredGates),gateCommandMap:CODE_GATES.map(g=>[g,sorted(policy.gateCommandMap[g]??[])]),
    notApplicable:[...policy.notApplicable].sort((a,b)=>a.gate.localeCompare(b.gate)).map(n=>({gate:n.gate,reason:n.reason,approvedBy:n.approvedBy,approvedAt:n.approvedAt})),
    requireIndependentReview:policy.requireIndependentReview,dependencyRelease:policy.dependencyRelease})).digest('hex');
}
const baseKeys = ['projectId','taskId','runId','planningVersionId','planningContentHash','acceptanceDigest','artifactId','artifactDigest','graphRevision','contractDigest','policyDigest','configDigest','artifactScope'] as const;
const ownership = new Set<string>(['projectId','taskId','runId','artifactId']);
function modelIssue(model:QualityModelEvidence|undefined|null):string[] {
  const issues:string[]=[];
  if(model?.evidenceSource!=='native')issues.push('CQG_AI_NATIVE_REQUIRED');
  if(model?.source!=='native_observed'||![model?.providerId,model?.modelId,model?.sessionId,model?.runId].every(present)
    ||model?.modelId?.split('/').some(s=>s.toLowerCase()==='unknown'))issues.push('CQG_MODEL_OBSERVATION_REQUIRED');
  return issues;
}
function decision(blockers:string[]=[], evidenceIds:string[]=[]):CompletionDecision {
  return {status:blockers.length?'blocked':'passed',evidenceIds,source:'unknown',freshness:'unavailable',blockers:sorted(blockers)};
}
function worst(values:QualityFreshness[]):QualityFreshness {
  return values.includes('mismatch')?'mismatch':values.includes('stale')?'stale':values.includes('unavailable')?'unavailable':'current';
}
/** Pure projection: no IO, execution, clock, persistence, recovery or approval creation. */
export function evaluateTaskCompletion(evidence:CompletionEvidence, policy:CompletionPolicy, binding:CompletionBinding):TaskCompletion {
  return evaluateCompletion(evidence,policy,binding);
}
/** The task entry point never accepts a candidate subject or relaxes AI provenance. */
function evaluateCompletion(evidence:CandidateCompletionEvidence, policy:CompletionPolicy, binding:CompletionBinding, candidate?:{subject:IntegrationCandidateSubject;source:TaskCompletion|null}):TaskCompletion {
  const q=evidence.quality, policyDigest=completionPolicyDigest(policy);
  const keys: (keyof CompletionBinding)[]=[...baseKeys,policy.projectKind==='code'?'baseSha':'inputSnapshotDigest'];
  function compare(value:Partial<CompletionBinding>|undefined, selectedKeys=keys):CompletionDecision {
    const reasons:string[]=[], states:QualityFreshness[]=[];
    for(const key of selectedKeys){
      if(!present(binding[key])||!present(value?.[key])){reasons.push(`CQG_BINDING_MISSING:${key}`);states.push('unavailable');}
      else if(value![key]!==binding[key]){reasons.push(`CQG_BINDING_CHANGED:${key}`);states.push(ownership.has(key)?'mismatch':'stale');}
    }
    return {...decision(reasons),freshness:worst(states)};
  }
  function assess(id:string, kind:string):CompletionDecision {
    const matches=q.evidence.filter(e=>e.id===id), e=matches[0];
    if(matches.length!==1||!e||e.kind!==kind)return decision(['CQG_EVIDENCE_MISSING_OR_AMBIGUOUS'],[id]);
    const b=compare(evidence.bindings[id]);
    // The original QG binding is mandatory too; supplemental metadata cannot repair a null.
    const original=compare(e.binding,['projectId','taskId','runId','planningVersionId','planningContentHash','acceptanceDigest','artifactId','artifactDigest']);
    const blockers=[...b.blockers,...original.blockers,...e.blockers];
    const freshness=worst([b.freshness,original.freshness,e.freshness]);
    if(freshness!=='current')blockers.push(`CQG_EVIDENCE_${freshness.toUpperCase()}`);
    if(!['passed','completed','approved'].includes(e.recordedStatus))blockers.push('CQG_EVIDENCE_NOT_PASSED');
    const recorded=e.evidenceSource==='mock'||e.evidenceSource==='unknown';
    if(recorded)blockers.push('CQG_OBSERVED_EVIDENCE_REQUIRED');
    return {status:freshness==='stale'?'stale':recorded?'recorded':blockers.length?'blocked':'passed',evidenceIds:[id],source:e.evidenceSource,freshness,blockers:sorted(blockers)};
  }
  const reasons=[...compare(binding).blockers];
  if(binding.policyDigest!==policyDigest)reasons.push('CQG_POLICY_DIGEST_MISMATCH');
  if(binding.artifactScope!==(policy.projectKind==='code'?'workspace':'task_manifest'))reasons.push('CQG_ARTIFACT_SCOPE_REQUIRED');
  const allowed=policy.projectKind==='code'?CODE_GATES:GENERAL_GATES;
  if(!policy.requiredGates.length||policy.requiredGates.some(g=>!(allowed as readonly string[]).includes(g))
    ||new Set(policy.requiredGates).size!==policy.requiredGates.length
    ||new Set(policy.notApplicable.map(n=>n.gate)).size!==policy.notApplicable.length
    ||!['wait','quality_passed','quality_passed_and_user_approval'].includes(policy.dependencyRelease))reasons.push('CQG_POLICY_INVALID');
  const producer=evidence.producer;
  if(candidate){
    const {subject,source}=candidate;
    if(subject.subject!=='integration_candidate'||subject.producer!=='orbit_merge'
      ||subject.integrationId!==binding.artifactId||subject.candidateDigest!==binding.artifactDigest
      ||(policy.projectKind==='code'&&subject.targetDigest!==binding.baseSha))reasons.push('CQG_CANDIDATE_SUBJECT_MISMATCH');
    if(!source?.verifiedDone){reasons.push('CQG_SOURCE_NOT_VERIFIED_DONE',...(source?.reasonCodes??[]));}
    const expected=subject.sourceBinding;
    for(const key of keys){
      if(!present(expected[key])||!present(source?.binding[key])||expected[key]!==source?.binding[key])reasons.push(`CQG_SOURCE_BINDING_MISMATCH:${key}`);
    }
    for(const key of ['projectId','taskId','runId','planningVersionId','planningContentHash','acceptanceDigest','graphRevision','contractDigest','policyDigest'] as const){
      if(expected[key]!==binding[key])reasons.push(`CQG_SOURCE_BINDING_MISMATCH:${key}`);
    }
    if(source?.policyDigest!==policyDigest)reasons.push('CQG_SOURCE_POLICY_MISMATCH');
  }else{
    reasons.push(...compare(producer?.binding).blockers,...modelIssue(producer?.model));
    if(producer?.model.runId!==binding.runId)reasons.push('CQG_PRODUCER_RUN_MISMATCH');
    if(q.execution.status!=='completed'||q.execution.evidenceSource!=='native')reasons.push('CQG_EXECUTION_NOT_OBSERVED_COMPLETE');
    reasons.push(...q.execution.blockers);
  }

  const loopId=q.independentReview.evidenceIds.at(-1)??q.semantic.evidenceIds.at(-1);
  const loopMatches=evidence.loops.filter(l=>l.id===loopId), loop=loopMatches.length===1?loopMatches[0]:undefined;
  let independentReview=loopId?assess(loopId,'quality_loop'):decision(['CQG_REVIEW_MISSING']);
  const reviewReasons=[...independentReview.blockers,...q.independentReview.blockers];
  if(q.independentReview.status!=='completed')reviewReasons.push('CQG_INDEPENDENT_REVIEW_REQUIRED');
  let semanticPassed=false;
  const repairIds:string[]=[];
  if(loop){
    reviewReasons.push(...modelIssue(loop.producer));
    if(loop.projectId!==binding.projectId||loop.taskId!==binding.taskId||loop.sourceRunId!==binding.runId
      ||loop.baseline.id!==binding.planningVersionId||loop.baseline.digest!==binding.planningContentHash
      ||loop.result.artifact.id!==binding.artifactId||loop.result.artifact.digest!==binding.artifactDigest)reviewReasons.push('CQG_REVIEW_BINDING_MISMATCH');
    if(JSON.stringify(loop.producer)!==JSON.stringify(producer?.model))reviewReasons.push('CQG_PRODUCER_IDENTITY_MISMATCH');
    if(loop.recoveryRequired||loop.result.issue||!['passed','failed'].includes(loop.result.status))reviewReasons.push('CQG_REVIEW_RECOVERY_OR_FAILURE');
    const round=loop.result.rounds.at(-1);
    const models=new Set([`${loop.producer.providerId}/${loop.producer.modelId}`]),sessions=new Set([loop.producer.sessionId]),runs=new Set([loop.producer.runId]);
    const repairs=loop.steps.filter(s=>s.kind==='repair');
    const lastRepair=Math.max(-1,...repairs.map(s=>s.index));
    for(const step of repairs){
      reviewReasons.push(...modelIssue(step.evidence));
      if(step.state!=='completed'||step.issue)reviewReasons.push('CQG_REPAIR_INCOMPLETE');
      const m=step.evidence;if(m){models.add(`${m.providerId}/${m.modelId}`);sessions.add(m.sessionId);runs.add(m.runId);}
    }
    if(!round||round.artifact.id!==binding.artifactId||round.artifact.digest!==binding.artifactDigest||!loop.reviewers.length
      ||new Set(loop.reviewers.map(r=>r.id)).size!==loop.reviewers.length||round.reviews.length!==loop.reviewers.length)reviewReasons.push('CQG_REVIEW_MISSING');
    else for(const reviewer of loop.reviewers){
      const opinions=round.reviews.filter(r=>r.reviewerId===reviewer.id),opinion=opinions[0]?.result;
      const steps=loop.steps.filter(s=>s.kind==='review'&&s.index>lastRepair&&s.state==='completed'&&JSON.stringify(s.result)===JSON.stringify(opinion));
      const step=steps.length===1?steps[0]:undefined,m=step?.evidence,key=`${m?.providerId}/${m?.modelId}`;
      reviewReasons.push(...modelIssue(m));
      if(opinions.length!==1||!step||step.issue||!opinion||key!==`${reviewer.providerId}/${reviewer.modelId}`||key!==opinion.modelKey||m?.sessionId!==opinion.sessionId
        ||models.has(key)||sessions.has(m?.sessionId??null)||runs.has(m?.runId??null))reviewReasons.push('CQG_INDEPENDENT_REVIEW_REQUIRED');
      models.add(key);sessions.add(m?.sessionId??null);runs.add(m?.runId??null);
      if(!opinion||opinion.baselineDigest!==binding.planningContentHash||opinion.artifactDigest!==binding.artifactDigest
        ||!loop.baseline.criteria.length||opinion.criteria.length!==loop.baseline.criteria.length
        ||new Set(opinion.criteria.map(c=>c.criterion)).size!==loop.baseline.criteria.length
        ||!loop.baseline.criteria.every(c=>opinion.criteria.some(v=>v.criterion===c&&present(v.evidence))))reviewReasons.push('CQG_REVIEW_CRITERIA_MISMATCH');
    }
    semanticPassed=!!round&&loop.result.status==='passed'&&round.failures.length===0&&round.reviews.every(r=>!r.result.findings.length&&r.result.criteria.every(c=>c.status==='met'));
    if(repairs.length||loop.result.repairs>0||q.repair.status!=='not_run'){
      const repair=repairs.at(-1),result=repair?.result;
      const verification=loop.steps.filter(s=>s.kind==='verification'&&s.index>lastRepair).at(-1);
      const verified=verification?.result;
      if(!repair||!result||!('artifact' in result)||result.artifact.digest!==binding.artifactDigest
        ||!verification||verification.state!=='completed'||!verified||!('checkIds' in verified)||verified.status!=='passed'
        ||!verified.checkIds.length||q.revalidation.status!=='passed'||q.revalidation.blockers.length||loop.verification.status!=='passed')reviewReasons.push('CQG_REVERIFICATION_REQUIRED');
      else repairIds.push(...verified.checkIds);
    }
  }else reviewReasons.push('CQG_REVIEW_MISSING');
  if(loop){
    const sources=[independentReview.source,loop.producer.evidenceSource,...loop.steps.filter(s=>s.kind!=='verification').map(s=>s.evidence?.evidenceSource)];
    const source=sources.includes('mock')?'mock':sources.every(s=>s==='native')?'native':'unknown';
    independentReview={...independentReview,source,status:source==='mock'||source==='unknown'?'recorded':independentReview.status};
  }
  independentReview={...independentReview,status:reviewReasons.length?(independentReview.status==='recorded'?'recorded':'blocked'):'completed',blockers:sorted(reviewReasons)};

  const gates:CompletionGate[]=policy.requiredGates.map(id=>{
    const na=policy.notApplicable.find(n=>n.gate===id);
    if(na){const approved=present(na.reason)&&present(na.approvedBy)&&present(na.approvedAt)&&Number.isFinite(Date.parse(na.approvedAt));
      return {id,...decision(approved?[]:['CQG_NA_APPROVAL_REQUIRED']),status:approved?'not_applicable':'blocked',source:'local',freshness:'current'};}
    if(id==='semantic_review'&&!candidate){
      const blockers=[...independentReview.blockers,...q.semantic.blockers];
      if(!semanticPassed||q.semantic.status!=='passed'||!q.semantic.evidenceIds.includes(loopId!))blockers.push('CQG_SEMANTIC_REVIEW_REQUIRED');
      return {id,...independentReview,status:independentReview.freshness==='stale'?'stale':independentReview.status==='recorded'?'recorded':blockers.length?'blocked':'passed',blockers:sorted(blockers)};
    }
    if(id==='artifact_format'||id==='numeric_source'||id==='semantic_review'){
      const results=evidence.gateResults.filter(r=>r.gate===id);
      const latestId=[...q.evidence].reverse().find(e=>results.some(r=>r.evidenceId===e.id))?.id;
      const selected=results.filter(r=>r.evidenceId===latestId);
      const result=selected.length===1?selected[0]:undefined;
      if(!result)return {id,...decision([id==='semantic_review'?'CQG_SEMANTIC_REVIEW_REQUIRED':'CQG_GATE_EVIDENCE_MISSING'])};
      const state=assess(result.evidenceId,'artifact_check');
      if(result.status!=='passed')state.blockers.push('CQG_GATE_NOT_PASSED');
      if(state.source!=='local')state.blockers.push('CQG_LOCAL_CHECK_REQUIRED');
      return {id,...state,status:state.status==='recorded'?'recorded':state.blockers.length?'blocked':'passed',blockers:sorted(state.blockers)};
    }
    const commands=policy.gateCommandMap[id as CodeGate]??[];
    if(!commands.length)return {id,...decision(['CQG_GATE_COMMAND_MISSING'])};
    const states=commands.map(commandId=>{
      const attempts=evidence.checks.filter(c=>c.commandId===commandId&&c.runId===binding.runId&&c.projectId===binding.projectId&&c.workspaceId===binding.artifactId)
        .sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      const c=attempts[0];if(!c)return decision(['CQG_GATE_EVIDENCE_MISSING']);
      const state=assess(c.id,'verification_check'),config=evidence.commands.filter(c=>c.id===commandId);
      if(!Number.isFinite(Date.parse(c.createdAt))||attempts[1]?.createdAt===c.createdAt)state.blockers.push('CQG_CHECK_ORDER_AMBIGUOUS');
      if(c.execution!=='completed'||c.verdict!=='passed'||c.exitCode!==0||!present(c.completedAt))state.blockers.push('CQG_CHECK_NOT_PASSED');
      if(c.evidenceSource!=='local'||state.source!=='local')state.blockers.push('CQG_LOCAL_CHECK_REQUIRED');
      const checkBinding=compare({...evidence.bindings[c.id],projectId:c.projectId,taskId:c.taskId,runId:c.runId,planningVersionId:c.planningVersionId,planningContentHash:c.planningContentHash,acceptanceDigest:c.acceptanceDigest,artifactId:c.workspaceId,artifactDigest:c.finishedDigest,baseSha:c.baseSha});
      state.blockers.push(...checkBinding.blockers);state.freshness=worst([state.freshness,checkBinding.freshness]);
      if(config.length!==1||config[0].configDigest!==c.configDigest||!present(c.configDigest)||c.sourceDigest!==c.finishedDigest){state.blockers.push('CQG_CHECK_CONFIGURATION_OR_SOURCE_CHANGED');state.freshness='stale';}
      return state;
    });
    const blockers=sorted(states.flatMap(s=>s.blockers)),freshness=worst(states.map(s=>s.freshness));
    const source=states.some(s=>s.source==='mock')?'mock':states.every(s=>s.source==='local')?'local':'unknown';
    return {id,status:freshness==='stale'?'stale':source==='mock'||source==='unknown'?'recorded':blockers.length?'blocked':'passed',evidenceIds:sorted(states.flatMap(s=>s.evidenceIds)),source,freshness,blockers};
  });
  reasons.push(...gates.flatMap(g=>g.blockers));
  if(!candidate&&(policy.projectKind==='general'||policy.requireIndependentReview||loopId))reasons.push(...independentReview.blockers);
  if(!candidate&&(loop?.steps.some(s=>s.kind==='repair')||loop?.result.repairs||q.repair.status!=='not_run')){
    reasons.push(...independentReview.blockers);
    const localIds=gates.filter(g=>g.id!=='semantic_review'&&g.status!=='not_applicable').flatMap(g=>g.evidenceIds);
    if(!repairIds.length||localIds.some(id=>!repairIds.includes(id)))reasons.push('CQG_REVERIFICATION_REQUIRED');
  }
  let userApproval=decision(['CQG_USER_APPROVAL_REQUIRED']);
  const approvalId=q.userApproval.evidenceIds.at(-1);
  if(approvalId){
    userApproval=assess(approvalId,'user_approval');
    const approvals=evidence.approvals.filter(a=>a.id===approvalId),a=approvals[0];
    // General final approvals have no existing authoritative record contract yet.
    if(policy.projectKind!=='code'||approvals.length!==1||!a||a.runId!==binding.runId||a.workspaceId!==binding.artifactId
      ||a.sourceDigest!==binding.artifactDigest||!present(evidence.checkSetDigest)||a.checkSetDigest!==evidence.checkSetDigest
      ||q.userApproval.status!=='passed'||q.userApproval.blockers.length||userApproval.source!=='local')userApproval.blockers.push('CQG_USER_APPROVAL_REQUIRED');
    userApproval={...userApproval,status:userApproval.blockers.length?'blocked':'passed',blockers:sorted(userApproval.blockers)};
  }
  const qualityPassed=reasons.length===0&&gates.every(g=>g.status==='passed'||g.status==='not_applicable');
  if(policy.dependencyRelease==='wait')reasons.push('CQG_DEPENDENCY_RELEASE_WAIT');
  if(policy.dependencyRelease==='quality_passed_and_user_approval')reasons.push(...userApproval.blockers);
  const verifiedDone=qualityPassed&&(policy.dependencyRelease==='quality_passed'||policy.dependencyRelease==='quality_passed_and_user_approval'&&userApproval.status==='passed');
  return {binding:{...binding},policyDigest,gates,qualityPassed,independentReview,userApproval,verifiedDone,reasonCodes:sorted(reasons)};
}

/** Pure candidate projection. Source completion must be freshly read by the server
 * through CQG-1; only local candidate checks can satisfy candidate gates. */
export function evaluateCandidateCompletion(evidence:CandidateCompletionEvidence,policy:CompletionPolicy,binding:CompletionBinding,subject:IntegrationCandidateSubject,source:TaskCompletion|null):CandidateCompletion {
  const result=evaluateCompletion(evidence,policy,binding,{subject,source});
  return {...result,subject:'integration_candidate',producer:'orbit_merge',independentReview:source?.independentReview??decision(['CQG_SOURCE_NOT_VERIFIED_DONE'])};
}
