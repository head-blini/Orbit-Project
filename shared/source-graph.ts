export const SOURCE_GRAPH_LIMITS=Object.freeze({maxFiles:100,maxFileBytes:256*1024,maxTotalBytes:4*1024*1024,maxAstNodes:100000,maxAstDepth:128,maxNodes:2000,maxEdges:5000,maxImpactVisits:10000});
export interface SourceGraphInput {path:string;content:string;changed:boolean}
export type SourceGraphNodeKind='file'|'function'|'class'|'method';
export interface SourceGraphNode {id:string;kind:SourceGraphNodeKind;label:string;fileId:string;path:string;line:number;changed:boolean}
export interface SourceGraphEdge {id:string;kind:'contains'|'imports'|'calls'|'extends';from:string;to:string;evidence:'syntax'|'typechecker';staticOnly:true}
export type SourceGraphUnresolvedReason='external_import'|'unresolved_import'|'dynamic_import'|'unresolved_call'|'dynamic_call'|'unresolved_extends'|'unsupported_declaration';
export interface SourceGraph {
  status:'available';analyzer:{name:'typescript-static';version:string;policyVersion:string};sourceDigest:string;baseSha:string;
  nodes:SourceGraphNode[];edges:SourceGraphEdge[];changedFileIds:string[];
  impact:{nodeIds:string[];fileIds:string[];evidence:'potential-static-reverse-dependency';truncated:false};
  unresolved:{total:number;byReason:Record<SourceGraphUnresolvedReason,number>};
  coverage:{files:number;limits:typeof SOURCE_GRAPH_LIMITS;externalResolution:false;runtimeAccuracy:false;limitations:string[]};
}
