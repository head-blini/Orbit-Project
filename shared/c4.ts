/** Authored C4 views. These records do not assert source-code or runtime verification. */
export interface C4Element {
  id:string;kind:'person'|'system'|'container'|'component';name:string;description:string;
  parentId:string|null;technology:string|null;
}
export interface C4Relationship {id:string;from:string;to:string;description:string;technology:string|null}
export interface C4Diagram {
  format:'c4-v1';title:string;view:'context'|'container'|'component';scope:string;
  elements:C4Element[];relationships:C4Relationship[];
}
export const C4_LIMITS=Object.freeze({elements:12,relationships:24,id:64,name:80,description:160,technology:80,sourceBytes:256*1024,issues:32});
