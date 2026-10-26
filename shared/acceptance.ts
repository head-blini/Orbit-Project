/** Bounded integrity evidence only; selected files do not establish complete acceptance coverage. */
export interface TaskVerificationPreview {
  projectId:string;workspaceId:string;taskId:string;planningVersionId:string;planHash:string;baseSha:string;
  criteria:{label:string;description:string;acceptanceCriteria:string[]}[];
  commands:{id:string;label:string;configDigest:string;protectedFiles:string[]}[];
  files:{path:string;mode:string;sha256:string}[];
  digest:string;scope:string;
}
export interface TaskAcceptanceStatus {
  state:'unbound'|'current'|'changed'|'unavailable';baseline:TaskVerificationPreview|null;issue:string|null;
}
