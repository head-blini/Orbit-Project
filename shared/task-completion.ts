import type {QualityEvidenceBinding, QualityEvidenceSource, QualityFreshness, QualityProgress, QualityStatus} from './quality-progress.ts';
import type {QualityLoopRecord, QualityModelEvidence} from './quality-loop-record.ts';
import type {CheckRecord, VerificationApproval, VerificationCommandPreview} from './verification.ts';

export const CODE_GATES = ['lint', 'type', 'build', 'unit', 'contract', 'e2e'] as const;
export const GENERAL_GATES = ['artifact_format', 'numeric_source', 'semantic_review'] as const;
export type CodeGate = typeof CODE_GATES[number];
export type CompletionGateId = CodeGate | typeof GENERAL_GATES[number];
export interface CompletionPolicy {
  projectKind:'code'|'general';
  requiredGates:CompletionGateId[];
  gateCommandMap:Partial<Record<CodeGate, string[]>>;
  notApplicable:{gate:CompletionGateId;reason:string;approvedBy:string;approvedAt:string}[];
  requireIndependentReview:boolean;
  dependencyRelease:'wait'|'quality_passed'|'quality_passed_and_user_approval';
}
/** A captured evidence binding, never backfilled from the current binding by the evaluator.
 * General artifactDigest denotes a task manifest, not QG-01's project inventory.
 */
export interface CompletionBinding extends QualityEvidenceBinding {
  graphRevision:string|null;contractDigest:string|null;policyDigest:string|null;configDigest:string|null;
  artifactScope:'workspace'|'task_manifest'|null;
  baseSha:string|null;inputSnapshotDigest:string|null;
}
export interface CompletionGate {
  id:CompletionGateId;status:QualityStatus|'not_applicable';evidenceIds:string[];
  source:QualityEvidenceSource;freshness:QualityFreshness;blockers:string[];
}
export type CompletionDecision = Omit<CompletionGate, 'id'>;
export interface TaskCompletion {
  binding:CompletionBinding;policyDigest:string;gates:CompletionGate[];qualityPassed:boolean;
  independentReview:CompletionDecision;userApproval:CompletionDecision;verifiedDone:boolean;reasonCodes:string[];
}
export type CompletionLoop = Pick<QualityLoopRecord, 'id'|'projectId'|'taskId'|'sourceRunId'|'baseline'|'producer'|'reviewers'|'recoveryRequired'|'result'|'steps'|'verification'>;
/** Request-scoped reader inputs, not a second evidence store. Missing supplements fail closed.
 * quality.evidence order is the collector's oldest-to-newest order. Check attempts use createdAt;
 * ambiguous equal timestamps block. Gate results reference existing evidence IDs only.
 * Policy and bindings must come from trusted approved server readers, never worker claims.
 */
export interface CompletionEvidence {
  quality:QualityProgress;
  bindings:Record<string, CompletionBinding>;
  producer?:{binding:CompletionBinding;model:QualityModelEvidence};
  checks:CheckRecord[];
  commands:Pick<VerificationCommandPreview, 'id'|'configDigest'>[];
  loops:CompletionLoop[];
  gateResults:{gate:'artifact_format'|'numeric_source';evidenceId:string;status:QualityStatus}[];
  approvals:VerificationApproval[];
  /** Existing VerificationView.checkSetDigest, not a newly computed CQG check set. */
  checkSetDigest?:string|null;
}

/** Deterministic merge subject. sourceBinding is the worker base and change
 * manifest binding expected by the queue, not evidence copied onto the candidate. */
export interface IntegrationCandidateSubject {
  subject:'integration_candidate';producer:'orbit_merge';
  integrationId:string;candidateDigest:string;targetDigest:string|null;
  sourceBinding:CompletionBinding;
}
export interface CandidateCompletion extends TaskCompletion {
  subject:'integration_candidate';producer:'orbit_merge';
}
export type CandidateCompletionEvidence = Omit<CompletionEvidence,'gateResults'> & {
  gateResults:{gate:'artifact_format'|'numeric_source'|'semantic_review';evidenceId:string;status:QualityStatus}[];
};
