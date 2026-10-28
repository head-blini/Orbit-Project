import {createHash} from 'node:crypto';
import {closeSync,constants,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,writeSync} from 'node:fs';
import {extname,join} from 'node:path';
import type {Material} from '../shared/deliverables.ts';
import {containsCredential} from './privacy.ts';
import {outboundDenial} from './providers/policy.ts';
import {AppError} from './errors.ts';

/**
 * User-supplied source materials of a general project. They live in `inputs/`
 * of the server-owned folder, are text only, are never overwritten and pass the
 * same input gate as AI briefs because AI runtimes read them.
 */
export const MATERIALS_DIR='inputs';
const allowed=new Set(['.csv','.md','.txt','.json']);
export const MAX_MATERIAL_FILES=10,MAX_MATERIAL_BYTES=128*1024;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');

export function validMaterialName(name:unknown):name is string{
  return typeof name==='string'&&name.length>=3&&name.length<=80&&/^[\p{L}\p{N}][\p{L}\p{N} ._()-]*$/u.test(name)&&!name.includes('..')&&allowed.has(extname(name).toLowerCase());
}

export function listMaterials(root:string):Material[]{
  const dir=join(root,MATERIALS_DIR),stat=lstatSync(dir,{throwIfNoEntry:false});
  if(!stat)return [];if(!stat.isDirectory()||stat.isSymbolicLink())throw new AppError('MATERIALS_UNAVAILABLE',409);
  return readdirSync(dir,{withFileTypes:true}).filter(entry=>entry.isFile()&&validMaterialName(entry.name)).sort((a,b)=>a.name.localeCompare(b.name)).map(entry=>{
    const text=readFileSync(join(dir,entry.name),'utf8');
    return {path:MATERIALS_DIR+'/'+entry.name,size:Buffer.byteLength(text),sha256:sha(text)};
  });
}

/** Adds files exactly once. The same name with the same content is a no-op; different content is a conflict. */
export function addMaterials(root:string,input:unknown):Material[]{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).join(',')!=='files')throw new AppError('INVALID_FIELDS',400);
  const files=(input as {files:unknown}).files;
  if(!Array.isArray(files)||!files.length||files.length>MAX_MATERIAL_FILES)throw new AppError('INVALID_FIELDS',400);
  const names=new Set<string>();
  for(const file of files){
    if(!file||typeof file!=='object'||Object.keys(file).sort().join(',')!=='name,text')throw new AppError('INVALID_FIELDS',400);
    const {name,text}=file as {name:unknown;text:unknown};
    if(!validMaterialName(name)||names.has(name.toLowerCase())||typeof text!=='string'||!text.trim()||text.includes('\0')||text.includes('�')||Buffer.byteLength(text)>MAX_MATERIAL_BYTES)throw new AppError('INVALID_MATERIAL',400);
    names.add(name.toLowerCase());
    // Materials are read by AI runtimes: block instead of silently redacting.
    const denial=containsCredential(text)?'CREDENTIAL_LIKE_INPUT':outboundDenial(text);
    if(denial)throw new AppError(denial,400);
  }
  const existing=new Map(listMaterials(root).map(item=>[item.path.toLowerCase(),item]));
  if(existing.size+files.filter(file=>!existing.has((MATERIALS_DIR+'/'+file.name).toLowerCase())).length>MAX_MATERIAL_FILES*2)throw new AppError('MATERIALS_QUOTA',413);
  for(const {name,text} of files as {name:string;text:string}[]){
    const prior=existing.get((MATERIALS_DIR+'/'+name).toLowerCase());
    if(prior&&(prior.path!==MATERIALS_DIR+'/'+name||prior.sha256!==sha(text)))throw new AppError('MATERIAL_EXISTS',409);
  }
  mkdirSync(join(root,MATERIALS_DIR),{recursive:true});
  for(const {name,text} of files as {name:string;text:string}[]){
    if(existing.has((MATERIALS_DIR+'/'+name).toLowerCase()))continue;
    const fd=openSync(join(root,MATERIALS_DIR,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(process.platform==='win32'?0:constants.O_NOFOLLOW),0o600);
    try{writeSync(fd,text);}finally{closeSync(fd);}
  }
  return listMaterials(root);
}
