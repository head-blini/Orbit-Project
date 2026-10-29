import {createHash,randomUUID} from 'node:crypto';
import {accessSync,constants,existsSync,lstatSync,mkdirSync,readdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import type {CreateProjectInput,CreatedProject,RegisterFolderInput} from '../shared/project-creation.ts';
import type {Project,Workspace} from '../shared/types.ts';
import type {Store} from './store.ts';
import {canonical} from './projects.ts';
import {repositoryIdentity} from './repository-resource.ts';
import {trustedGit} from './git-process.ts';
import {containsCredential} from './privacy.ts';
import {AppError} from './errors.ts';

type Directory={path:string;device:string;inode:string;birthtimeNs:string};
type Receipt={requestId:string;digest:string;name:string;kind?:Project['kind'];createdAt:string;state:'creating'|'ready'|'failed';
  root:string;rootIdentity:Directory[];projectId:string;projectPath:string;workspaceId:string|null;workspacePath:string|null;
  projectIdentity:Directory|null;gitIdentity:ReturnType<typeof repositoryIdentity>|null;baseSha:string|null};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Keep the code digest compatible with receipts written before kind existed.
const creationDigest=(name:string,kind:Project['kind'])=>hash(kind==='code'?{name}:{name,kind});
function contains(parent:string,child:string){
  const key=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
  const delta=relative(key(parent),key(child));return !delta||delta!=='..'&&!delta.startsWith('..'+sep)&&!isAbsolute(delta);
}
function directory(path:string):Directory{
  const actual=canonical(path),stat=lstatSync(actual,{bigint:true});if(!stat.isDirectory()||stat.ino===0n)throw new Error();
  return {path:actual,device:String(stat.dev),inode:String(stat.ino),birthtimeNs:String(stat.birthtimeNs)};
}
function chain(path:string){const result:Directory[]=[];for(let current=path;;current=dirname(current)){result.push(directory(current));if(dirname(current)===current)return result;}}
function normalize(input:CreateProjectInput):Required<CreateProjectInput>{
  try{
    if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error();
    const fields=Object.getOwnPropertyDescriptors(input);
    const keys=Reflect.ownKeys(fields);
    if(keys.some(key=>typeof key!=='string')||!['name,requestId','kind,name,requestId'].includes((keys as string[]).sort().join(','))||Object.values(fields).some(field=>!('value' in field)))throw new Error();
    const {requestId,name}=input;
    const kind=Object.hasOwn(fields,'kind')?input.kind:'code';
    if(kind!=='code'&&kind!=='general')throw new Error();
    if(typeof requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(requestId)||containsCredential(requestId)
      ||typeof name!=='string'||/[\x00-\x1f\x7f]/.test(name))throw new Error();
    const trimmed=name.trim();
    if(!trimmed||trimmed.length>80||containsCredential(trimmed)||/[/\\<>:=`$|;&]/.test(trimmed)||trimmed.startsWith('-')||trimmed==='.'||trimmed==='..'
      ||/\b(?:password|passwd|secret|token|api[-_ ]?key|authorization|credentials?)\b/i.test(trimmed))throw new Error();
    return {requestId,name:trimmed,kind};
  }catch{throw new AppError('INVALID_FIELDS',400);}
}

/** Server-created exact directory identities only; a path prefix is never a write grant. */
export class ManagedProjectCreation {
  private root:string;private rootIdentity:Directory[];private store:Store;private managed:string;
  constructor(store:Store,root:string,managed:string){
    this.store=store;this.managed=managed;
    this.root=resolve(root);
    if(root!==this.root||contains(this.root,managed)||contains(managed,this.root))throw new AppError('INVALID_PROJECT_CREATION_ROOT',503);
    store.db.exec('CREATE TABLE IF NOT EXISTS project_creation_roots(path TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS project_creation_receipts(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL);');
    const existing=store.db.prepare('SELECT body FROM project_creation_roots WHERE path=?').get(this.root);
    if(existing){try{this.rootIdentity=JSON.parse(String(existing.body));}catch{this.rootIdentity=[];}return;}
    // Never follow an existing ancestor link while preparing the configured root.
    let ancestor=this.root;while(!existsSync(ancestor)){const parent=dirname(ancestor);if(parent===ancestor)throw new AppError('INVALID_PROJECT_CREATION_ROOT',503);ancestor=parent;}
    canonical(ancestor);mkdirSync(this.root,{recursive:true});this.rootIdentity=chain(this.root);
    store.db.prepare('INSERT INTO project_creation_roots VALUES(?,?)').run(this.root,JSON.stringify(this.rootIdentity));
  }
  get available(){try{return this.rootIdentity.length>0&&equal(chain(this.root),this.rootIdentity);}catch{return false;}}
  private read(row:Record<string,unknown>|undefined):Receipt|null{
    if(!row)return null;
    try{
      const r:Receipt=JSON.parse(String(row.body));
      const kind=r.kind===undefined?'code':r.kind;
      if(!r||!uuid(r.projectId)||r.root!==this.root||r.projectPath!==join(this.root,r.projectId)
        ||(kind==='general'?(r.workspaceId!==null||r.workspacePath!==null||r.gitIdentity!==null||r.baseSha!==null):(!uuid(r.workspaceId)||r.workspacePath!==join(this.managed,r.workspaceId)))
        ||!['creating','ready','failed'].includes(r.state)
        ||!equal(normalize({requestId:r.requestId,name:r.name,kind}),{requestId:r.requestId,name:r.name,kind})
        ||r.digest!==creationDigest(r.name,kind)||r.digest!==row.digest||typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt)))throw new Error();
      return r;
    }catch{return null;}
  }
  private matchingIdentity(r:Receipt){
    try{return this.available&&equal(r.rootIdentity,this.rootIdentity)&&equal(directory(r.projectPath),r.projectIdentity)
      &&(r.kind==='general'?lstatSync(join(r.projectPath,'.git'),{throwIfNoEntry:false})===undefined:equal(repositoryIdentity(join(r.projectPath,'.git')),r.gitIdentity));}catch{return false;}
  }
  owns(project:Project){
    try{return this.store.db.prepare('SELECT digest,body FROM project_creation_receipts').all().some(row=>{
      const r=this.read(row);return !!r&&r.state==='ready'&&(r.kind??'code')===project.kind&&r.projectId===project.id&&r.projectPath===project.path&&r.name===project.name&&r.createdAt===project.createdAt&&this.matchingIdentity(r);
    });}catch{return false;}
  }
  private save(r:Receipt){this.store.db.prepare('UPDATE project_creation_receipts SET body=? WHERE request_id=?').run(JSON.stringify(r),r.requestId);}
  create(input:CreateProjectInput,prepare:(project:Project,workspaceId:string)=>Workspace,validate:(id:string)=>Workspace):CreatedProject{
    const normalized=normalize(input),digest=creationDigest(normalized.name,normalized.kind);
    const prior=this.store.db.prepare('SELECT digest,body FROM project_creation_receipts WHERE request_id=?').get(normalized.requestId);
    if(prior){
      if(prior.digest!==digest)throw new AppError('IDEMPOTENCY_CONFLICT',409);
      const r=this.read(prior);if(!r||r.state!=='ready')throw new AppError('PROJECT_CREATION_INCOMPLETE',409);
      const project=this.store.projects().find(project=>project.id===r.projectId),workspace=this.store.workspaces().find(workspace=>workspace.id===r.workspaceId);
      if(!project||!this.owns(project))throw new AppError('PROJECT_CREATION_UNAVAILABLE',409);
      if(r.kind==='general')return {project:{...project,writeEnabled:true},workspace:null};
      if(!workspace||workspace.projectId!==r.projectId||workspace.path!==r.workspacePath||workspace.branch!=='orbit/'+r.workspaceId||workspace.baseSha!==r.baseSha)throw new AppError('PROJECT_CREATION_UNAVAILABLE',409);
      try{validate(workspace.id);}catch{throw new AppError('PROJECT_CREATION_UNAVAILABLE',409);}
      return {project:{...project,writeEnabled:true},workspace};
    }
    if(!this.available)throw new AppError('PROJECT_CREATION_UNAVAILABLE',409);
    const projectId=randomUUID(),workspaceId=normalized.kind==='code'?randomUUID():null,createdAt=new Date().toISOString();
    const r:Receipt={...normalized,digest,createdAt,state:'creating',root:this.root,rootIdentity:this.rootIdentity,
      projectId,projectPath:join(this.root,projectId),workspaceId,workspacePath:workspaceId?join(this.managed,workspaceId):null,projectIdentity:null,gitIdentity:null,baseSha:null};
    try{
      this.store.transaction(()=>{this.store.db.prepare('INSERT INTO project_creation_receipts VALUES(?,?,?)').run(r.requestId,r.digest,JSON.stringify(r));this.store.append('project.creation.intent',null,{projectId,workspaceId});});
      if(!this.available)throw new Error();mkdirSync(r.projectPath);r.projectIdentity=directory(r.projectPath);this.save(r);
      const assertIdentity=()=>{if(!this.available||!equal(directory(r.projectPath),r.projectIdentity))throw new Error();};
      assertIdentity();writeFileSync(join(r.projectPath,'README.md'),'# Orbit project\n\nThis project is ready for planning.\n',{flag:'wx',mode:0o644});
      const project:Project={id:projectId,name:r.name,kind:normalized.kind,path:r.projectPath,createdAt,writeEnabled:false};
      if(normalized.kind==='general'){
        if(!this.matchingIdentity(r))throw new Error();
        r.state='ready';this.store.transaction(()=>{this.store.saveProject(project);this.save(r);this.store.append('project.creation.ready',null,{projectId,workspaceId:null});});
        if(!this.owns(project))throw new Error();return {project:{...project,writeEnabled:true},workspace:null};
      }
      assertIdentity();trustedGit(r.projectPath,['init','--quiet','--initial-branch=main','--template=']);
      r.gitIdentity=repositoryIdentity(join(r.projectPath,'.git'));this.save(r);
      const assertRepository=()=>{assertIdentity();if(!equal(repositoryIdentity(join(r.projectPath,'.git')),r.gitIdentity))throw new Error();};
      assertRepository();trustedGit(r.projectPath,['add','--','README.md']);
      assertRepository();trustedGit(r.projectPath,['commit','--quiet','-m','Initialize Orbit project'],{identity:true});
      assertRepository();r.baseSha=trustedGit(r.projectPath,['rev-parse','--verify','HEAD^{commit}']).toString('utf8').trim();this.save(r);
      this.store.transaction(()=>this.store.saveProject(project));
      assertRepository();const workspace=prepare(project,workspaceId!);assertRepository();
      if(workspace.path!==r.workspacePath||workspace.baseSha!==r.baseSha)throw new Error();
      r.state='ready';this.store.transaction(()=>{this.save(r);this.store.append('project.creation.ready',null,{projectId,workspaceId});});
      if(!this.owns(project))throw new Error();validate(workspace.id);return {project:{...project,writeEnabled:true},workspace};
    }catch{
      r.state='failed';try{this.save(r);}catch{/* Durable intent remains incomplete if storage is unavailable. */}
      throw new AppError('PROJECT_CREATION_INCOMPLETE',409);
    }
  }
}

type Registration={requestId:string;digest:string;name:string;path:string;identity:Directory[];projectId:string;createdAt:string};
const registrationDigest=(name:string,path:string)=>hash({register:'general-folder',name,path});
// Exact system folders and their contents; the OS temp root stays usable (it lives under /private/var on macOS).
const systemRoots=process.platform==='win32'?[/^[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata)(?:\\|$)/i]:[/^\/(?:System|Library|Applications|usr|bin|sbin|etc|dev|opt|cores|Volumes)(?:\/|$)/i];
// Runtime config an AI CLI would load from its working folder, and folders Orbit itself owns.
const runtimeConfig=/^(?:\.git|\.claude|\.codex|\.agents|\.mcp\.json)$/i,reserved=/^(?:inputs|output|\.orbit-workers)$/i;
/** Read-only checks of an existing folder; nothing here writes, moves or follows links. */
function inspectFolder(root:string){
  let count=0;
  const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
    if(++count>50000)throw new AppError('TREE_TOO_LARGE',409);
    if(runtimeConfig.test(entry.name))throw new AppError(entry.name.toLowerCase()==='.git'?'GIT_FOLDER_REJECTED':'FOLDER_UNSUPPORTED',409);
    if(dir===root&&reserved.test(entry.name))throw new AppError('FOLDER_RESERVED_NAME',409);
    const path=join(dir,entry.name),stat=lstatSync(path);
    if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||(stat.isFile()&&stat.nlink>1))throw new AppError('LINK_REJECTED',409);
    if(stat.isDirectory())walk(path);
  }};
  walk(root);
}
const key=(d:Directory)=>d.device+':'+d.inode;
// True when `ancestor` is `path` or one of its ancestors, by identity. Unresolvable paths fall back to the string checks.
function ancestorOf(ancestor:Directory,path:string){try{return chain(path).some(d=>key(d)===key(ancestor));}catch{return false;}}
function related(identity:Directory[],other:string){
  try{const own=chain(other)[0];return identity.some(d=>key(d)===key(own))||ancestorOf(identity[0],other);}catch{return false;}
}
function normalizeRegistration(input:RegisterFolderInput){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='name,path,requestId'||typeof input.path!=='string')throw new AppError('INVALID_FIELDS',400);
  const {requestId,name}=normalize({requestId:input.requestId,name:input.name,kind:'general'});
  return {requestId,name,path:canonical(input.path)};
}

/**
 * Registers an existing, operator-allowlisted folder as a general project. The
 * folder is only inspected here. Afterwards Orbit writes materials to inputs/
 * and worker spaces to .orbit-workers/; AI runtimes may run there only inside
 * an isolated worker space (see isRegistered and ISOLATION_REQUIRED).
 */
export class GeneralFolderRegistration {
  private store:Store;private blocked:string[];
  constructor(store:Store,blocked:string[]){
    this.store=store;this.blocked=blocked.map(path=>resolve(path));
    store.db.exec('CREATE TABLE IF NOT EXISTS project_registration_receipts(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL);');
  }
  private receipts():Registration[]{
    return this.store.db.prepare('SELECT digest,body FROM project_registration_receipts').all().flatMap(row=>{
      try{const r:Registration=JSON.parse(String(row.body));return r.digest===row.digest&&r.digest===registrationDigest(r.name,r.path)&&uuid(r.projectId)?[r]:[];}catch{return [];}
    });
  }
  private matches(r:Registration,project:Project){
    try{return project.kind==='general'&&r.projectId===project.id&&r.path===project.path&&r.name===project.name&&r.createdAt===project.createdAt
      &&equal(chain(r.path),r.identity)&&lstatSync(join(r.path,'.git'),{throwIfNoEntry:false})===undefined;}catch{return false;}
  }
  owns(project:Project){return this.receipts().some(r=>this.matches(r,project));}
  /** Provenance only, valid or not: callers use it to fail closed. */
  isRegistered(projectId:string){return this.store.db.prepare('SELECT body FROM project_registration_receipts').all().some(row=>{try{return JSON.parse(String(row.body)).projectId===projectId;}catch{return true;}});}
  register(input:RegisterFolderInput,allowed:readonly string[]):CreatedProject{
    const {requestId,name,path}=normalizeRegistration(input),digest=registrationDigest(name,path);
    const prior=this.store.db.prepare('SELECT digest,body FROM project_registration_receipts WHERE request_id=?').get(requestId);
    if(prior){
      if(prior.digest!==digest)throw new AppError('IDEMPOTENCY_CONFLICT',409);
      const r=this.receipts().find(r=>r.requestId===requestId),project=this.store.projects().find(project=>project.id===r?.projectId);
      if(!r||!project||!this.matches(r,project))throw new AppError('PROJECT_CREATION_UNAVAILABLE',409);
      return {project:{...project,writeEnabled:true},workspace:null};
    }
    if(!lstatSync(path).isDirectory())throw new AppError('INVALID_PROJECT',400);
    if(!allowed.some(entry=>process.platform==='win32'?entry.toLowerCase()===path.toLowerCase():entry===path))throw new AppError('FOLDER_NOT_ALLOWED',403);
    const home=resolve(homedir()),identity=chain(path);
    // String checks plus device/inode checks, so case-folded or Unicode-normalized aliases cannot slip past.
    const overlaps=(other:string)=>contains(other,path)||contains(path,other)||related(identity,other);
    if(path===parse(path).root||contains(path,home)||ancestorOf(identity[0],home)||systemRoots.some(pattern=>pattern.test(path)))throw new AppError('FOLDER_NOT_ALLOWED',403);
    if([...this.blocked,...this.store.projects().map(project=>project.path)].some(overlaps))throw new AppError('PROJECT_OVERLAP',409);
    try{accessSync(path,constants.R_OK|constants.W_OK);}catch{throw new AppError('PATH_UNAVAILABLE',400);}
    inspectFolder(path);
    // The folder (or an ancestor) must not have been swapped while it was inspected.
    if(!equal(chain(path),identity))throw new AppError('FOLDER_CHANGED',409);
    const r:Registration={requestId,digest,name,path,identity,projectId:randomUUID(),createdAt:new Date().toISOString()};
    const project:Project={id:r.projectId,name,kind:'general',path,createdAt:r.createdAt,writeEnabled:false};
    this.store.transaction(()=>{
      // Recheck under the write lock: another request may have claimed this folder meanwhile.
      if(this.store.projects().some(other=>overlaps(other.path)))throw new AppError('PROJECT_OVERLAP',409);
      this.store.db.prepare('INSERT INTO project_registration_receipts VALUES(?,?,?)').run(requestId,digest,JSON.stringify(r));
      this.store.saveProject(project);this.store.append('project.folder.registered',null,{projectId:r.projectId});
    });
    return {project:{...project,writeEnabled:true},workspace:null};
  }
}
