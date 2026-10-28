/** Execution origin is independent of model identity and of a successful quality opinion. */
export interface ProviderExecutionEvidence {
 source:'native'|'mock'|'unknown';interface:'codex.app_server'|'claude.print'|'unknown';
 executionObserved:boolean;responseDigest:string|null;
 quality:'not_started'|'blocked'|'passed'|'failed'|'running';livePipelineVerified:boolean;
 costUsd:null;remainingQuota:null;
}
