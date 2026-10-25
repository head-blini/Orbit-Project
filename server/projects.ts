import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Project, Workspace, WorkspaceDiff, FileDiff } from '../shared/types.ts';
import { Store } from './store.ts';
import { AppError } from './errors.ts';
import { safeText } from './privacy.ts';

const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const inside=(parent:string,child:string)=>{const r=relative(parent,child);return !!r&&!r.startsWith('..')&&!isAbsolute(r);};
// Resolve once from the server's absolute PATH entries. Windows otherwise searches
// the untrusted project cwd for git.exe before PATH, even with shell:false.
const gitBinary=(process.env.PATH??'').split(delimiter).filter(isAbsolute).map(p=>join(p,process.platform==='win32'?'git.exe':'git')).find(p=>existsSync(p)&&lstatSync(p).isFile());
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
  if(!gitBinary)throw new AppError('GIT_NOT_INSTALLED',503);
  const env={...process.env};for(const key of Object.keys(env))if(/^GIT_/i.test(key))delete env[key];
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:''});
  const options={cwd,env,encoding:'utf8' as const,windowsHide:true,shell:false,timeout:15000,maxBuffer:2*1024*1024,stdio:'pipe' as const};
  try{return execFileSync(gitBinary,['--no-pager','--literal-pathspecs','-c','protocol.allow=never','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','submodule.recurse=false','-c','core.protectNTFS=true',...args],options);}
  catch(e:any){if(allowDiffExit&&e.status===1)return String(e.stdout??'');throw new AppError('GIT_OPERATION_FAILED');}
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
export class Projects {
  private store:Store;private managed:string;private allowed:string[];
  constructor(store:Store,managed:string,allowed:string[]=[]){this.store=store;mkdirSync(managed,{recursive:true});this.managed=canonical(managed);this.allowed=allowed.map(canonical);}
  list():Project[]{return this.store.projects().map(p=>({...p,writeEnabled:this.allowed.some(a=>same(a,p.path))}));}
  workspaces(){return this.store.workspaces();}
  register(path:string):Project {
    const {root}=repository(path);if(same(root,this.managed)||inside(root,this.managed)||inside(this.managed,root))throw new AppError('PROJECT_OVERLAP');
    const existing=this.list().find(p=>same(p.path,root));if(existing)return existing;
    const p={id:randomUUID(),name:safeText(basename(root)),path:root,createdAt:new Date().toISOString(),writeEnabled:this.allowed.some(a=>same(a,root))};this.store.saveProject(p);return p;
  }
  private project(id:string){const p=this.list().find(p=>p.id===id);if(!p)throw new AppError('PROJECT_NOT_FOUND',404);return p;}
  create(projectId:string):Workspace {
    const p=this.project(projectId);if(!p.writeEnabled)throw new AppError('WRITES_DISABLED',403);
    const {sha}=repository(p.path);accessSync(join(p.path,'.git'),constants.W_OK);canonical(this.managed);
    const id=randomUUID();const w:Workspace={id,projectId,path:join(this.managed,id),branch:'orbit/'+id,baseSha:sha,createdAt:new Date().toISOString(),status:'creating'};
    this.store.saveWorkspace(w);
    try{git(p.path,['worktree','add','--no-track','-b',w.branch,'--',w.path,sha]);for(const name of ['.codex','.agents','.aws'])mkdirSync(join(w.path,name),{recursive:true});w.status='ready';this.store.saveWorkspace(w);this.validate(w.id);return w;}
    catch(e){w.status='failed';this.store.saveWorkspace(w);throw e;}
  }
  validate(id:string):Workspace {
    const w=this.workspaces().find(w=>w.id===id);if(!w||w.status!=='ready')throw new AppError('WORKSPACE_NOT_READY');const p=this.project(w.projectId);
    repository(p.path);canonical(this.managed);if(!same(w.path,join(this.managed,w.id))||!/^orbit\/[a-f0-9-]{36}$/.test(w.branch))throw new AppError('INVALID_WORKSPACE');
    canonical(w.path);canonical(join(w.path,'.git'));scan(w.path);
    for(const name of ['.codex','.agents','.aws'])if(!existsSync(join(w.path,name))||!lstatSync(join(w.path,name)).isDirectory())throw new AppError('WORKSPACE_CHANGED');
    if(!same(resolve(w.path,git(w.path,['rev-parse','--git-common-dir']).trim()),join(p.path,'.git'))||git(w.path,['branch','--show-current']).trim()!==w.branch||git(w.path,['rev-parse','HEAD']).trim()!==w.baseSha)throw new AppError('WORKSPACE_CHANGED');return w;
  }
  writable(id:string){const w=this.validate(id);if(!this.project(w.projectId).writeEnabled)throw new AppError('WRITES_DISABLED',403);return w;}
  diff(id:string):WorkspaceDiff {
    const w=this.validate(id);const changed=git(w.path,['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',w.baseSha,'--']).split('\0').filter(Boolean);
    const untracked=git(w.path,['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean);const names=[...new Set([...changed,...untracked])];if(names.length>200)throw new AppError('DIFF_TOO_LARGE');
    let total=0;const files:FileDiff[]=names.map(path=>{
      const out:FileDiff={path:safeText(path),status:untracked.includes(path)?'untracked':existsSync(join(w.path,path))?'modified':'deleted',patch:null};
      if(sensitive(path)){out.omitted='sensitive';return out;}
      if(existsSync(join(w.path,path))&&lstatSync(join(w.path,path)).size>128000){out.omitted='too_large';return out;}
      const patch=untracked.includes(path)?git(w.path,['diff','--no-index','--no-ext-diff','--no-textconv','--','/dev/null',path],true):git(w.path,['diff','--no-ext-diff','--no-textconv','--no-renames',w.baseSha,'--',path]);
      total+=patch.length;if(total>512000||patch.length>128000){out.omitted='too_large';return out;}if(patch.includes('Binary files')||patch.includes('\0')){out.omitted='binary';return out;}out.patch=safeText(patch);return out;
    });return {workspaceId:w.id,baseSha:w.baseSha,files};
  }
}
