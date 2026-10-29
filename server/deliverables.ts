import type {NumericSourceCheck} from '../shared/quality-progress.ts';
import {createHash} from 'node:crypto';
import {closeSync,fstatSync,lstatSync,openSync,readSync,readdirSync,realpathSync,constants} from 'node:fs';
import {extname,join,normalize,relative,sep,isAbsolute} from 'node:path';
import type {Deliverable,DeliverableChecks,DeliverableList,DeliverablePreview} from '../shared/deliverables.ts';
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
/** Largest file readDeliverable returns; bigger files are refused, never truncated. Equals MAX_HASH so the listed digest covers it. */
export const MAX_DOWNLOAD=MAX_HASH;
const mediaType=(path:string)=>media[extname(path).toLowerCase()]??'application/octet-stream';

function read(path:string,limit:number,expect?:{dev:number;ino:number}){
  const fd=openSync(path,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW));
  try{
    const stat=fstatSync(fd);if(!stat.isFile())throw new AppError('DELIVERABLE_NOT_FOUND',404);
    if(expect&&(stat.dev!==expect.dev||stat.ino!==expect.ino))throw new AppError('DELIVERABLE_CHANGED',409);
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

// A comma is a thousands separator only before exactly three digits, so CSV fields stay separate.
const numberPattern=/-?\d{1,3}(?:,\d{3})+(?![\d])(?:\.\d+)?|-?\d+(?:\.\d+)?/g;
const normal=(token:string)=>{const value=Number(token.replace(/,/g,''));return Number.isFinite(value)?String(value):null;};
const numbers=(text:string)=>(text.match(numberPattern)??[]).map(normal).filter((value):value is string=>value!==null);
/** Numbers inside Markdown table rows (or every CSV row). Headers and prose are not checked. */
function tableNumbers(type:string,text:string){
  const rows=type==='text/csv'?text.split(/\r?\n/).slice(1):text.split(/\r?\n/).filter(line=>/^\s*\|/.test(line)&&!/^\s*\|[\s:|-]+\|\s*$/.test(line));
  return [...new Set(rows.flatMap(numbers))];
}
export function evidenceCheck(type:string,text:string,inputs:readonly string[]):NumericSourceCheck{
  const found=type==='text/markdown'||type==='text/csv'?tableNumbers(type,text):[];
  const sources=inputs.map(input=>new Set(numbers(input)));
  const results=found.map(value=>{
    const inputIndexes=sources.flatMap((source,index)=>source.has(value)?[index]:[]);
    return {value,status:!inputs.length?'unverified' as const:inputIndexes.length?'verified' as const:'needs_review' as const,inputIndexes};
  });
  const unmatched=results.filter(r=>r.status==='needs_review').map(r=>r.value);
  return {status:!inputs.length||!found.length?'unverified':unmatched.length?'needs_review':'passed',numbers:found.length,
    matched:results.filter(r=>r.status==='verified').length,unmatched:unmatched.slice(0,20),results};
}

export type CheckedDeliverableList=DeliverableList&{items:(Deliverable&{checks:DeliverableChecks&{evidence?:NumericSourceCheck}})[]};
export function listDeliverables(root:string,tasks:readonly {id:string;title:string}[],checkArtifacts=true):CheckedDeliverableList{
  const items:(CheckedDeliverableList['items'][number]&{buffer?:Buffer})[]=[];let skipped=0,truncated=false;
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
        role:path.startsWith('inputs/')?'input':'output',
        checks:{exists:true,readable:true,nonEmpty:file.size>0,format:!checkArtifacts?'unsupported':file.size>0?format(type,file.buffer):textual.has(type)?'failed':'unsupported',meaning:'unverified'},buffer:file.buffer});
    }
  };
  walk(root,0);
  items.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const sources=items.filter(item=>item.role==='input'&&item.previewable),inputs=sources.map(item=>item.buffer!.toString('utf8'));
  for(const item of items){
    // A project without materials has nothing to compare; keep its checks unchanged.
    // Expose the missing-input result explicitly; format and meaning stay unchanged.
    if(checkArtifacts&&item.role==='output'&&item.previewable&&item.checks.format==='passed')item.checks.evidence={...evidenceCheck(item.mediaType,item.buffer!.toString('utf8'),inputs),inputPaths:sources.map(source=>source.path)};
    delete item.buffer;
  }
  return {items,skipped,truncated};
}

/** Path guard shared by preview and read: relative, no traversal, no hidden/sensitive part, no link at any level. */
function checkedPath(root:string,path:string){
  if(typeof path!=='string'||!path||path.length>240||/[\x00-\x1f\x7f]/.test(path)||isAbsolute(path)||path.includes('\\'))throw new AppError('INVALID_PATH',400);
  const clean=normalize(path);
  if(clean.startsWith('..')||clean.split(/[\\/]/).some(part=>sensitive(part)||part==='..'))throw new AppError('INVALID_PATH',400);
  // Every component must be a real directory or file inside the folder; no link is followed.
  let current=root;const parts=clean.split(/[\\/]/),stats=[];
  for(const part of parts){
    current=join(current,part);
    const stat=lstatSync(current,{throwIfNoEntry:false});
    if(!stat||stat.isSymbolicLink())throw new AppError('DELIVERABLE_NOT_FOUND',404);
    stats.push(stat);
  }
  return {clean,full:join(root,clean),parts,stats};
}

export function previewDeliverable(root:string,path:string):DeliverablePreview{
  const {clean,full}=checkedPath(root,path);
  const type=mediaType(clean);
  if(!textual.has(type)){if(!lstatSync(full).isFile())throw new AppError('DELIVERABLE_NOT_FOUND',404);return {kind:'unsupported',mediaType:type};}
  const file=read(full,MAX_PREVIEW*4);
  const raw=file.buffer.toString('utf8');
  return {kind:'text',path:clean.split(sep).join('/'),mediaType:type,text:safeText(raw.slice(0,MAX_PREVIEW)),truncated:file.size>file.buffer.length||raw.length>MAX_PREVIEW};
}

export type DeliverableBytes={path:string;bytes:Buffer;sha256:string;size:number;contentType:string};
/**
 * Whole bytes of one file the listing exposes (inputs and outputs alike), for download.
 * `beforeOpen` is a test seam to simulate a swap between check and read.
 */
export function readDeliverable(root:string,path:string,beforeOpen?:()=>void):DeliverableBytes{
  const {clean,full,parts,stats}=checkedPath(root,path),last=stats.at(-1)!;
  // The listing walks at most MAX_DEPTH directories below the root.
  if(parts.length>MAX_DEPTH+1||!last.isFile())throw new AppError('DELIVERABLE_NOT_FOUND',404);
  if(last.size>MAX_DOWNLOAD)throw new AppError('DELIVERABLE_TOO_LARGE',413);
  beforeOpen?.();
  // O_NOFOLLOW covers the leaf; dev/ino ties the opened file to the checked one.
  let file;
  try{file=read(full,MAX_DOWNLOAD+1,last);}
  catch(error){if(error instanceof AppError)throw error;throw new AppError((error as NodeJS.ErrnoException).code==='ENOENT'?'DELIVERABLE_NOT_FOUND':'DELIVERABLE_CHANGED',(error as NodeJS.ErrnoException).code==='ENOENT'?404:409);}
  if(file.size>MAX_DOWNLOAD)throw new AppError('DELIVERABLE_TOO_LARGE',413);
  // Same inode rewritten in place since the check, or short read: refuse rather than serve mixed bytes.
  if(file.size!==last.size||file.buffer.length!==file.size)throw new AppError('DELIVERABLE_CHANGED',409);
  // Re-walk after the read: a parent swapped for a link (or another directory) meanwhile is refused.
  const again=checkedPath(root,clean).stats;
  if(again.some((stat,index)=>stat.dev!==stats[index].dev||stat.ino!==stats[index].ino))throw new AppError('DELIVERABLE_CHANGED',409);
  return {path:clean.split(sep).join('/'),bytes:file.buffer,sha256:createHash('sha256').update(file.buffer).digest('hex'),size:file.size,contentType:mediaType(clean)};
}

/** Download boundary: canonical output paths only, including no hard-link aliases. */
export function readOutputDeliverable(root:string,path:string):DeliverableBytes {
  if(path!==normalize(path).split(sep).join('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||path.split('/')[0].toLowerCase()==='inputs')throw new AppError('INVALID_PATH',400);
  const rootStat=lstatSync(root);
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||realpathSync(root)!==root)throw new AppError('DELIVERABLE_NOT_FOUND',404);
  const before=checkedPath(root,path),leaf=before.stats.at(-1)!;
  if(leaf.nlink!==1)throw new AppError('DELIVERABLE_NOT_FOUND',404);
  const file=readDeliverable(root,path);
  const after=checkedPath(root,path),currentRoot=lstatSync(root);
  if(currentRoot.dev!==rootStat.dev||currentRoot.ino!==rootStat.ino||currentRoot.isSymbolicLink()||realpathSync(root)!==root
    ||after.stats.some((stat,index)=>stat.dev!==before.stats[index].dev||stat.ino!==before.stats[index].ino)
    ||after.stats.at(-1)!.nlink!==1||after.stats.at(-1)!.mtimeMs!==leaf.mtimeMs||after.stats.at(-1)!.ctimeMs!==leaf.ctimeMs)throw new AppError('DELIVERABLE_CHANGED',409);
  return file;
}

export function downloadHeaders(file:DeliverableBytes):Record<string,string> {
  const name=file.path.split('/').at(-1)!.replace(/[^A-Za-z0-9._-]/g,'_').slice(0,120).replace(/^\.+/,'')||'result';
  const allowed=new Set(['text/plain','text/markdown','text/csv','application/json','application/pdf','image/png','image/jpeg',
    media['.docx'],media['.pptx'],media['.xlsx']]);
  return {'Content-Disposition':`attachment; filename="${name}"`,'Content-Type':allowed.has(file.contentType)?file.contentType:'application/octet-stream',
    'Content-Length':String(file.size),'X-Content-Type-Options':'nosniff'};
}

/** Resolve an opaque ID by directory metadata only; read bytes only after selecting one output. */
export function findOutputPath(root:string,matches:(path:string)=>boolean):string {
  let visited=0;
  const walk=(dir:string,depth:number):string|null=>{
    for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(visited>=MAX_FILES)return null;
      if(sensitive(entry.name)||entry.isSymbolicLink()||depth===0&&entry.name.toLowerCase()==='inputs')continue;
      const full=join(dir,entry.name),path=relative(root,full).split(sep).join('/');
      // Validate each directory before descent; the selected file is checked again by the byte reader.
      if(entry.isDirectory()&&depth<MAX_DEPTH){checkedPath(root,path);const found=walk(full,depth+1);if(found)return found;}
      else if(entry.isFile()){visited++;if(matches(path))return path;}
    }
    return null;
  };
  const path=walk(root,0);if(!path)throw new AppError('DELIVERABLE_NOT_FOUND',404);return path;
}
