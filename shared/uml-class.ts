/** Inert authored UML class model. It does not attest source-code or runtime structure. */
export type ClassAnnotation='interface'|'abstract'|'enumeration';
export interface ClassNode {
  id:string;
  name:string;
  annotation:ClassAnnotation|null;
  attributes:string[];
  operations:string[];
}
export type ClassRelationshipKind='inheritance'|'composition'|'aggregation'|'association'|'dependency'|'realization'|'solid-link'|'dashed-link';
export interface ClassRelationship {
  id:string;
  kind:ClassRelationshipKind;
  from:string;
  to:string;
  fromMultiplicity:string|null;
  toMultiplicity:string|null;
  label:string|null;
}
export interface ClassDiagram {kind:'class';classes:ClassNode[];relationships:ClassRelationship[]}
export const CLASS_LIMITS=Object.freeze({classes:10,membersPerClass:16,members:80,relationships:20,sourceBytes:256*1024,lines:1024,name:80,text:160,issues:32,multiplicity:999});
