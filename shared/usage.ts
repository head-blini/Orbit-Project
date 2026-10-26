export interface QuotaWindow {usedPercent:number;remainingPercent:number;windowDurationMins:number|null;resetsAt:string|null}
export interface QuotaBucket {id:string;primary:QuotaWindow|null;secondary:QuotaWindow|null}
export interface CodexUsage {
  status:'available'|'partial'|'unknown';source:'codex_app_server'|'not_queried';checkedAt:string|null;
  buckets:QuotaBucket[]|null;
  summary:{lifetimeTokens:number|null;peakDailyTokens:number|null;longestRunningTurnSec:number|null;currentStreakDays:number|null;longestStreakDays:number|null}|null;
  daily:{date:string;tokens:number|null}[]|null;
  billing:'chatgpt_subscription'|'unknown';apiCostUsd:null;
}
