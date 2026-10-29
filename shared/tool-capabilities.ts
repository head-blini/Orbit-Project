import type {QualityEvidenceSource} from './quality-progress.ts';
import type {RuntimeId} from './capability-orchestration.ts';

export type ToolKind='mcp'|'skill'|'plugin'|'hook'|'subagent'|'slash_command';
export interface ToolKey {runtimeId:RuntimeId;kind:ToolKind;itemId:string}
/** TOOLS-D1 itemDigest input: exactly these fields, absent values are null. */
export interface ToolItemMeta {kind:ToolKind;id:string;scope:string|null;handlerType:string|null;nativeTrust:string|null;pluginOwned:boolean|null;runtimeVersion:string|null;adapterRevision:string|null}
export type ToolSectionStatus='available'|'partial'|'unknown'|'not_connected';
/** One discovery section per (runtime, kind); only 'available' lets a missing item read as absent. */
export interface ToolDiscoverySection {runtimeId:RuntimeId;kind:ToolKind;status:ToolSectionStatus;items:ToolItemMeta[]}
export interface ToolGrant {grantId:string;key:ToolKey;itemDigest:string;state?:'active'|'used'|'revoked'|'expired';consumedBy?:{invocationId:string;approvalDigest:string}}
export interface ToolInvocationRecord {key:ToolKey;evidenceSource:QualityEvidenceSource;grantId:string|null;itemDigest:string|null;invocationId?:string;approvedDigest?:string;bindingDigest?:string;nativeObserved?:boolean;callCompleted?:boolean}
export type ToolInstalled='discovered'|'absent'|'unknown';
export interface ToolPermitted {grantId:string;itemDigest:string}
export interface ToolInvoked {native:number;mock:number;unknown:number}
export interface ToolState {key:ToolKey;installed:ToolInstalled;permitted:ToolPermitted|null;invoked:ToolInvoked;verified:number}
export interface ToolTotals {keys:number;installed:number;permitted:number;invoked:ToolInvoked;verified:number}
export interface ToolAggregate {states:ToolState[];totals:ToolTotals}
