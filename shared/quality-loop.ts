/** modelKey must be a server-resolved canonical provider/model identity, never a display alias. */
export interface QualityIdentity {modelKey:string;sessionId:string}
export interface QualityArtifact {id:string;digest:string}
export interface QualityBaseline {id:string;digest:string;criteria:string[]}
export interface QualityReviewer {id:string;modelKey:string}
export interface QualityCriterion {criterion:string;status:'met'|'not_met'|'unclear';evidence:string}
export interface QualityReview extends QualityIdentity {baselineDigest:string;artifactDigest:string;criteria:QualityCriterion[];findings:string[]}
/** checkIds: verification check ids kept out of free-text evidence so PII inspection can exempt them by field. */
export interface QualityFailure {reviewerId:string;criterion:string|null;evidence:string;status:'not_met'|'unclear';checkIds?:string[]}
export interface QualityRound {number:number;artifact:QualityArtifact;reviews:{reviewerId:string;result:QualityReview}[];failures:QualityFailure[]}
export interface QualityLoopInput {baseline:QualityBaseline;artifact:QualityArtifact;producer:QualityIdentity;reviewers:QualityReviewer[];limits:{maxRepairs:number;maxCalls:number;timeoutMs:number}}
/** passed means unanimous supported AI opinions only; never a CheckRecord pass or user approval.
 * QUALITY_PROCESS_STOP_UNCONFIRMED requires runner recovery before any new execution. */
export interface QualityLoopResult {status:'reviewing'|'repairing'|'passed'|'blocked'|'failed'|'limit_reached';issue:string|null;calls:number;repairs:number;rounds:QualityRound[];artifact:QualityArtifact}
export interface QualityReviewRequest {baseline:QualityBaseline;artifact:QualityArtifact;reviewer:QualityReviewer;signal:AbortSignal}
export interface QualityRepairRequest {baseline:QualityBaseline;artifact:QualityArtifact;failures:QualityFailure[];signal:AbortSignal}
/** Integration must persist publish events and enforce native runner permission, privacy and workspace guards.
 * Calls use fresh sessions and isolated review inputs. No port may resume or expose peer reviews.
 * maxCalls bounds dispatches; it is not a token/cost cap. Native usage caps remain adapter responsibility.
 */
export interface QualityLoopPorts {verify?(request:{baseline:QualityBaseline;artifact:QualityArtifact;signal:AbortSignal}):Promise<QualityFailure[]>;review(request:QualityReviewRequest):Promise<QualityReview>;repair(request:QualityRepairRequest):Promise<QualityIdentity & {artifact:QualityArtifact}>;publish(result:QualityLoopResult):void|Promise<void>}
