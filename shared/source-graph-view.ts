import type { SourceGraph } from './source-graph.ts';
import type { ArchitectureGraph } from './parallel.ts';
export interface SourceGraphRecord {
  id:string;workspaceId:string;createdAt:string;graph:SourceGraph;excludedFileCount:number;
  diagram:ArchitectureGraph|null;
}
export interface SourceGraphView {
  record:SourceGraphRecord|null;freshness:'missing'|'current'|'stale'|'unavailable';currentSourceDigest:string|null;
}
export interface SourceFileView {path:string;text:string;redacted:boolean;truncated:boolean;sourceDigest:string}
