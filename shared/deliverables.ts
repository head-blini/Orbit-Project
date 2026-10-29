/** Files in a general project's server-owned folder, with honest, layered checks. */
export interface DeliverableChecks {
  exists:boolean;readable:boolean;nonEmpty:boolean;
  /** Structural format check only; 'unsupported' means Orbit has no checker for this type. */
  format:'passed'|'failed'|'unsupported';
  /** Whether the content satisfies the task is never inferred from file checks. */
  meaning:'unverified';
  /** Table numbers of a text deliverable compared with the project's input materials.
   * 'passed' only means every table number also appears in an input; it is not semantic proof. */
  evidence?:{status:'passed'|'needs_review'|'unverified';numbers:number;matched:number;unmatched:string[]};
}
/** A user-supplied source file in the project's inputs/ folder. */
// previousVersions: replaced bytes Orbit kept for this path (materials list only).
export interface Material {path:string;size:number;sha256:string;previousVersions?:number}
export interface Deliverable {
  id?:string;
  path:string;size:number;modifiedAt:string;sha256:string;mediaType:string;
  taskId:string|null;taskTitle:string|null;previewable:boolean;checks:DeliverableChecks;
  /** 'input' files are user materials, never AI results. */
  role:'input'|'output';
}
export interface DeliverableList {items:Deliverable[];skipped:number;truncated:boolean}
export type DeliverablePreview=
  |{kind:'text';path:string;mediaType:string;text:string;truncated:boolean}
  |{kind:'unsupported';mediaType:string};

/** Observation history, not a verification verdict. Unknown provenance stays null. */
export interface DeliverableVersion {
  id:string;deliverableId:string;path:string;size:number;sha256:string;
  taskId:string|null;runId:string|null;runAt:string|null;observedAt:string;
  available?:boolean;
}
