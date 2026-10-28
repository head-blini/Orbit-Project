import type {CodexModelAttribution} from './codex-model-attribution.ts';
import type {QualityArtifact,QualityBaseline,QualityLoopInput,QualityLoopResult,QualityReview,QualityReviewRequest,QualityRepairRequest} from './quality-loop.ts';
import type {PlanningVersion,SavedTask} from './parallel.ts';
import type {Run} from './types.ts';

/** Only observed adapter metadata may populate modelId/sessionId. Requested aliases are not evidence. */
export interface QualityModelEvidence {
 evidenceSource?:'native'|'mock'|'unknown';
  providerId:string;modelId:string|null;sessionId:string|null;runId:string|null;executionId?:string|null;
  source:'native_observed'|'unknown';
  codex?:CodexModelAttribution;
}
export interface QualitySelection {id:string;providerId:string;modelId:string}
export interface QualityLoopStart {
  requestId:string;projectId:string;sourceRunId:string;reviewers:QualitySelection[];
  limits:QualityLoopInput['limits'];expectedPreviewDigest:string;confirmed:boolean;
}
export interface QualitySnapshot {artifact:QualityArtifact;producer:QualityModelEvidence}
export interface QualityLoopPreview extends QualitySnapshot {
  projectId:string;sourceRunId:string;taskId:string;baseline:QualityBaseline;version:PlanningVersion;task:SavedTask;
  reviewers:QualitySelection[];limits:QualityLoopInput['limits'];previewDigest:string;
}
export interface QualityStep {
  id:string;index:number;kind:'review'|'repair'|'verification';state:'intent'|'completed'|'failed';
  requestDigest:string;startedAt:string;finishedAt:string|null;issue:string|null;
  evidence:QualityModelEvidence|null;result:QualityReview|QualityRepairResult|QualityVerificationResult|null;
}
export interface QualityRepairResult {artifact:QualityArtifact;evidence:QualityModelEvidence}
export interface QualityVerificationResult {status:'passed'|'failed'|'unknown';checkIds:string[];issue:string|null;failures?:import('./quality-loop.ts').QualityFailure[]}
export interface QualityLoopRecord extends QualityLoopPreview {
  id:string;requestId:string;createdAt:string;updatedAt:string;recoveryRequired:boolean;
  result:QualityLoopResult;steps:QualityStep[];verification:QualityVerificationResult;
}
export interface QualityStepContext {
  loopId:string;stepId:string;signal:AbortSignal;sourceRun:Run;version:PlanningVersion;task:SavedTask;
  artifact:QualityArtifact;
}
/** Ports must use existing native approval, quota, privacy and workspace guards. Never fall back to paid APIs. */
export interface QualityServicePorts {
  guard(run:Run):void;
  snapshot(run:Run):QualitySnapshot;
  review(request:QualityReviewRequest,context:QualityStepContext,selection:QualitySelection):Promise<{review:QualityReview;evidence:QualityModelEvidence}>;
  repair(request:QualityRepairRequest,context:QualityStepContext):Promise<QualityRepairResult>;
  verify(context:QualityStepContext):Promise<QualityVerificationResult>;
  /** Observe the original dispatch only; must never launch or retry it. Null means still unknown. */
  recover?(step:QualityStep,context:QualityStepContext):Promise<{result:NonNullable<QualityStep['result']>;evidence:QualityModelEvidence|null}|{failureIssue:string;processStopped:true}|null>;
}
