/** Additive progress contract. A recorded pass is not a current, observed pass. */
export type QualityEvidenceSource='local'|'native'|'mock'|'unknown';
export type QualityFreshness='current'|'stale'|'unavailable'|'mismatch';
export type QualityStatus='not_run'|'running'|'completed'|'passed'|'failed'|'blocked'|'stale'|'unknown'|'recorded';
export type QualityNextAction='execute_task'|'verify_artifacts'|'verify_code'|'run_quality_review'|'run_independent_review'|'repair_artifacts'|'reverify_artifacts'|'request_user_approval';
export interface QualityDimension {
 evidenceSource?:QualityEvidenceSource;
 status:QualityStatus;evidenceIds:string[];blockers:string[];nextAction:QualityNextAction|null;
}
export interface QualityEvidenceBinding {
 projectId:string|null;taskId:string|null;runId:string|null;planningVersionId:string|null;
 planningContentHash:string|null;acceptanceDigest:string|null;artifactId:string|null;artifactDigest:string|null;
}
export interface QualityProgressEvidence {
 id:string;kind:'artifact_check'|'verification_check'|'quality_loop'|'user_approval';
 evidenceSource:QualityEvidenceSource;freshness:QualityFreshness;recordedStatus:string;
 binding:QualityEvidenceBinding;blockers:string[];
 files?:{path:string;digest:string}[];
}
export interface QualityProgress {
 execution:QualityDimension;format:QualityDimension;codeVerification:QualityDimension;
 semantic:QualityDimension;independentReview:QualityDimension;
 repair:QualityDimension;revalidation:QualityDimension;userApproval:QualityDimension;
 evidence:QualityProgressEvidence[];
}
