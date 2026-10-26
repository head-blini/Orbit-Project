import {lstatSync,realpathSync,mkdirSync,writeFileSync,readFileSync,readdirSync,unlinkSync,rmdirSync,type BigIntStats} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {AppError} from '../errors.ts';

const owner='orbit-bedrock-input-v1',known=new Set(['owner.json','config','credentials','boto','request.json']);
export const bedrockRequestId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function unavailable(code='BEDROCK_CLEANUP_REQUIRED'):never{throw new AppError(code,503);}
function stat(path:string):BigIntStats|null {try{return lstatSync(path,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
function directory(path:string){
  if(typeof path!=='string'||!isAbsolute(path)||/[\x00-\x1f\x7f]/.test(path)||path.split(/[\\/]/).some(part=>part==='.'||part==='..'))unavailable();
  const root=resolve(path);for(let p=root;;p=dirname(p)){const value=stat(p);if(!value?.isDirectory()||value.isSymbolicLink()||realpathSync(p).toLowerCase()!==p.toLowerCase())unavailable();if(dirname(p)===p)break;}return root;
}
function location(requestId:string,tempRoot?:string){if(!bedrockRequestId(requestId))unavailable();const root=directory(tempRoot??tmpdir());return join(root,'orbit-bedrock-'+requestId);}
export interface BedrockTemporary {path:string;requestId:string;config:string;credentials:string;boto:string}
export function createBedrockTemporary(requestId:string,tempRoot?:string):BedrockTemporary {
  try{
    const path=location(requestId,tempRoot);mkdirSync(path,{mode:0o700});
    writeFileSync(join(path,'owner.json'),JSON.stringify({owner,requestId}),{flag:'wx',mode:0o600});
    for(const name of ['config','credentials','boto'])writeFileSync(join(path,name),'',{flag:'wx',mode:0o600});
    return {path,requestId,config:join(path,'config'),credentials:join(path,'credentials'),boto:join(path,'boto')};
  }catch{unavailable('BEDROCK_TEMPORARY_INPUT_FAILED');}
}
export function writeBedrockRequest(temporary:BedrockTemporary,bytes:Uint8Array){
  try{if(bytes.byteLength>256*1024)throw new Error();directory(temporary.path);writeFileSync(join(temporary.path,'request.json'),bytes,{flag:'wx',mode:0o600});}
  catch{unavailable('BEDROCK_TEMPORARY_INPUT_FAILED');}
}
/** All ownership/entries are checked before deleting anything. Never recurse,
 * follow links, delete an unexpected name or copy credentials into these files.
 */
export function removeBedrockTemporary(requestId:string,tempRoot?:string):void {
  try{
    const path=location(requestId,tempRoot),before=stat(path);if(!before)return;directory(path);
    const entries=readdirSync(path);if(entries.some(name=>!known.has(name))||!entries.includes('owner.json'))unavailable();
    const files=entries.map(name=>{const value=stat(join(path,name));if(!value?.isFile()||value.isSymbolicLink()||value.nlink!==1n||value.size>BigInt(name==='request.json'?256*1024:name==='owner.json'?512:0))unavailable();return {name,value};});
    const marker=JSON.parse(readFileSync(join(path,'owner.json'),'utf8'));
    if(!marker||typeof marker!=='object'||Object.keys(marker).sort().join(',')!=='owner,requestId'||marker.owner!==owner||marker.requestId!==requestId)unavailable();
    const current=stat(path);if(!current||current.dev!==before.dev||current.ino!==before.ino)unavailable();
    for(const file of files){const value=stat(join(path,file.name));if(!value||value.dev!==file.value.dev||value.ino!==file.value.ino||value.nlink!==1n||value.size!==file.value.size||value.mtimeNs!==file.value.mtimeNs)unavailable();}
    // Owner marker is removed last so an interrupted cleanup can be retried.
    for(const name of entries.filter(name=>name!=='owner.json'))unlinkSync(join(path,name));unlinkSync(join(path,'owner.json'));rmdirSync(path);
  }catch{unavailable();}
}
