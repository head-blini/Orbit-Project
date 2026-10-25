import { createHash,randomUUID } from 'node:crypto';
import { validateMermaid,validateArchitecture } from '../../web/visualization/mermaid.ts';
import { validatePresentationDocument } from '../../web/visualization/presentation.ts';

type Input={kind:'mermaid'|'architecture'|'presentation';source:string;metadata:Record<string,string>};
function validateProject(id:string) {
  if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('INVALID_PROJECT');
}
function validateInput(input:Input) {
  const invalid=()=>{throw new Error('INVALID_ARTIFACT');};
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['kind','source','metadata'].includes(k)) || typeof input.source!=='string' || Buffer.byteLength(input.source,'utf8')>256*1024 || !input.metadata || typeof input.metadata!=='object' || Array.isArray(input.metadata)) return invalid();
  const metadata=Object.entries(input.metadata);
  if(metadata.length>32 || metadata.some(([key,value])=>key.length>64 || typeof value!=='string' || value.length>1000)) return invalid();
  if(input.kind==='mermaid') {if(!validateMermaid(input.source).ok)return invalid();}
  else {
    let value:unknown;try {value=JSON.parse(input.source);} catch {return invalid();}
    if(input.kind==='architecture' ? !validateArchitecture(value).ok : input.kind==='presentation' ? !validatePresentationDocument(value) : true) return invalid();
  }
}

function record(projectId:string,id:string,revision:number,input:Input) {
  return {id,projectId,revision,kind:input.kind,source:input.source,contentHash:createHash('sha256').update(input.source,'utf8').digest('hex'),createdAt:new Date().toISOString(),metadata:structuredClone(input.metadata)};
}

/** Memory implementation only; integration owns authorization, HTTP and persistence. */
export class ArtifactRepository {
  private projects=new Map<string,Map<string,ReturnType<typeof record>[]>>();
  create(projectId:string,input:Input) {
    validateProject(projectId);validateInput(input);
    const value=record(projectId,randomUUID(),1,input);
    let project=this.projects.get(projectId);
    if(!project){project=new Map();this.projects.set(projectId,project);}
    project.set(value.id,[value]);return structuredClone(value);
  }
  revise(projectId:string,id:string,expectedRevision:number,input:Input) {
    const history=this.find(projectId,id);
    if(!Number.isSafeInteger(expectedRevision)||history.at(-1)!.revision!==expectedRevision) throw new Error('REVISION_CONFLICT');
    validateInput(input);
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
