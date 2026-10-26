import type {Execution} from './types.ts';
import type {NativeProcessObservation} from './native-process.ts';
export type NativeNotCreatedReason='CODEX_NOT_INSTALLED'|'LAUNCH_REJECTED_BEFORE_SPAWN';

export interface NativeConnectionEvidence {
  schemaVersion:1;runtimeId:'codex';ownerIncarnation:string;generation:number;
  createdAt:string;updatedAt:string;nativeSessionId:string|null;transportClosedAt:string|null;
  process:NativeProcessObservation|null;
  /** Observation collection completeness, never execution/resource release authority. */
  journalState:'open'|'closed';notCreatedReason:NativeNotCreatedReason|null;
}

/** Server-observed connection identity only; never OS termination or release proof. */
export interface SoloOperationIdentity {
  runtimeId:'codex';ownerIncarnation:string;generation:number;nativeSessionId:string;
}
export interface SoloOperationRecord extends SoloOperationIdentity {
  schemaVersion:1;runId:string;requestId:string;workspaceId:string|null;nativeTurnId:string|null;
  execution:Execution;revision:number;createdAt:string;updatedAt:string;eventKind:string;
}
export interface SoloOperationView {
  runId:string;identity:'recorded'|'legacy_unknown';record:SoloOperationRecord|null;history:SoloOperationRecord[];
  connection:NativeConnectionEvidence|null;
}
