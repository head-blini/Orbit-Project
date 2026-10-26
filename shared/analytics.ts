/** Observations are not billing records. Missing measurements remain null. */
export interface TokenCounters {
  inputTokens:number;cachedInputTokens:number;cacheWriteInputTokens:number;
  outputTokens:number;reasoningOutputTokens:number;totalTokens:number;
}
export type TokenIssue = 'NO_BASELINE'|'NO_OBSERVATION'|'INVALID_OBSERVATION'|'DISCONTINUITY'|'BUFFER_LIMIT'|'CONNECTION_LOST'|'STORAGE_UNAVAILABLE';
export interface RunMetrics {
  runId:string;threadId:string;turnId:string|null;
  modelAtStart:string|null;modelProvider:string|null;modelChanged:boolean;
  tokens:TokenCounters|null;tokenStatus:'unknown'|'observed'|'incomplete';tokenIssue:TokenIssue|null;
  observedAt:string|null;finishedAt:string|null;durationMs:number|null;
  retryNotices:number|null;
}
export type AnalyticsKind = 'coding'|'model_hub'|'planning'|'review'|'workflow';
export interface CheckCounts {total:number;passed:number;failed:number;interrupted:number;timedOut:number;stale:number;running:number;lost:number;notRun:number}
export interface AnalyticsRecord {
  id:string;kind:AnalyticsKind;workspaceId:string|null;taskId:string|null;
  providerId:string|null;model:string|null;modelChanged:boolean;
  execution:string;createdAt:string;finishedAt:string|null;durationMs:number|null;
  tokens:{inputTokens:number|null;outputTokens:number|null;totalTokens:number|null};
  tokenSource:'codex_observed_delta'|'provider'|'unknown';tokenStatus:'observed'|'incomplete'|'unknown';
  observedAt:string|null;retryCount:number|null;retrySource:'workflow_lineage'|'unknown';retryNotices:number|null;
  checks:CheckCounts;
}
export interface AnalyticsTotals {
  records:number;completed:number;failed:number;active:number;interrupted:number;lost:number;timedOut:number;stale:number;unknown:number;
  tokenSubtotal:number|null;tokenKnownRecords:number;tokenUnknownRecords:number;tokenIncompleteRecords:number;
  durationSubtotalMs:number|null;durationKnownRecords:number;durationUnknownRecords:number;
  workflowRetries:number;checks:CheckCounts;
}
export interface ProjectAnalytics {
  projectId:string;generatedAt:string;source:'local_records';costUsd:null;
  totals:AnalyticsTotals;
  groups:{kind:AnalyticsKind;providerId:string|null;model:string|null;totals:AnalyticsTotals}[];
  records:AnalyticsRecord[];nextCursor:string|null;
}
