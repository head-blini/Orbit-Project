import { createHash,randomUUID } from 'node:crypto';
import { validateMermaid,validateArchitecture,parseMermaidDocument } from '../../web/visualization/mermaid.ts';
import { validatePresentationDocument } from '../../web/visualization/presentation.ts';
import { layoutSequence } from '../../web/visualization/sequence-layout.ts';
import { parseC4 } from '../../web/visualization/c4.ts';
import { layoutC4 } from '../../web/visualization/c4-layout.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactInput,ArtifactRecord } from '../../shared/parallel.ts';

type Input=ArtifactInput;
function validateProject(id:string) {
  if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('INVALID_PROJECT');
}
export function validateArtifactInput(input:Input) {
  const invalid=()=>{throw new Error('INVALID_ARTIFACT');};
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['kind','source','metadata'].includes(k)) || typeof input.source!=='string' || Buffer.byteLength(input.source,'utf8')>256*1024 || !input.metadata || typeof input.metadata!=='object' || Array.isArray(input.metadata)) return invalid();
  const metadata=Object.entries(input.metadata);
  if(metadata.length>32 || metadata.some(([key,value])=>key.length>64 || typeof value!=='string' || value.length>1000)) return invalid();
  if(input.kind==='mermaid') {
    if(!validateMermaid(input.source).ok)return invalid();
    const document=parseMermaidDocument(input.source);
    if(document.kind==='sequence')layoutSequence(document); // A saved source must fit the same preview/export budgets.
  }
  else if(input.kind==='c4')layoutC4(parseC4(input.source));
  else {
    let value:unknown;try {value=JSON.parse(input.source);} catch {return invalid();}
    if(input.kind==='architecture' ? !validateArchitecture(value).ok : input.kind==='presentation' ? !validatePresentationDocument(value) : true) return invalid();
  }
}

function record(projectId:string,id:string,revision:number,input:Input):ArtifactRecord {
  return {id,projectId,revision,kind:input.kind,source:input.source,contentHash:createHash('sha256').update(input.source,'utf8').digest('hex'),createdAt:new Date().toISOString(),metadata:structuredClone(input.metadata)};
}

/** Host supplies the transaction shared with audit events and idempotency receipts. */
export class SqliteArtifactRepository {
  private db:DatabaseSync;
  constructor(db:DatabaseSync){this.db=db;}
  private save(value:ArtifactRecord){
    this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?)').run(value.projectId,value.id,value.revision,JSON.stringify(value));return value;
  }
  create(projectId:string,input:Input):ArtifactRecord {
    validateProject(projectId);validateArtifactInput(input);return this.save(record(projectId,randomUUID(),1,input));
  }
  revise(projectId:string,id:string,expectedRevision:number,input:Input):ArtifactRecord {
    const latest=this.history(projectId,id).at(-1)!;
    if(!Number.isSafeInteger(expectedRevision)||latest.revision!==expectedRevision)throw new Error('REVISION_CONFLICT');
    validateArtifactInput(input);if(input.kind!==latest.kind)throw new Error('ARTIFACT_KIND_IMMUTABLE');
    return this.save(record(projectId,id,expectedRevision+1,input));
  }
  list(projectId:string):ArtifactRecord[]{
    validateProject(projectId);
    return this.db.prepare('SELECT body FROM artifacts a WHERE project_id=? AND revision=(SELECT MAX(revision) FROM artifacts b WHERE b.project_id=a.project_id AND b.id=a.id) ORDER BY rowid').all(projectId).map(row=>JSON.parse(row.body as string));
  }
  history(projectId:string,id:string):ArtifactRecord[]{
    validateProject(projectId);const rows=this.db.prepare('SELECT revision,body FROM artifacts WHERE project_id=? AND id=? ORDER BY revision').all(projectId,id);
    if(!rows.length)throw new Error('ARTIFACT_NOT_FOUND');
    return rows.map(row=>{
      let value:ArtifactRecord;try{value=JSON.parse(row.body as string);}catch{throw new Error('ARTIFACT_INTEGRITY');}
      if(!value||value.projectId!==projectId||value.id!==id||value.revision!==row.revision)throw new Error('ARTIFACT_INTEGRITY');
      return value;
    });
  }
}

/** Memory implementation only; integration owns authorization, HTTP and persistence. */
export class ArtifactRepository {
  private projects=new Map<string,Map<string,ReturnType<typeof record>[]>>();
  create(projectId:string,input:Input) {
    validateProject(projectId);validateArtifactInput(input);
    const value=record(projectId,randomUUID(),1,input);
    let project=this.projects.get(projectId);
    if(!project){project=new Map();this.projects.set(projectId,project);}
    project.set(value.id,[value]);return structuredClone(value);
  }
  revise(projectId:string,id:string,expectedRevision:number,input:Input) {
    const history=this.find(projectId,id);
    if(!Number.isSafeInteger(expectedRevision)||history.at(-1)!.revision!==expectedRevision) throw new Error('REVISION_CONFLICT');
    validateArtifactInput(input);
    if(input.kind!==history[0].kind) throw new Error('ARTIFACT_KIND_IMMUTABLE');
    const value=record(projectId,id,expectedRevision+1,input);
    history.push(value);return structuredClone(value);
  }
  list(projectId:string) {
    validateProject(projectId);
    return [...(this.projects.get(projectId)?.values()??[])].map(history=>structuredClone(history.at(-1)!));
  }
  history(projectId:string,id:string) {return structuredClone(this.find(projectId,id));}
  private find(projectId:string,id:string) {
    validateProject(projectId);
    const history=this.projects.get(projectId)?.get(id);
    if(!history) throw new Error('ARTIFACT_NOT_FOUND');return history;
  }
}
