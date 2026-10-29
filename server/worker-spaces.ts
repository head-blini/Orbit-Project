import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,lstatSync,mkdirSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {WorkerFence,WorkerPath,WorkerReservation} from '../shared/parallel-workers.ts';
import {AppError} from './errors.ts';
import {Projects,canonical} from './projects.ts';
import {ParallelWorkerService} from './parallel-workers.ts';
import {normalizeWorkerClaim} from './worker-resources.ts';
import {repositoryIdentity} from './repository-resource.ts';
import {readWorkspaceSnapshot} from './workspace-fingerprint.ts';
import type {Store} from './store.ts';

function fail(code:string):never {throw new AppError('WORKER_SPACE_'+code,409);}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const zero='0'.repeat(40);
const within=(root:string,path:string)=>{const r=relative(root,path);return r!==''&&r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);};
const fold=(name:string)=>name.normalize('NFC').toLowerCase();
const protectedPart=(name:string)=>['.git','.codex','.agents','.aws'].includes(fold(name));
function pin(path:string){
  if(canonical(path)!==path||realpathSync(path)!==path)fail('PATH_ALIAS');
  const s=lstatSync(path,{bigint:true});if(!s.isDirectory())fail('PATH_INVALID');
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
function entries(path:string){
  const names=readdirSync(path),seen=new Set<string>();
  for(const name of names){const key=fold(name);if(seen.has(key)||name!==name.normalize('NFC'))fail('PATH_ALIAS');seen.add(key);}
  return names.sort();
}
/** Identity-only walk. Content is read exclusively through the fingerprint helpers. */
function tree(root:string){
  const files:{path:string;mode:string}[]=[],directories:{path:string;mode:number}[]=[];
  let count=0;
  const visit=(path:string)=>{
    if(++count>2000)fail('TREE_TOO_LARGE');
    const s=lstatSync(path);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile())||(s.isFile()&&s.nlink!==1)||realpathSync(path)!==path)fail('PATH_ALIAS');
    const logical=relative(root,path).split(sep).join('/');
    if(s.isDirectory()){directories.push({path:logical,mode:s.mode&0o777});for(const name of entries(path))visit(join(path,name));}
    else files.push({path:logical,mode:s.mode&0o111?'100755':'100644'});
  };
  pin(root);visit(root);return {files,directories};
}

/** Returns PW-1 logical repository paths or absolute physical folder paths.
 * Missing suffixes are allowed only below verified parents. A glob validates its
 * entire existing literal prefix; a root glob is deliberately refused. This is
 * point-in-time evidence, not a sandbox or a grant to modify Git metadata. */
export function resolveWorkerPath(root:string,path:string,absolute=false):WorkerPath {
  pin(root);
  if(typeof path!=='string'||path!==path.normalize('NFC'))fail('PATH_INVALID');
  const logical=absolute?relative(root,path).split(sep).join('/'):path;
  if(absolute&&(!isAbsolute(path)||!within(root,path)||resolve(path)!==path))fail('PATH_ESCAPE');
  const value:WorkerPath={path:absolute?path:logical,canonicalPath:absolute?path:logical,aliasStatus:'verified_no_alias'};
  normalizeWorkerClaim(absolute?{kind:'isolated_folder',host:'local',path:value}:{kind:'repository_file',repositoryId:'0'.repeat(64),path:value,mode:'write'});
  const parts=logical.split('/');if(parts.some(protectedPart))fail('PATH_PROTECTED');
  const firstGlob=parts.findIndex(p=>/[*?]/.test(p));if(firstGlob===0)fail('PATH_GLOB_UNVERIFIED');
  let current=root,missing=false;
  for(const part of firstGlob<0?parts:parts.slice(0,firstGlob)){
    if(!missing){
      const s=lstatSync(current);if(!s.isDirectory())fail('PATH_INVALID');
      const names=entries(current);if(names.some(name=>fold(name)===fold(part)&&name!==part))fail('PATH_ALIAS');
    }
    current=join(current,part);
    const s=lstatSync(current,{throwIfNoEntry:false});if(!s){missing=true;continue;}
    if(missing||s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile())||(s.isFile()&&s.nlink!==1)||realpathSync(current)!==current)fail('PATH_ALIAS');
  }
  if(firstGlob>=0&&!missing)tree(current);
  return value;
}

export function generalAttemptPath(projectPath:string,attemptId:string):string {
  if(typeof attemptId!=='string'||!attemptId)fail('ATTEMPT_INVALID');
  return join(projectPath,'.orbit-workers',hash(attemptId));
}
/** PW-1 does not yet carry a base revision. Only the trusted approval adapter may
 * supply this binding; PW-3 pins it per batch and never substitutes current HEAD. */
export interface ApprovedWorkerBase {batchId:string;projectId:string;repositoryId:string;baseSha:string}
export interface WorkerHandoff {predecessors:{taskId:string;integrationId:string;commitSha:string|null;files:{path:string;sha256:string}[]}[]}
export interface WorkerSpace {
  reservationId:string;attemptId:string;projectId:string;kind:'code'|'general';path:string;
  workspaceId:string|null;repositoryId:string|null;baseSha:string|null;
  state:'creating'|'ready'|'removing'|'removed';identity:string|null;inputDigest:string|null;
  inputManifest:{path:string;sha256:string}[];
}
export interface WorkerChangedFile {path:string;status:'present'|'deleted';sha256:string|null;outOfScope:boolean}
export interface WorkerSpaceManifest {reservationId:string;files:WorkerChangedFile[];inputsUnchanged:boolean;outOfScope:boolean;sourceDigest:string}
function snapshot(root:string){const listing=tree(root);return {...readWorkspaceSnapshot(root,zero,listing.files),directories:listing.directories};}
function inputDigest(root:string){const s=snapshot(root);return hash(JSON.stringify({digest:s.sourceDigest,directories:s.directories}));}
function matches(pattern:string,path:string):boolean {
  const p=pattern.split('/'),s=path.split('/');
  const match=(i:number,j:number):boolean=>{
    if(i===p.length)return j===s.length;
    if(p[i]==='**')return match(i+1,j)||(j<s.length&&match(i,j+1));
    const re=new RegExp('^'+p[i].replace(/[.+^$()|[\]\\]/g,'\\$&').replace(/\*/g,'[^/]*').replace(/\?/g,'[^/]')+'$');
    return j<s.length&&re.test(s[j])&&match(i+1,j+1);
  };
  // A literal directory claim owns its descendants, as in PW-1 overlap checks.
  return match(0,0)||(!/[*?]/.test(pattern)&&path.startsWith(pattern+'/'));
}

/** Single-server synchronous filesystem operations use Projects/trustedGit.
 * BEGIN IMMEDIATE additionally excludes cooperating PW-3 instances on the same
 * authoritative Store. Legacy controller/merge gates remain mandatory; this does
 * not serialize arbitrary external Git processes or expand runtime permissions. */
export class WorkerSpaces {
  private store:Store;private projects:Projects;private workers:ParallelWorkerService;
  constructor(store:Store,projects:Projects,workers:ParallelWorkerService){
    this.store=store;this.projects=projects;this.workers=workers;
    store.db.exec('CREATE TABLE IF NOT EXISTS worker_spaces(reservation_id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS worker_space_bases(batch_id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS worker_space_handoffs(attempt_id TEXT PRIMARY KEY,body TEXT NOT NULL);');
  }
  private owned(token:WorkerFence){
    const r=this.workers.read(token.reservationId);
    if(r.ownerIncarnation!==token.ownerIncarnation||r.fencingGeneration!==token.fencingGeneration)fail('FENCE_STALE');return r;
  }
  private read(id:string):WorkerSpace|null {
    const row=this.store.db.prepare('SELECT body FROM worker_spaces WHERE reservation_id=?').get(id);return row?JSON.parse(String(row.body)):null;
  }
  private save(s:WorkerSpace){this.store.db.prepare('INSERT INTO worker_spaces VALUES(?,?) ON CONFLICT(reservation_id) DO UPDATE SET body=excluded.body').run(s.reservationId,JSON.stringify(s));}
  private check(s:WorkerSpace,r:WorkerReservation){
    if(s.state!=='ready'||s.attemptId!==r.attempt.id||s.projectId!==r.batch.projectId||pin(s.path)!==s.identity)fail('IDENTITY_CHANGED');
    if(s.kind==='code'){
      const resource=this.projects.repositoryResource(s.workspaceId!);
      if(resource.repositoryId!==s.repositoryId||resource.baseRevision!==s.baseSha||resource.worktreePath!==s.path)fail('IDENTITY_CHANGED');
    }else if(s.path!==generalAttemptPath(this.projects.generalProject(s.projectId).path,s.attemptId))fail('IDENTITY_CHANGED');
  }
  private scopes(s:WorkerSpace,r:WorkerReservation){
    for(const claim of r.claims){
      if(claim.kind==='repository_file'){
        if(s.kind!=='code'||claim.repositoryId!==s.repositoryId)fail('CLAIM_MISMATCH');
        const verified=resolveWorkerPath(s.path,claim.path.path);if(JSON.stringify(verified)!==JSON.stringify(claim.path))fail('CLAIM_MISMATCH');
      }else if(claim.kind==='isolated_folder'||claim.kind==='db_file_group'){
        const verified=resolveWorkerPath(s.path,claim.path.path,true);if(JSON.stringify(verified)!==JSON.stringify(claim.path))fail('CLAIM_MISMATCH');
      }
    }
  }
  create(token:WorkerFence,base?:ApprovedWorkerBase,handoff?:WorkerHandoff):WorkerSpace {
    const dependent=!!handoff?.predecessors.length;
    // Persist intent separately: filesystem failures/crashes must never enable an automatic retry.
    const s=this.store.transaction(()=>{
      const r=this.owned(token);if(r.state!=='reserved')fail('NOT_RESERVED');
      const project=this.projects.list().find(p=>p.id===r.batch.projectId);if(!project?.writeEnabled)fail('PROJECT_UNAVAILABLE');
      const pinned=this.store.db.prepare('SELECT body FROM worker_space_handoffs WHERE attempt_id=?').get(r.attempt.id);
      const body=JSON.stringify({base:base??null,handoff:handoff??null});
      const existing=this.read(r.reservationId);
      if((pinned&&(!dependent||pinned.body!==body))||(dependent&&!pinned&&existing))fail('HANDOFF_CONFLICT');
      if(project.kind==='code'){
        if(!base||base.batchId!==r.batch.id||base.projectId!==project.id||! /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base.baseSha)||repositoryIdentity(join(project.path,'.git')).repositoryId!==base.repositoryId)fail('BASE_REQUIRED');
        if(!dependent){
          const body=JSON.stringify({batchId:base.batchId,projectId:base.projectId,repositoryId:base.repositoryId,baseSha:base.baseSha});
          const prior=this.store.db.prepare('SELECT body FROM worker_space_bases WHERE batch_id=?').get(r.batch.id);
          if(prior&&prior.body!==body)fail('BASE_CONFLICT');
          if(!prior)this.store.db.prepare('INSERT INTO worker_space_bases VALUES(?,?)').run(r.batch.id,body);
        }
      }else if(base)fail('BASE_INVALID');
      if(dependent&&!pinned)this.store.db.prepare('INSERT INTO worker_space_handoffs VALUES(?,?)').run(r.attempt.id,body);
      if(existing){this.check(existing,r);return existing;}
      if(project.kind==='general')this.projects.generalProject(project.id);
      const record:WorkerSpace={reservationId:r.reservationId,attemptId:r.attempt.id,projectId:project.id,kind:project.kind,
        path:project.kind==='general'?generalAttemptPath(project.path,r.attempt.id):'',workspaceId:project.kind==='code'?randomUUID():null,
        repositoryId:base?.repositoryId??null,baseSha:base?.baseSha??null,state:'creating',identity:null,inputDigest:null,inputManifest:[]};
      this.save(record);return record;
    });
    if(s.state==='ready')return s;
    return this.store.transaction(()=>{
      const r=this.owned(token);if(r.state!=='reserved')fail('NOT_RESERVED');
      if(s.kind==='code')s.path=this.projects.createWorkerWorkspace(s.projectId,s.baseSha!,s.workspaceId!).path;
      else{
        const project=this.projects.generalProject(s.projectId);
        resolveWorkerPath(project.path,s.path,true);mkdirSync(dirname(s.path),{recursive:true,mode:0o700});mkdirSync(s.path,{mode:0o700});
        const source=join(project.path,'inputs'),destination=join(s.path,'inputs');mkdirSync(destination);mkdirSync(join(s.path,'output'));
        if(existsSync(source)){
          const input=snapshot(source);
          for(const dir of input.directories.filter(d=>d.path))mkdirSync(join(destination,dir.path),{recursive:true});
          for(const file of input.files){if(file.presence!=='present')fail('INPUT_CHANGED');writeFileSync(join(destination,file.path),file.bytes,{flag:'wx',mode:0o444});s.inputManifest.push({path:file.path,sha256:hash(file.bytes)});}
          if(input.sourceDigest!==snapshot(source).sourceDigest)fail('INPUT_CHANGED');
        }
        const files=new Map<string,string>();
        for(const file of handoff?.predecessors.flatMap(p=>p.files)??[]){
          if(files.has(file.path)&&files.get(file.path)!==file.sha256)fail('INPUT_CHANGED');
          files.set(file.path,file.sha256);
        }
        const read=(root:string)=>{
          try{
            const specs=[...files.keys()].map(path=>{
              resolveWorkerPath(root,path);
              return {path,mode:lstatSync(join(root,path)).mode&0o111?'100755':'100644'};
            });
            const result=readWorkspaceSnapshot(root,zero,specs);
            for(const file of result.files)if(file.presence!=='present'||hash(file.bytes)!==files.get(file.path))fail('INPUT_CHANGED');
            return result.files;
          }catch{fail('INPUT_CHANGED');}
        };
        if(files.size){
          // Handed-off paths must not alias each other by case fold or file-vs-directory.
          for(const a of files.keys())for(const b of files.keys())if(a!==b&&(fold(a)===fold(b)||fold(b).startsWith(fold(a)+'/')))fail('INPUT_CONFLICT');
          const inputs=tree(destination);
          for(const path of files.keys()){
            if(inputs.files.some(f=>fold(f.path)===fold(path)||fold(path).startsWith(fold(f.path)+'/'))
              ||inputs.directories.some(d=>fold(d.path)===fold(path)))fail('INPUT_CONFLICT');
            resolveWorkerPath(destination,path);
          }
          for(const file of read(project.path)){
            if(file.presence!=='present')fail('INPUT_CHANGED');
            resolveWorkerPath(destination,file.path);mkdirSync(dirname(join(destination,file.path)),{recursive:true});
            try{writeFileSync(join(destination,file.path),file.bytes,{flag:'wx',mode:0o444});}
            catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')fail('INPUT_CONFLICT');throw error;}
            s.inputManifest.push({path:file.path,sha256:hash(file.bytes)});
          }
          read(project.path);read(destination);
        }
        for(const dir of tree(destination).directories.reverse())chmodSync(join(destination,dir.path),0o555);
        s.inputDigest=inputDigest(destination);
      }
      s.identity=pin(s.path);this.scopes(s,r);s.state='ready';this.save(s);return s;
    });
  }
  /** Compare read-only copies with server-pinned inputs, never caller-supplied manifests. */
  assertInputs(token:WorkerFence):void {
    const r=this.owned(token),s=this.read(r.reservationId);if(!s)fail('NOT_FOUND');
    if(s.kind==='code')return;this.check(s,r);
    const project=this.projects.generalProject(s.projectId),source=join(project.path,'inputs');
    const expected=new Map<string,string>();
    if(existsSync(source))for(const file of snapshot(source).files){
      if(file.presence!=='present')fail('INPUT_CHANGED');expected.set(file.path,hash(file.bytes));
    }
    const row=this.store.db.prepare('SELECT body FROM worker_space_handoffs WHERE attempt_id=?').get(r.attempt.id);
    const handoff:WorkerHandoff|null=row?JSON.parse(String(row.body)).handoff:null;
    const inherited=new Map<string,string>();
    for(const file of handoff?.predecessors.flatMap(p=>p.files)??[]){
      if(!file.path.startsWith('output/')||expected.has(file.path)||(inherited.has(file.path)&&inherited.get(file.path)!==file.sha256))fail('INPUT_CHANGED');
      inherited.set(file.path,file.sha256);
    }
    for(const [path,digest] of inherited)expected.set(path,digest);
    if(s.inputManifest.length!==expected.size||new Set(s.inputManifest.map(f=>f.path)).size!==expected.size
      ||s.inputManifest.some(f=>expected.get(f.path)!==f.sha256)
      ||inputDigest(join(s.path,'inputs'))!==s.inputDigest)fail('INPUT_CHANGED');
  }
  private terminal(token:WorkerFence){const r=this.owned(token);if(!['terminal_confirmed','released'].includes(r.state))fail('TERMINAL_REQUIRED');return r;}
  finish(token:WorkerFence):WorkerSpaceManifest {
    return this.store.transaction(()=>{
      const r=this.terminal(token),s=this.read(r.reservationId);if(!s)fail('NOT_FOUND');this.check(s,r);this.scopes(s,r);
      const current=s.kind==='code'?this.projects.workerChanges(s.workspaceId!):snapshot(s.path);
      const inputsUnchanged=s.kind==='code'||inputDigest(join(s.path,'inputs'))===s.inputDigest;
      const files:WorkerChangedFile[]=current.files.filter(f=>s.kind==='code'||!f.path.startsWith('inputs/')).map(file=>{
        const allowed=r.claims.some(c=>c.kind==='repository_file'?c.mode==='write'&&c.repositoryId===s.repositoryId&&matches(c.path.path,file.path):
          c.kind==='isolated_folder'&&(join(s.path,file.path)===c.path.path||within(c.path.path,join(s.path,file.path))));
        return {path:file.path,status:file.presence,sha256:file.presence==='present'?hash(file.bytes):null,outOfScope:!allowed};
      });
      return {reservationId:r.reservationId,files,inputsUnchanged,outOfScope:!inputsUnchanged||files.some(f=>f.outOfScope),sourceDigest:current.sourceDigest};
    });
  }
  cleanup(token:WorkerFence):void {
    const s=this.store.transaction(()=>{
      const r=this.terminal(token),s=this.read(r.reservationId);if(!s)fail('NOT_FOUND');if(s.state==='removed')return s;
      this.check(s,r);s.state='removing';this.save(s);return s;
    });
    if(s.state==='removed')return;
    this.store.transaction(()=>{
      this.terminal(token);if(pin(s.path)!==s.identity)fail('IDENTITY_CHANGED');
      if(s.kind==='code')this.projects.removeWorkerWorkspace(s.workspaceId!);
      else{for(const dir of tree(s.path).directories)chmodSync(join(s.path,dir.path),0o700);rmSync(s.path,{recursive:true});}
      s.state='removed';this.save(s);
    });
  }
}
