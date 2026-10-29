import {createHash,randomUUID} from 'node:crypto';
import {closeSync,constants,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,rmSync,writeSync} from 'node:fs';
import {extname,join} from 'node:path';
import type {Material} from '../shared/deliverables.ts';
import {containsCredential} from './privacy.ts';
import {outboundDenial} from './providers/policy.ts';
import {AppError} from './errors.ts';
import type {Store} from './store.ts';

/**
 * User-supplied source materials of a general project. They live in `inputs/`
 * of the project folder, are text only, are never overwritten silently (an
 * explicit replace archives the prior bytes first) and pass the same input gate as AI briefs because AI runtimes read them.
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

function checkMaterial({name,text}:{name:unknown;text:unknown}):{name:string;text:string}{
  if(!validMaterialName(name)||typeof text!=='string'||!text.trim()||text.includes('\0')||text.includes('�')||Buffer.byteLength(text)>MAX_MATERIAL_BYTES)throw new AppError('INVALID_MATERIAL',400);
  // Materials are read by AI runtimes: block instead of silently redacting.
  const denial=containsCredential(text)?'CREDENTIAL_LIKE_INPUT':outboundDenial(text);
  if(denial)throw new AppError(denial,400);
  return {name,text};
}

/** Adds files exactly once. The same name with the same content is a no-op; different content is a conflict. */
export function addMaterials(root:string,input:unknown):Material[]{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).join(',')!=='files')throw new AppError('INVALID_FIELDS',400);
  const files=(input as {files:unknown}).files;
  if(!Array.isArray(files)||!files.length||files.length>MAX_MATERIAL_FILES)throw new AppError('INVALID_FIELDS',400);
  const names=new Set<string>();
  for(const file of files){
    if(!file||typeof file!=='object'||Object.keys(file).sort().join(',')!=='name,text')throw new AppError('INVALID_FIELDS',400);
    const {name}=checkMaterial(file as {name:unknown;text:unknown});
    if(names.has(name.toLowerCase()))throw new AppError('INVALID_MATERIAL',400);
    names.add(name.toLowerCase());
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

export const MAX_MATERIAL_VERSIONS=50;
export type PriorMaterial={path:string;sha256:string;text:string};
/** Append-only previous bytes of replaced materials; kept in Orbit's store, never in the user's folder. */
export class MaterialHistory {
  private store:Store;
  constructor(store:Store){
    this.store=store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS material_versions(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,text TEXT NOT NULL,replaced_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS material_versions_no_update BEFORE UPDATE ON material_versions BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS material_versions_no_delete BEFORE DELETE ON material_versions BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;`);
  }
  keep(projectId:string,prior:PriorMaterial){
    this.store.transaction(()=>{
      // shortcut: a fixed per-project cap instead of pruning; raise it or add export when users hit it.
      if(Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM material_versions WHERE project_id=?').get(projectId)!.n)>=MAX_MATERIAL_VERSIONS)throw new AppError('MATERIAL_HISTORY_FULL',409);
      this.store.db.prepare('INSERT INTO material_versions(project_id,path,sha256,text,replaced_at) VALUES(?,?,?,?,?)').run(projectId,prior.path,prior.sha256,prior.text,new Date().toISOString());
    });
  }
  counts(projectId:string){
    return new Map(this.store.db.prepare('SELECT path,COUNT(*) AS n FROM material_versions WHERE project_id=? GROUP BY path').all(projectId).map(row=>[String(row.path),Number(row.n)]));
  }
}

/**
 * Explicitly replaces one existing material with a new version. The caller's
 * expected digest guards against replacing bytes the user has not seen; the
 * previous bytes are archived first, so a failed archive leaves the file as is.
 */
export function replaceMaterial(root:string,input:unknown,archive:(prior:PriorMaterial)=>void):Material[]{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='expectedSha256,name,text')throw new AppError('INVALID_FIELDS',400);
  const {expectedSha256}=input as {expectedSha256:unknown};
  if(typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256))throw new AppError('INVALID_FIELDS',400);
  const {name,text}=checkMaterial(input as {name:unknown;text:unknown});
  const path=MATERIALS_DIR+'/'+name,current=listMaterials(root).find(item=>item.path===path);
  if(!current)throw new AppError('MATERIAL_NOT_FOUND',404);
  const target=join(root,MATERIALS_DIR,name),stat=lstatSync(target);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink>1)throw new AppError('MATERIALS_UNAVAILABLE',409);
  if(current.sha256===sha(text))return listMaterials(root);
  if(current.sha256!==expectedSha256)throw new AppError('MATERIAL_CHANGED',409);
  const prior=readFileSync(target,'utf8');if(sha(prior)!==expectedSha256)throw new AppError('MATERIAL_CHANGED',409);
  archive({path,sha256:expectedSha256,text:prior});
  // Dot-prefixed names are never listed as materials; rename swaps the entry without following links.
  const temporary=join(root,MATERIALS_DIR,'.orbit-replace-'+randomUUID());
  try{
    const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(process.platform==='win32'?0:constants.O_NOFOLLOW),0o600);
    try{writeSync(fd,text);}finally{closeSync(fd);}
    renameSync(temporary,target);
  }catch(error){rmSync(temporary,{force:true});throw error;}
  return listMaterials(root);
}
