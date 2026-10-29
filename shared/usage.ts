export interface QuotaWindow {usedPercent:number;remainingPercent:number;windowDurationMins:number|null;resetsAt:string|null}
export interface QuotaBucket {id:string;primary:QuotaWindow|null;secondary:QuotaWindow|null}
export interface CodexUsage {
  status:'available'|'partial'|'unknown';source:'codex_app_server'|'not_queried';checkedAt:string|null;
  buckets:QuotaBucket[]|null;
  summary:{lifetimeTokens:number|null;peakDailyTokens:number|null;longestRunningTurnSec:number|null;currentStreakDays:number|null;longestStreakDays:number|null}|null;
  daily:{date:string;tokens:number|null}[]|null;
  billing:'chatgpt_subscription'|'unknown';apiCostUsd:null;
}

export type SubscriptionUsageFreshness='fresh'|'stale'|'unknown';
export type SubscriptionProviderStatus='allowed'|'allowed_warning'|'rejected'|'unknown';
export type SubscriptionUsageUnknownReason=
  |'QUOTA_UNAVAILABLE'|'WINDOW_INCOMPLETE'|'PROVIDER_STATUS_UNKNOWN'
  |'IDENTITY_UNKNOWN'|'POOL_UNKNOWN'|'EVIDENCE_UNKNOWN'|'OBSERVED_AT_INVALID';
/** Nullable numeric fields preserve status-only observations without inventing quota. */
export interface SubscriptionQuotaWindow extends Omit<QuotaWindow,'usedPercent'|'remainingPercent'> {
  usedPercent:number|null;remainingPercent:number|null;
  remainingSource:'computed'|'unknown';providerStatus:SubscriptionProviderStatus;
}
export interface SubscriptionQuotaBucket extends Omit<QuotaBucket,'primary'|'secondary'> {
  primary:SubscriptionQuotaWindow|null;secondary:SubscriptionQuotaWindow|null;
}
export interface SubscriptionUsageObservation {
  /** Registry IDs identify the target, not a subscription account or pool. */
  providerId:string;runtimeId:string;connectionRef:string;
  accountRef:string|null;identityStatus:'observed'|'unknown';
  source:{interfaceId:string;evidence:'native'|'mock'|'unknown';evidenceRefs:string[]};
  observedAt:string|null;providerObservedAt:null;lastAttemptAt:string|null;
  dataStatus:'available'|'partial'|'unknown';freshness:SubscriptionUsageFreshness;
  providerStatus:SubscriptionProviderStatus;unknownReasons:SubscriptionUsageUnknownReason[];
  buckets:SubscriptionQuotaBucket[]|null;
  poolRef:string|null;sharing:'shared'|'not_shared'|'unknown';poolEvidenceRefs:string[];
}
