import { randomUUID } from 'node:crypto';
import type { Store } from './store.ts';
import type { Projects } from './projects.ts';
import type { SourceGraph } from '../shared/source-graph.ts';
import type { SourceGraphRecord,SourceGraphView,SourceFileView } from '../shared/source-graph-view.ts';
import type { ArchitectureGraph,ArtifactRecord } from '../shared/parallel.ts';
import { analyzeSourceGraph,sourceGraphFileId } from './source-graph.ts';
import { AppError } from './errors.ts';
import { safeText } from './privacy.ts';
import { Studio } from './studio.ts';
import { validateArchitecture } from '../web/visualization/mermaid.ts';

function fileDiagram(graph:SourceGraph):ArchitectureGraph|null {
  const files=graph.nodes.filter(node=>node.kind==='file'),ids=new Map(files.map((node,index)=>[node.id,'f'+index]));
  const diagram:ArchitectureGraph={nodes:files.map((node,index)=>{
    const label=node.path.replace(/[^\p{L}\p{N}_. /()-]/gu,' ').slice(0,150);
    const candidate={id:'f'+index,label,kind:'source file'};
    return validateArchitecture({nodes:[candidate],edges:[]}).ok?candidate:{...candidate,label:'파일 '+(index+1)};
  }),edges:graph.edges.filter(edge=>edge.kind==='imports').map(edge=>({from:ids.get(edge.from)!,to:ids.get(edge.to)!,label:'imports'}))};
  return validateArchitecture(diagram).ok?diagram:null;
}

/** Server-authorized local snapshots only. No provider, runtime code or project config is executed. */
export class SourceGraphService {
  private store:Store;private projects?:Projects;
  constructor(store:Store,projects?:Projects){
    this.store=store;this.projects=projects;
    store.db.exec('CREATE TABLE IF NOT EXISTS source_graph_records(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,body TEXT NOT NULL);');
  }
  private workspace(id:string){
    const workspace=this.store.workspaces().find(workspace=>workspace.id===id&&workspace.status==='ready');
    if(!workspace||!this.projects)throw new AppError('WORKSPACE_NOT_READY',409);return workspace;
  }
  private latest(id:string):SourceGraphRecord|null {
    const row=this.store.db.prepare('SELECT body FROM source_graph_records WHERE workspace_id=? ORDER BY rowid DESC LIMIT 1').get(id);
    return row?JSON.parse(row.body as string):null;
  }
  private record(workspaceId:string,recordId:string):SourceGraphRecord {
    this.workspace(workspaceId);
    const row=this.store.db.prepare('SELECT body FROM source_graph_records WHERE workspace_id=? AND id=?').get(workspaceId,recordId);
    if(!row)throw new AppError('SOURCE_GRAPH_NOT_FOUND',404);return JSON.parse(row.body as string);
  }
  view(workspaceId:string):SourceGraphView {
    this.workspace(workspaceId);const record=this.latest(workspaceId);
    if(!record)return {record:null,freshness:'missing',currentSourceDigest:null};
    try{const currentSourceDigest=this.projects!.fingerprint(workspaceId);
      return {record,freshness:record.graph.sourceDigest===currentSourceDigest?'current':'stale',currentSourceDigest};
    }catch{return {record,freshness:'unavailable',currentSourceDigest:null};}
  }
  analyze(workspaceId:string):SourceGraphView {
    const workspace=this.workspace(workspaceId),snapshot=this.projects!.sourceSnapshot(workspaceId);
    let graph:SourceGraph;
    try{graph=analyzeSourceGraph(snapshot.files,snapshot.sourceDigest,workspace.baseSha);}catch{throw new AppError('SOURCE_GRAPH_UNAVAILABLE',409);}
    if(this.projects!.fingerprint(workspaceId)!==snapshot.sourceDigest)throw new AppError('SOURCE_GRAPH_STALE',409);
    const previous=this.latest(workspaceId);
    // Also refresh when the analyzer's implementation or visible Git change set changes.
    if(previous&&JSON.stringify(previous.graph)===JSON.stringify(graph))return {record:previous,freshness:'current',currentSourceDigest:snapshot.sourceDigest};
    const record:SourceGraphRecord={id:randomUUID(),workspaceId,createdAt:new Date().toISOString(),graph,excludedFileCount:snapshot.excludedFileCount,diagram:fileDiagram(graph)};
    const body=JSON.stringify(record);
    this.store.transaction(()=>{
      const usage=this.store.db.prepare('SELECT count(*) AS count,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM source_graph_records WHERE workspace_id=?').get(workspaceId)!;
      if(Number(usage.count)>=40||Number(usage.bytes)+Buffer.byteLength(body)>16*1024*1024)throw new AppError('SOURCE_GRAPH_QUOTA',413);
      this.store.db.prepare('INSERT INTO source_graph_records VALUES(?,?,?)').run(record.id,workspaceId,body);
      this.store.append('graph.indexed',null,{workspaceId,graphId:record.id,sourceDigest:graph.sourceDigest,files:graph.coverage.files});
    });
    return {record,freshness:'current',currentSourceDigest:snapshot.sourceDigest};
  }
  file(workspaceId:string,recordId:string,nodeId:string):SourceFileView {
    const record=this.record(workspaceId,recordId),node=record.graph.nodes.find(node=>node.id===nodeId&&node.kind==='file');
    if(!node)throw new AppError('SOURCE_FILE_NOT_FOUND',404);
    const snapshot=this.projects!.sourceSnapshot(workspaceId);
    if(snapshot.sourceDigest!==record.graph.sourceDigest)throw new AppError('SOURCE_GRAPH_STALE',409);
    // Recreate IDs from the authoritative manifest; redacted display paths never address files.
    const source=snapshot.files.find(file=>sourceGraphFileId(file.path)===node.id);
    if(!source)throw new AppError('SOURCE_FILE_NOT_FOUND',404);
    const text=safeText(source.content);
    // Redaction can expand short input to the output cap. Conservatively flag a
    // cap-sized response rather than claiming its unseen tail is complete.
    return {path:node.path,text,redacted:text!==source.content,truncated:source.content.length>64000||text.length>=64000,sourceDigest:snapshot.sourceDigest};
  }
  artifact(workspaceId:string,input:{requestId:string;recordId:string;expectedSourceDigest:string}):ArtifactRecord {
    const workspace=this.workspace(workspaceId),record=this.record(workspaceId,input.recordId);
    if(record.graph.sourceDigest!==input.expectedSourceDigest||this.projects!.fingerprint(workspaceId)!==record.graph.sourceDigest)throw new AppError('SOURCE_GRAPH_STALE',409);
    if(!record.diagram)throw new AppError('SOURCE_DIAGRAM_UNAVAILABLE',422);
    return new Studio(this.store).mutate(workspace.projectId,'artifacts',undefined,undefined,{requestId:input.requestId,input:{kind:'architecture',source:JSON.stringify(record.diagram),metadata:{title:'소스 파일 의존도',source_graph_id:record.id,source_workspace_id:workspaceId,source_digest:record.graph.sourceDigest,source_base_sha:record.graph.baseSha,analyzer_version:record.graph.analyzer.version,scope:'file imports (static)'}}}) as ArtifactRecord;
  }
  artifactStatus(projectId:string,id:string,revision:number,hash:string):{freshness:'manual'|'unverified'|'current'|'stale'|'unavailable'} {
    const artifact=(new Studio(this.store).read(projectId,'artifacts',id) as ArtifactRecord[]).find(value=>value.revision===revision);
    if(!artifact||artifact.contentHash!==hash)throw new AppError('REVISION_CONFLICT',409);
    const metadata=artifact.metadata;
    if(!metadata.source_graph_id&&!metadata.source_digest&&!metadata.source_workspace_id)return {freshness:'manual'};
    try{
      const workspace=this.workspace(metadata.source_workspace_id),record=this.record(workspace.id,metadata.source_graph_id);
      if(workspace.projectId!==projectId||artifact.kind!=='architecture'||!record.diagram||artifact.source!==JSON.stringify(record.diagram)||record.graph.sourceDigest!==metadata.source_digest)return {freshness:'unverified'};
      try{return {freshness:this.projects!.fingerprint(workspace.id)===record.graph.sourceDigest?'current':'stale'};}catch{return {freshness:'unavailable'};}
    }catch{return {freshness:'unverified'};}
  }
}
