import type {RuntimeId} from './capability-orchestration.ts';
import type {Execution} from './types.ts';
import type {ProviderExecutionEvidence} from './provider-evidence.ts';

/** Projection of the existing Controller journal, never a new execution engine. */
export interface RuntimeOperationObservation {
 runtimeId:RuntimeId;projectId:string;runId:string;taskId:string|null;
 execution:Execution;terminal:boolean;
 /** Task quiescence confirmed by its terminal journal, not native process exit. Lost is unconfirmed. */
 stopConfirmed:boolean;
 /** Existing sanitized response, available only after successful completion. */
 response:string|null;
 providerEvidence:ProviderExecutionEvidence;
}
