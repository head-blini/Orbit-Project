import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname,isAbsolute,relative,resolve,sep } from 'node:path';

const POLICY_VERSION='orbit-workspace-fingerprint-v1';
const MAX_FILES=2000,MAX_FILE_BYTES=4*1024*1024,MAX_TOTAL_BYTES=32*1024*1024;
const MAX_SOURCE_FILES=100,MAX_SOURCE_FILE_BYTES=256*1024,MAX_SOURCE_TOTAL_BYTES=4*1024*1024;
const sourcePath=(path:string)=>/\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(path);
const samePath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const unavailable=():never=>{throw new Error('FINGERPRINT_UNAVAILABLE');};
export type WorkspaceFileSnapshot={path:string;mode:string;presence:'present';bytes:Uint8Array}|{path:string;mode:string;presence:'deleted'};

const sensitive=(path:string)=>path.split('/').some(part=>
  /^(?:\.env.*|auth\.json.*|credentials.*|keys|secrets?|\.git|\.codex|\.agents|\.aws|\.ssh|\.azure|\.gcloud|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519)$/i.test(part)
  ||/\.(?:keys?|pem|p12|pfx|sqlite(?:-wal|-shm)?|db(?:-wal|-shm)?|log)$/i.test(part));

function specifications(files:readonly {path:string;mode:string}[]){
  if(!Array.isArray(files)||Object.getPrototypeOf(files)!==Array.prototype||files.length>MAX_FILES||Reflect.ownKeys(files).length!==files.length+1)unavailable();
  const descriptors=Object.getOwnPropertyDescriptors(files),seen=new Set<string>(),result:{path:string;mode:string}[]=[];
  for(let index=0;index<files.length;index++){
    const descriptor=descriptors[String(index)];if(!descriptor||!('value' in descriptor))unavailable();
    const value:unknown=descriptor.value;
    if(typeof value!=='object'||value===null||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)||Reflect.ownKeys(value).length!==2)unavailable();
    const fields=Object.getOwnPropertyDescriptors(value),path=fields.path,mode=fields.mode;
    if(!path||!mode||!('value' in path)||!('value' in mode)||typeof path.value!=='string'||!['100644','100755'].includes(mode.value))unavailable();
    const name:string=path.value;
    if(!name||name.length>2000||/[\x00-\x1f\x7f\\]/.test(name)||isAbsolute(name)||/^[A-Za-z]:/.test(name)
      ||Buffer.from(name,'utf8').toString('utf8')!==name||name.split('/').some(part=>!part||part==='.'||part==='..')||sensitive(name))unavailable();
    if(process.platform==='win32'&&name.split('/').some(part=>part.includes(':')||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))unavailable();
    const key=process.platform==='win32'?name.toLowerCase():name;if(seen.has(key))unavailable();seen.add(key);
    result.push({path:name,mode:mode.value});
  }
  return result.sort((a,b)=>Buffer.compare(Buffer.from(a.path,'utf8'),Buffer.from(b.path,'utf8')));
}

/** Pure validation for trusted Git tree manifests; never opens any path. */
export function assertWorkspaceManifest(files:readonly {path:string;mode:string}[]):void {
  try{specifications(files);}catch{throw new Error('WORKSPACE_MANIFEST_UNAVAILABLE');}
}
function maybeStat(path:string):fs.BigIntStats|null {
  try{return fs.lstatSync(path,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
function identity(a:fs.BigIntStats,b:fs.BigIntStats){return a.dev===b.dev&&a.ino===b.ino;}
function unchanged(a:fs.BigIntStats,b:fs.BigIntStats){
  return identity(a,b)&&a.mode===b.mode&&a.nlink===b.nlink&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
}
function ordinary(stat:fs.BigIntStats){return stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&stat.ino!==0n&&stat.size<=BigInt(MAX_FILE_BYTES);}

/**
 * Hash only the caller's fresh Git-visible stage-0 tracked/nonignored-untracked
 * list. No Git, auth, DB or provider access occurs here. The server still owns
 * authoritative listing, worktree authorization and pre/post execution locking.
 * These checks detect observed races, not every concurrent change-and-restore.
 */
function inspectWorkspace(root:string,baseSha:string,files:readonly {path:string;mode:string}[],collection:'none'|'sources'|'all'){
  try{
    // Validate the entire manifest before opening any content, including an
    // ordinary file that sorts before a later sensitive or malformed entry.
    const specs=specifications(files);
    if(typeof baseSha!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseSha)||typeof root!=='string'||!isAbsolute(root)
      ||/[\x00-\x1f\x7f]/.test(root)||root.split(/[\\/]/).some(part=>part==='.'||part==='..'))unavailable();
    if(process.platform==='win32'&&(!/^[A-Za-z]:[\\/]/.test(root)||root.slice(2).includes(':')))unavailable();
    const full=resolve(root),directories=new Map<string,fs.BigIntStats|null>();
    function directory(path:string,required=false){
      const stat=maybeStat(path);
      if(!stat){if(required)unavailable();}else if(!stat.isDirectory()||stat.isSymbolicLink()||!samePath(fs.realpathSync(path),path))unavailable();
      if(directories.has(path)){
        const original=directories.get(path);if((original===null)!==(stat===null)||(original&&stat&&!identity(original,stat)))unavailable();
      }else directories.set(path,stat);
      return stat;
    }
    for(let path=full;;path=dirname(path)){directory(path,true);if(dirname(path)===path)break;}
    function parents(path:string){
      const chain:string[]=[];for(let current=dirname(path);!samePath(current,full);current=dirname(current)){
        const within=relative(full,current);if(!within||isAbsolute(within)||within==='..'||within.startsWith('..'+sep))unavailable();chain.push(current);
      }
      directory(full,true);for(const parent of chain.reverse())directory(parent);
    }
    let total=0;const objects=new Set<string>();
    const entries=specs.map(spec=>{
      const path=resolve(full,...spec.path.split('/')),within=relative(full,path);
      if(!within||isAbsolute(within)||within==='..'||within.startsWith('..'+sep))unavailable();parents(path);
      const stat=maybeStat(path);
      if(stat){if(!ordinary(stat))unavailable();total+=Number(stat.size);if(total>MAX_TOTAL_BYTES)unavailable();
        // Git's executable bit must match present POSIX bytes before a full
        // snapshot can reproduce the manifest. Windows stat exec bits do not
        // express Git mode; retain the caller's trusted Git mode there.
        if(collection==='all'&&process.platform!=='win32'&&((stat.mode&0o111n)!==0n)!==(spec.mode==='100755'))unavailable();
        const object=stat.dev+':'+stat.ino;if(objects.has(object))unavailable();objects.add(object);}
      return {...spec,absolute:path,stat};
    });
    // Validate every selected source size before opening ANY manifest content.
    // Deleted entries remain fingerprinted but are not selected source content.
    if(collection==='sources'){
      const selected=entries.filter(entry=>entry.stat!==null&&sourcePath(entry.path));
      if(selected.length>MAX_SOURCE_FILES||selected.some(entry=>entry.stat!.size>BigInt(MAX_SOURCE_FILE_BYTES))
        ||selected.reduce((sum,entry)=>sum+Number(entry.stat!.size),0)>MAX_SOURCE_TOTAL_BYTES)unavailable();
    }
    const sources:{path:string;content:string}[]=[],snapshotFiles:WorkspaceFileSnapshot[]=[];
    const manifest=createHash('sha256');
    const field=(value:string)=>{const bytes=Buffer.from(value,'utf8'),length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);manifest.update(length);manifest.update(bytes);};
    field(POLICY_VERSION);field(baseSha.toLowerCase());field(String(entries.length));
    for(const entry of entries){
      field(entry.path);field(entry.mode);
      if(!entry.stat){field('deleted');if(collection==='all')snapshotFiles.push({path:entry.path,mode:entry.mode,presence:'deleted'});continue;}
      parents(entry.absolute);let fd:number|undefined;
      try{
        fd=fs.openSync(entry.absolute,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
        const opened=fs.fstatSync(fd,{bigint:true});if(!ordinary(opened)||!unchanged(entry.stat,opened))unavailable();
        const content=createHash('sha256'),buffer=Buffer.alloc(64*1024),collectedBytes:Buffer[]|null=collection==='all'||(collection==='sources'&&sourcePath(entry.path))?[]:null;let size=0,count:number;
        while((count=fs.readSync(fd,buffer,0,buffer.length,null))!==0){size+=count;if(size>MAX_FILE_BYTES||size>Number(entry.stat.size))unavailable();const bytes=buffer.subarray(0,count);content.update(bytes);if(collectedBytes)collectedBytes.push(Buffer.from(bytes));}
        const finished=fs.fstatSync(fd,{bigint:true});if(size!==Number(entry.stat.size)||!ordinary(finished)||!unchanged(opened,finished))unavailable();
        const current=maybeStat(entry.absolute);if(!current||!ordinary(current)||!unchanged(finished,current))unavailable();parents(entry.absolute);
        field('present');field(String(size));field((finished.mode&0o777n).toString(8));field(content.digest('hex'));
        if(collectedBytes){
          const bytes=Buffer.concat(collectedBytes);
          if(collection==='all')snapshotFiles.push({path:entry.path,mode:entry.mode,presence:'present',bytes});
          else{
            const text=bytes.toString('utf8');
            if(text.includes('\0')||!Buffer.from(text,'utf8').equals(bytes))unavailable();
            sources.push({path:entry.path,content:text});
          }
        }
      }finally{if(fd!==undefined)fs.closeSync(fd);}
    }
    const recheck=()=>{for(const [path,stat] of directories)directory(path,stat!==null);};
    recheck();
    for(const entry of entries){const current=maybeStat(entry.absolute);
      if(entry.stat===null){if(current!==null)unavailable();}else if(!current||!ordinary(current)||!unchanged(entry.stat,current))unavailable();}
    recheck();return {sourceDigest:manifest.digest('hex'),files:sources,excludedFileCount:entries.length-sources.length,snapshotFiles};
  }catch{throw new Error('FINGERPRINT_UNAVAILABLE');}
}

export function fingerprintWorkspace(root:string,baseSha:string,files:readonly {path:string;mode:string}[]):string {
  return inspectWorkspace(root,baseSha,files,'none').sourceDigest;
}

/** The same validated, once-read bytes produce both the v1 whole-manifest digest
 * and strict UTF-8 JS/TS content. No second source read or partial snapshot occurs.
 * Source limits apply to present selected files only. excludedFileCount counts
 * all manifest entries not returned: unsupported extensions and deleted entries,
 * including deleted JS/TS. Unsupported present files still affect sourceDigest.
 */
export function readWorkspaceSourceSnapshot(root:string,baseSha:string,files:readonly {path:string;mode:string}[]):{
  sourceDigest:string;files:{path:string;content:string}[];excludedFileCount:number;
}{
  try{
    const {sourceDigest,files:sourceFiles,excludedFileCount}=inspectWorkspace(root,baseSha,files,'sources');
    return {sourceDigest,files:sourceFiles,excludedFileCount};
  }catch{throw new Error('SOURCE_SNAPSHOT_UNAVAILABLE');}
}

/** Server-internal, once-read full manifest snapshot, including binary and
 * deleted entries. Raw bytes are detached from the read buffer and live files.
 * The unchanged v1 digest uses those same bytes and the existing OS-mode field.
 * No snapshot escapes before all final race checks succeed. POSIX executable
 * mismatch rejects here only; Windows preserves the trusted manifest Git mode.
 */
export function readWorkspaceSnapshot(root:string,baseSha:string,files:readonly {path:string;mode:string}[]):{sourceDigest:string;files:WorkspaceFileSnapshot[]} {
  try{
    const {sourceDigest,snapshotFiles}=inspectWorkspace(root,baseSha,files,'all');
    return {sourceDigest,files:snapshotFiles};
  }catch{throw new Error('WORKSPACE_SNAPSHOT_UNAVAILABLE');}
}
