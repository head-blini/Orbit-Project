import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Project, Workspace, WorkspaceDiff, FileDiff } from '../shared/types.ts';
import { Store } from './store.ts';
import { AppError } from './errors.ts';
import { safeText } from './privacy.ts';
import { fingerprintWorkspace,readWorkspaceSourceSnapshot,readWorkspaceSnapshot } from './workspace-fingerprint.ts';
import { trustedGit } from './git-process.ts';
import {repositoryIdentity} from './repository-resource.ts';
import type {RepositoryResource} from '../shared/repository-authority.ts';
import type {CreateProjectInput,CreatedProject} from '../shared/project-creation.ts';
import {ManagedProjectCreation} from './project-creation.ts';

const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const inside=(parent:string,child:string)=>{const r=relative(parent,child);return !!r&&!r.startsWith('..')&&!isAbsolute(r);};
export function canonical(path:string):string {
  if(typeof path!=='string'||path.length>2000||!isAbsolute(path)||/[\x00-\x1f]/.test(path)||path.split(/[\\/]/).some(p=>p==='.'||p==='..')||
    (process.platform==='win32'&&(!/^[a-z]:[\\/]/i.test(path)||path.slice(2).includes(':')||path.slice(3).split(/[\\/]/).some(p=>/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))))throw new AppError('INVALID_PATH',400);
  const full=resolve(path);
  try{for(let p=full;;p=dirname(p)){if(lstatSync(p).isSymbolicLink())throw new AppError('LINK_REJECTED');if(dirname(p)===p)break;}
    const actual=realpathSync(full);if(!same(actual,full))throw new AppError('LINK_REJECTED');return actual;
  }catch(e){if(e instanceof AppError)throw e;throw new AppError('PATH_UNAVAILABLE',400);}
}
function scan(root:string,skipGit=false){
  let count=0;const walk=(dir:string)=>{for(const e of readdirSync(dir,{withFileTypes:true})){if(skipGit&&dir===root&&e.name==='.git')continue;if(++count>50000)throw new AppError('TREE_TOO_LARGE');const path=join(dir,e.name);const s=lstatSync(path);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile())||(s.isFile()&&s.nlink>1))throw new AppError('LINK_REJECTED');if(s.isDirectory())walk(path);}};walk(root);
}
function git(cwd:string,args:string[],allowDiffExit=false):string {
  return trustedGit(cwd,args,{allowDiffExit}).toString('utf8');
}
function repository(path:string){
  const root=canonical(path);if(!lstatSync(root).isDirectory()||same(root,homedir())||same(root,parse(root).root))throw new AppError('INVALID_PROJECT');
  const metadata=join(root,'.git');if(!existsSync(metadata)||!lstatSync(metadata).isDirectory())throw new AppError('REPOSITORY_ROOT_REQUIRED');canonical(metadata);scan(metadata);
  if(existsSync(join(metadata,'objects','info','alternates')))throw new AppError('EXTERNAL_GIT_DATA_REJECTED');
  const config=git(root,['config','--local','--no-includes','--name-only','--list']);
  if(config.split(/\r?\n/).some(k=>/^(include\.|includeif\.|filter\.|core\.worktree$|extensions\.|remote\..*\.promisor$)/i.test(k)))throw new AppError('GIT_CONFIG_REJECTED');
  if(!same(git(root,['rev-parse','--show-toplevel']).trim().replace(/\//g,process.platform==='win32'?'\\':'/'),root)||git(root,['rev-parse','--is-bare-repository']).trim()!=='false')throw new AppError('REPOSITORY_ROOT_REQUIRED');
  const sha=git(root,['rev-parse','--verify','HEAD^{commit}']).trim();if(!/^[a-f0-9]{40,64}$/.test(sha))throw new AppError('INVALID_HEAD');
  const tree=git(root,['ls-tree','-rz',sha]);
  if(tree.split('\0').some(e=>/^(120000|160000) /.test(e)||/\t(?:.*\/)?(?:\.codex|\.agents|\.git)(?:\/|$)/i.test(e)))throw new AppError('UNSUPPORTED_TREE');
  scan(root,true);accessSync(root,constants.R_OK);return {root,sha};
}
const sensitive=(path:string)=>/(^|\/)(\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|\.aws|\.codex|\.git)(\/|$)|\.(?:sqlite(?:-wal|-shm)?|db(?:-wal|-shm)?|pem|key|p12|pfx|log)$/i.test(path);
/** Reject general project IDs, including attempts to use them as workspace IDs. */
export function assertGitProject(store:Store,id:string|null|undefined):void {
  if(!id)return;
  const projectId=store.workspaces().find(workspace=>workspace.id===id)?.projectId;
  if(store.projects().some(project=>(project.id===id||project.id===projectId)&&project.kind==='general'))throw new AppError('GIT_REQUIRED',409);
}
export class Projects {
  private store:Store;private managed:string;private allowed:string[];
  private creation?:ManagedProjectCreation;
  constructor(store:Store,managed:string,allowed:string[]=[],creationRoot?:string){this.store=store;mkdirSync(managed,{recursive:true});this.managed=canonical(managed);this.allowed=allowed.map(canonical);if(creationRoot!==undefined)this.creation=new ManagedProjectCreation(store,creationRoot,this.managed);}
  get creationAvailable(){return this.creation?.available??false;}
  createProject(input:CreateProjectInput):CreatedProject{if(!this.creation)throw new AppError('PROJECT_CREATION_UNAVAILABLE',503);return this.creation.create(input,(project,id)=>this.prepareWorktree(project,id),id=>this.validate(id));}
  list():Project[]{return this.store.projects().map(p=>({...p,writeEnabled:this.allowed.some(a=>same(a,p.path))||!!this.creation?.owns(p)}));}
  workspaces(){return this.store.workspaces();}
  register(path:string):Project {
    const {root}=repository(path);if(same(root,this.managed)||inside(root,this.managed)||inside(this.managed,root))throw new AppError('PROJECT_OVERLAP');
    const existing=this.list().find(p=>same(p.path,root));if(existing)return existing;
    const p:Project={id:randomUUID(),kind:'code',name:safeText(basename(root)),path:root,createdAt:new Date().toISOString(),writeEnabled:this.allowed.some(a=>same(a,root))};this.store.saveProject(p);return p;
  }
  private project(id:string){const p=this.list().find(p=>p.id===id);if(!p)throw new AppError('PROJECT_NOT_FOUND',404);return p;}
  /** A general write grant requires the exact server-created folder receipt. */
  generalProject(id:string):Project {
    const project=this.store.projects().find(project=>project.id===id);
    if(!project)throw new AppError('PROJECT_NOT_FOUND',404);
    if(project.kind!=='general')throw new AppError('GENERAL_PROJECT_REQUIRED',409);
    if(!this.creation?.owns(project))throw new AppError('PROJECT_CREATION_UNAVAILABLE',409);
    return project;
  }
  create(projectId:string):Workspace {
    assertGitProject(this.store,projectId);
    const p=this.project(projectId);if(!p.writeEnabled)throw new AppError('WRITES_DISABLED',403);
    return this.prepareWorktree(p,randomUUID());
  }
  private prepareWorktree(p:Project,id:string):Workspace {
    if(p.kind==='general')throw new AppError('GIT_REQUIRED',409);
    const {sha}=repository(p.path);accessSync(join(p.path,'.git'),constants.W_OK);canonical(this.managed);
    const w:Workspace={id,projectId:p.id,path:join(this.managed,id),branch:'orbit/'+id,baseSha:sha,createdAt:new Date().toISOString(),status:'creating'};
    this.store.saveWorkspace(w);
    try{git(p.path,['worktree','add','--no-track','-b',w.branch,'--',w.path,sha]);for(const name of ['.codex','.agents','.aws'])mkdirSync(join(w.path,name),{recursive:true});w.status='ready';this.store.saveWorkspace(w);this.validate(w.id);return w;}
    catch(e){w.status='failed';this.store.saveWorkspace(w);throw e;}
  }
  validate(id:string):Workspace {
    assertGitProject(this.store,id);
    const w=this.workspaces().find(w=>w.id===id);if(!w||w.status!=='ready')throw new AppError('WORKSPACE_NOT_READY');const p=this.project(w.projectId);
    repository(p.path);canonical(this.managed);if(!same(w.path,join(this.managed,w.id))||!/^orbit\/[a-f0-9-]{36}$/.test(w.branch))throw new AppError('INVALID_WORKSPACE');
    canonical(w.path);canonical(join(w.path,'.git'));scan(w.path);
    for(const name of ['.codex','.agents','.aws'])if(!existsSync(join(w.path,name))||!lstatSync(join(w.path,name)).isDirectory())throw new AppError('WORKSPACE_CHANGED');
    if(!same(resolve(w.path,git(w.path,['rev-parse','--git-common-dir']).trim()),join(p.path,'.git'))||git(w.path,['branch','--show-current']).trim()!==w.branch||git(w.path,['rev-parse','HEAD']).trim()!==w.baseSha)throw new AppError('WORKSPACE_CHANGED');return w;
  }
  writable(id:string){const w=this.validate(id);if(!this.project(w.projectId).writeEnabled)throw new AppError('WRITES_DISABLED',403);return w;}
  repositoryResource(id:string):RepositoryResource {
    const workspace=this.writable(id),project=this.project(workspace.projectId);
    return {...repositoryIdentity(join(project.path,'.git')),worktreePath:canonical(workspace.path),targetBranch:workspace.branch,baseRevision:workspace.baseSha};
  }
  private manifest(workspace:Workspace) {
    const tracked=git(workspace.path,['ls-files','--stage','-z']).split('\0').filter(Boolean).map(entry=>{
      const match=/^([0-9]{6}) [a-f0-9]{40,64} ([0-3])\t([\s\S]+)$/.exec(entry);
      if(!match||match[2]!=='0')throw new AppError('FINGERPRINT_UNAVAILABLE',409);
      return {path:match[3],mode:match[1]};
    });
    const untracked=git(workspace.path,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean).map(path=>({path,mode:'100644'}));
    return [...tracked,...untracked];
  }
  fingerprint(id:string):string {
    const workspace=this.writable(id);
    try{return fingerprintWorkspace(workspace.path,workspace.baseSha,this.manifest(workspace));}catch{throw new AppError('FINGERPRINT_UNAVAILABLE',409);}
  }
  mergeContext(id:string){
    const workspace=this.writable(id);
    return {workspace,project:this.project(workspace.projectId),scratchRoot:this.managed};
  }
  mergeProject(id:string){
    assertGitProject(this.store,id);
    const project=this.project(id);if(!project.writeEnabled)throw new AppError('WRITES_DISABLED',403);
    repository(project.path);return project;
  }
  snapshot(id:string){
    const workspace=this.writable(id);
    try{return readWorkspaceSnapshot(workspace.path,workspace.baseSha,this.manifest(workspace));}
    catch{throw new AppError('WORKSPACE_SNAPSHOT_UNAVAILABLE',409);}
  }
  sourceSnapshot(id:string) {
    const workspace=this.writable(id);
    try{
      const snapshot=readWorkspaceSourceSnapshot(workspace.path,workspace.baseSha,this.manifest(workspace));
      const changed=new Set([...git(workspace.path,['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',workspace.baseSha,'--']).split('\0'),...git(workspace.path,['ls-files','--others','--exclude-standard','-z']).split('\0')]);
      return {...snapshot,files:snapshot.files.map(file=>({...file,changed:changed.has(file.path)}))};
    }catch{throw new AppError('SOURCE_SNAPSHOT_UNAVAILABLE',409);}
  }
  diff(id:string):WorkspaceDiff {
    const w=this.validate(id);const changed=git(w.path,['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',w.baseSha,'--']).split('\0').filter(Boolean);
    const untracked=git(w.path,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean);const names=[...new Set([...changed,...untracked])];if(names.length>200)throw new AppError('DIFF_TOO_LARGE');
    let total=0;const files:FileDiff[]=names.map(path=>{
      const out:FileDiff={path:safeText(path),status:untracked.includes(path)?'untracked':existsSync(join(w.path,path))?'modified':'deleted',patch:null};
      if(sensitive(path)){out.omitted='sensitive';return out;}
      if(existsSync(join(w.path,path))&&lstatSync(join(w.path,path)).size>128000){out.omitted='too_large';return out;}
      const patch=untracked.includes(path)?git(w.path,['diff','--no-index','--no-ext-diff','--no-textconv','--','/dev/null',path],true):git(w.path,['diff','--no-ext-diff','--no-textconv','--no-renames',w.baseSha,'--',path]);
      // safeText masks after its 64k prefix cap. Decide completeness from the
      // raw patch first: masking must never hide an already truncated suffix.
      total+=patch.length;if(total>512000||patch.length>64000){out.omitted='too_large';return out;}if(patch.includes('Binary files')||patch.includes('\0')){out.omitted='binary';return out;}out.patch=safeText(patch);return out;
    });return {workspaceId:w.id,baseSha:w.baseSha,files};
  }
}
