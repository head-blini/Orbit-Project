import type {Execution} from './types.ts';

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
}
