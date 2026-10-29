/** Trusted server contracts, not browser assertions or execution permission.
 * PW-2 checks approval/current baseline; PW-3 supplies fresh filesystem identity
 * evidence. This module neither probes paths nor starts a runtime. */
export interface ApprovedExecutionBatch {
  id:string;
  projectId:string;
  planningVersionId:string;
  graphRevision:number;
  planningHash:string;
  taskIds:string[];
  contractDigests:{id:string;digest:string}[];
  inputArtifactHashes:{id:string;hash:string}[];
  runtimeChoices:{taskId:string;runtimeId:string}[];
  parallelLimit:number;
}
/** canonicalPath must come from trusted isolation checks, including symlink,
 * hardlink and case aliases. For globs, verify the containing scope, not matches.
 * Unknown identity is refused; these fields alone do not prove filesystem safety. */
export interface WorkerPath {
  path:string;
  canonicalPath:string;
  aliasStatus:'verified_no_alias'|'alias'|'unknown';
}
/** repositoryId is RepositoryAuthority's canonical identity, not a worktree path.
 * host is a stable server-resolved machine identity, not a user-supplied DNS alias.
 * targetKey must identify the actual authorized external object across aliases.
 * Physical paths use canonical absolute POSIX syntax; ambiguous spellings fail closed. */
export type WorkerResourceClaim =
  | {kind:'repository_file';repositoryId:string;path:WorkerPath;mode:'read'|'write'}
  | {kind:'isolated_folder';host:string;path:WorkerPath}
  | {kind:'db_file_group';host:string;path:WorkerPath}
  | {kind:'port';host:string;protocol:'tcp'|'udp';address:string;port:number}
  | {kind:'external_target';targetKey:string};
export type WorkerState='reserved'|'dispatched'|'running'|'terminal_confirmed'|'lost_unknown'|'released';
export interface WorkerAttempt {
  id:string;
  taskId:string;
  runtimeId:string;
  /** Existing CapabilityExecution dispatch request, not a second dispatch journal. */
  dispatchRequestId:string;
}
export interface WorkerReserveInput {
  requestId:string;
  ownerIncarnation:string;
  batch:ApprovedExecutionBatch;
  attempt:WorkerAttempt;
  claims:WorkerResourceClaim[];
}
export interface WorkerFence {
  reservationId:string;
  ownerIncarnation:string;
  fencingGeneration:number;
}
/** Supplied only by trusted receipt/recovery adapters, never directly by clients.
 * Terminal evidence must establish process termination, not transport closure. */
export interface WorkerReleaseEvidence {
  kind:'terminal_confirmed'|'not_dispatched';
  dispatchRequestId:string;
  evidenceId:string;
}
export interface WorkerReservation extends WorkerFence {
  requestId:string;
  batch:ApprovedExecutionBatch;
  attempt:WorkerAttempt;
  claims:WorkerResourceClaim[];
  state:WorkerState;
  evidence:WorkerReleaseEvidence|null;
  createdAt:string;
  updatedAt:string;
}
export const WORKER_LIMITS:Readonly<{total:number;perRuntime:Readonly<Record<string,number>>}>=Object.freeze({
  total:2,perRuntime:Object.freeze({codex:1,'claude-code':2}),
});
