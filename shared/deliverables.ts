/** Files in a general project's server-owned folder, with honest, layered checks. */
export interface DeliverableChecks {
  exists:boolean;readable:boolean;nonEmpty:boolean;
  /** Structural format check only; 'unsupported' means Orbit has no checker for this type. */
  format:'passed'|'failed'|'unsupported';
  /** Whether the content satisfies the task is never inferred from file checks. */
  meaning:'unverified';
}
export interface Deliverable {
  path:string;size:number;modifiedAt:string;sha256:string;mediaType:string;
  taskId:string|null;taskTitle:string|null;previewable:boolean;checks:DeliverableChecks;
}
export interface DeliverableList {items:Deliverable[];skipped:number;truncated:boolean}
export type DeliverablePreview=
  |{kind:'text';path:string;mediaType:string;text:string;truncated:boolean}
  |{kind:'unsupported';mediaType:string};
