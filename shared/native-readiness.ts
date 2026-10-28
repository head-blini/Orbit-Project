export type ClaudeAuthentication='subscription'|'not_authenticated'|'unsupported'|'unknown'|'not_installed';
export interface ClaudeAuthenticationReport {
 checkedAt:string;authentication:ClaudeAuthentication;source:'claude.auth.status';issue:string|null;
}
/** Cached status projection; refreshing diagnostics never dispatches a model task. */
export interface NativeReadinessReport {
 codex:{installation:import('./capabilities.ts').NativeProbe;authentication:'confirmed'|'unknown';connection:import('./types.ts').ProviderStatus};
 claude:{installation:import('./capabilities.ts').NativeProbe;authentication:ClaudeAuthenticationReport|null};
 actualModel:'unknown';liveValidation:'approval_required';costUsd:null;remainingQuota:null;
}
