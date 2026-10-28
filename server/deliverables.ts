import {createHash} from 'node:crypto';
import {closeSync,fstatSync,lstatSync,openSync,readSync,readdirSync,constants} from 'node:fs';
import {extname,join,normalize,relative,sep,isAbsolute} from 'node:path';
import type {Deliverable,DeliverableList,DeliverablePreview} from '../shared/deliverables.ts';
import {safeText} from './privacy.ts';
import {AppError} from './errors.ts';

/**
 * Read-only view of a general project's folder. The caller passes the folder that
 * Projects.generalProject() validated; nothing here writes, follows links or leaves it.
 */
const media:Record<string,string>={'.md':'text/markdown','.markdown':'text/markdown','.txt':'text/plain','.csv':'text/csv','.json':'application/json',
  '.html':'text/html','.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
const textual=new Set(['text/markdown','text/plain','text/csv','application/json']);
// Same spirit as the Diff filter: never list credentials, databases, keys or VCS internals.
const sensitive=(name:string)=>name.startsWith('.')||/^(auth\.json|credentials(\..*)?)$/i.test(name)||/\.(sqlite(-wal|-shm)?|db(-wal|-shm)?|pem|key|p12|pfx|log)$/i.test(name);
const MAX_FILES=500,MAX_DEPTH=3,MAX_HASH=32*1024*1024,MAX_PREVIEW=64_000;
const mediaType=(path:string)=>media[extname(path).toLowerCase()]??'application/octet-stream';

function read(path:string,limit:number){
  const fd=openSync(path,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW));
  try{
    const stat=fstatSync(fd);if(!stat.isFile())throw new AppError('DELIVERABLE_NOT_FOUND',404);
    const size=Math.min(stat.size,limit),buffer=Buffer.alloc(size);let offset=0;
    while(offset<size){const n=readSync(fd,buffer,offset,size-offset,offset);if(!n)break;offset+=n;}
    return {buffer:buffer.subarray(0,offset),size:stat.size,mtime:stat.mtime};
  }finally{closeSync(fd);}
}
function format(type:string,buffer:Buffer):'passed'|'failed'|'unsupported'{
  if(!textual.has(type))return 'unsupported';
  const text=buffer.toString('utf8');
  if(!text.trim()||text.includes('�'))return 'failed';
  if(type==='application/json'){try{JSON.parse(text);return 'passed';}catch{return 'failed';}}
  if(type==='text/csv'){const rows=text.trim().split(/\r?\n/);return rows.length>=1&&rows.every(row=>row.includes(','))?'passed':'failed';}
  return 'passed';
}

export function listDeliverables(root:string,tasks:readonly {id:string;title:string}[]):DeliverableList{
  const items:Deliverable[]=[];let skipped=0,truncated=false;
  const walk=(dir:string,depth:number)=>{
    for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(items.length>=MAX_FILES){truncated=true;return;}
      const full=join(dir,entry.name);
      if(sensitive(entry.name)||entry.isSymbolicLink()){skipped++;continue;}
      if(entry.isDirectory()){if(depth<MAX_DEPTH)walk(full,depth+1);else skipped++;continue;}
      if(!entry.isFile()){skipped++;continue;}
      const path=relative(root,full).split(sep).join('/'),type=mediaType(path);
      let file;try{file=read(full,MAX_HASH);}catch{skipped++;continue;}
      const task=tasks.find(task=>new RegExp(`^task-${task.id.slice(0,8)}\\.`).test(path))??null;
      items.push({path,size:file.size,modifiedAt:file.mtime.toISOString(),sha256:createHash('sha256').update(file.buffer).digest('hex'),mediaType:type,
        taskId:task?.id??null,taskTitle:task?.title??null,previewable:textual.has(type),
        checks:{exists:true,readable:true,nonEmpty:file.size>0,format:file.size>0?format(type,file.buffer):textual.has(type)?'failed':'unsupported',meaning:'unverified'}});
    }
  };
  walk(root,0);
  items.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return {items,skipped,truncated};
}

export function previewDeliverable(root:string,path:string):DeliverablePreview{
  if(typeof path!=='string'||!path||path.length>240||/[\x00-\x1f]/.test(path)||isAbsolute(path)||path.includes('\\'))throw new AppError('INVALID_PATH',400);
  const clean=normalize(path);
  if(clean.startsWith('..')||clean.split(/[\\/]/).some(part=>sensitive(part)||part==='..'))throw new AppError('INVALID_PATH',400);
  const full=join(root,clean);
  // Every component must be a real directory or file inside the folder; no link is followed.
  let current=root;
  for(const part of clean.split(/[\\/]/)){
    current=join(current,part);
    const stat=lstatSync(current,{throwIfNoEntry:false});
    if(!stat||stat.isSymbolicLink())throw new AppError('DELIVERABLE_NOT_FOUND',404);
  }
  const type=mediaType(clean);
  if(!textual.has(type)){if(!lstatSync(full).isFile())throw new AppError('DELIVERABLE_NOT_FOUND',404);return {kind:'unsupported',mediaType:type};}
  const file=read(full,MAX_PREVIEW*4);
  const raw=file.buffer.toString('utf8');
  return {kind:'text',path:clean.split(sep).join('/'),mediaType:type,text:safeText(raw.slice(0,MAX_PREVIEW)),truncated:file.size>file.buffer.length||raw.length>MAX_PREVIEW};
}
