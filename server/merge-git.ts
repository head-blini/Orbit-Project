import {existsSync,lstatSync,realpathSync,readdirSync,mkdirSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {trustedGit} from './git-process.ts';
import {assertWorkspaceManifest,readWorkspaceSnapshot,type WorkspaceFileSnapshot} from './workspace-fingerprint.ts';

export interface MergeSnapshot {sourceDigest:string;files:WorkspaceFileSnapshot[]}
export interface MergeTarget {branch:string;head:string;treeSha:string}
export interface MergeCandidate {commitSha:string;treeSha:string;branch:string}
type TreeFile={path:string;mode:string;sha:string};
const sha=(value:unknown):value is string=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function fail():never{throw new Error('MERGE_GIT_UNAVAILABLE');}
const equalPath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function guard<T>(work:()=>T):T{try{return work();}catch{return fail();}}
function data(value:unknown,keys:string[]){
  if(!value||typeof value!=='object'||Array.isArray(value)||![null,Object.prototype].includes(Object.getPrototypeOf(value)))fail();
  const fields=Object.getOwnPropertyDescriptors(value),result:Record<string,unknown>={};
  if(Reflect.ownKeys(value).length!==keys.length)fail();
  for(const key of keys){const field=fields[key];if(!field||!('value' in field))fail();result[key]=field.value;}return result;
}
function directory(path:string){
  if(typeof path!=='string'||!isAbsolute(path)||/[\x00-\x1f\x7f]/.test(path)||path.split(/[\\/]/).some(part=>part==='.'||part==='..'))fail();
  const full=resolve(path);for(let current=full;;current=dirname(current)){const stat=lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink()||!equalPath(realpathSync(current),current))fail();if(dirname(current)===current)break;}return full;
}
function maybeExists(path:string){try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
function inspectMetadata(root:string){
  let count=0;const scan=(path:string)=>{for(const name of readdirSync(path)){
    if(++count>50000||name.toLowerCase().endsWith('.lock'))fail();const child=join(path,name),stat=lstatSync(child);
    if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||(stat.isFile()&&stat.nlink!==1))fail();if(stat.isDirectory())scan(directory(child));
  }};scan(root);
}
function assertNoAttributes(cwd:string,files:readonly {path:string}[]){
  const checked=new Set<string>();
  for(const file of files){const parts=file.path.split('/');for(let index=0;index<parts.length;index++){
    const path=join(cwd,...parts.slice(0,index),'.gitattributes');if(!checked.has(path)){checked.add(path);if(maybeExists(path))fail();}
  }}
}
function scalar(cwd:string,args:string[]){return trustedGit(cwd,args).toString('utf8').trim();}
function objectId(cwd:string,args:string[]){const value=scalar(cwd,args);if(!sha(value))fail();return value;}
function exactRef(cwd:string,branch:string){return trustedGit(cwd,['rev-parse','--verify','--quiet','refs/heads/'+branch],{allowDiffExit:true}).toString('utf8').trim();}
function branchName(value:unknown):value is string {
  return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)&&!value.includes('..')&&!value.includes('//')&&!value.endsWith('/')&&!value.endsWith('.')&&!value.split('/').some(part=>part.startsWith('.')||part.endsWith('.lock'));
}
function snapshot(input:MergeSnapshot):MergeSnapshot {
  const value=data(input,['sourceDigest','files']);if(typeof value.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.sourceDigest)||!Array.isArray(value.files)||value.files.length>2000)fail();
  const descriptors=Object.getOwnPropertyDescriptors(value.files),files:WorkspaceFileSnapshot[]=[];let total=0;
  if(Object.getPrototypeOf(value.files)!==Array.prototype||Reflect.ownKeys(value.files).length!==value.files.length+1)fail();
  for(let index=0;index<value.files.length;index++){
    const descriptor=descriptors[String(index)];if(!descriptor||!('value' in descriptor))fail();
    const own=Object.getOwnPropertyDescriptors(descriptor.value),presence=own.presence;if(!presence||!('value' in presence))fail();
    const file=data(descriptor.value,presence.value==='present'?['path','mode','presence','bytes']:['path','mode','presence']);
    if(typeof file.path!=='string'||typeof file.mode!=='string'||!['present','deleted'].includes(file.presence as string))fail();
    if(file.path.split('/').some(part=>part.toLowerCase()==='.gitattributes'))fail();
    if(file.presence==='present'){
      if(!(file.bytes instanceof Uint8Array)||(typeof SharedArrayBuffer!=='undefined'&&file.bytes.buffer instanceof SharedArrayBuffer))fail();
      const bytes=Uint8Array.prototype.slice.call(file.bytes) as Uint8Array;total+=bytes.byteLength;if(bytes.byteLength>4*1024*1024||total>32*1024*1024)fail();
      files.push({path:file.path,mode:file.mode,presence:'present',bytes});
    }else files.push({path:file.path,mode:file.mode,presence:'deleted'});
  }
  assertWorkspaceManifest(files.map(({path,mode})=>({path,mode})));return {sourceDigest:value.sourceDigest,files};
}
function targetValue(input:MergeTarget){const value=data(input,['branch','head','treeSha']);if(!branchName(value.branch)||!sha(value.head)||!sha(value.treeSha))fail();return value as unknown as MergeTarget;}
function candidateValue(input:MergeCandidate){const value=data(input,['commitSha','treeSha','branch']);if(!sha(value.commitSha)||!sha(value.treeSha)||typeof value.branch!=='string'||!value.branch.startsWith('orbit-snapshot/')||!uuid(value.branch.slice(15)))fail();return value as unknown as MergeCandidate;}
function tree(cwd:string,commit:string):TreeFile[]{
  if(!sha(commit))fail();const raw=trustedGit(cwd,['ls-tree','-rz','--full-tree',commit]),text=raw.toString('utf8');if(!Buffer.from(text,'utf8').equals(raw))fail();
  const files=text.split('\0').filter(Boolean).map(row=>{const match=/^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)$/.exec(row);if(!match)fail();return {mode:match[1],sha:match[2],path:match[3]};});
  assertWorkspaceManifest(files.map(({path,mode})=>({path,mode})));if(files.some(file=>file.path.split('/').some(part=>part.toLowerCase()==='.gitattributes')))fail();return files;
}
function repository(cwd:string){
  const root=directory(cwd),metadata=directory(join(root,'.git'));inspectMetadata(metadata);
  if(existsSync(join(metadata,'objects','info','alternates'))||existsSync(join(metadata,'info','attributes')))fail();
  const config=scalar(root,['config','--local','--no-includes','--name-only','--list']);
  if(config.split(/\r?\n/).some(key=>/^(?:include\.|includeif\.|filter\.|merge\..*\.driver$|diff\..*\.(?:command|textconv)$|core\.(?:worktree|attributesfile|excludesfile|hookspath|fsmonitor|sparsecheckout(?:cone)?)$|index\.sparse$|extensions\.|remote\..*\.promisor$)/i.test(key)))fail();
  const autocrlf=trustedGit(root,['config','--local','--no-includes','--get','core.autocrlf'],{allowDiffExit:true}).toString().trim();if(autocrlf&&autocrlf!=='false')fail();
  if(!equalPath(resolve(scalar(root,['rev-parse','--show-toplevel'])),root)||scalar(root,['rev-parse','--is-bare-repository'])!=='false'
    ||!equalPath(resolve(root,scalar(root,['rev-parse','--git-common-dir'])),metadata))fail();
  const directories=[metadata],worktrees=join(metadata,'worktrees');if(existsSync(worktrees))for(const name of readdirSync(worktrees)){const path=join(worktrees,name);if(lstatSync(path).isDirectory())directories.push(directory(path));}
  for(const dir of directories)for(const name of ['index.lock','HEAD.lock','config.lock','packed-refs.lock','shallow.lock','MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-apply','rebase-merge','sequencer'])if(existsSync(join(dir,name)))fail();
  const hooks=join(metadata,'hooks');if(existsSync(hooks)){directory(hooks);if(readdirSync(hooks).some(name=>!name.endsWith('.sample')))fail();}
  return root;
}
function assertClean(cwd:string){if(trustedGit(cwd,['status','--porcelain=v1','-z','--untracked-files=all']).length)fail();}
function assertIndex(cwd:string,files:TreeFile[]){
  const entries=trustedGit(cwd,['ls-files','--stage','-z']).toString('utf8').split('\0').filter(Boolean);
  const expected=new Set(files.map(file=>`${file.mode} ${file.sha} 0\t${file.path}`));if(entries.length!==expected.size||entries.some(entry=>!expected.has(entry)))fail();
  if(trustedGit(cwd,['ls-files','-v','-z']).toString('utf8').split('\0').filter(Boolean).some(row=>!row.startsWith('H ')))fail();
}
function rawWorkspace(cwd:string,base:string,files:TreeFile[],deleted:TreeFile[]=[]){
  const manifest=[...files,...deleted.filter(old=>!files.some(file=>file.path===old.path))].map(({path,mode})=>({path,mode}));
  const actual=readWorkspaceSnapshot(cwd,base,manifest),expected=new Map(files.map(file=>[file.path,file]));let total=0;
  for(const file of actual.files){const entry=expected.get(file.path);if(!entry){if(file.presence!=='deleted')fail();continue;}if(file.presence!=='present'||file.mode!==entry.mode)fail();
    const bytes=trustedGit(cwd,['cat-file','blob',entry.sha],{maxBytes:4*1024*1024});total+=bytes.length;if(total>32*1024*1024||!bytes.equals(Buffer.from(file.bytes)))fail();}
}
function assertBranch(cwd:string,branch:string){
  if(scalar(cwd,['symbolic-ref','--quiet','--short','HEAD'])!==branch)fail();
  const rows=scalar(cwd,['worktree','list','--porcelain']).split(/\r?\n/);if(rows.filter(row=>row==='branch refs/heads/'+branch).length!==1)fail();
  if(existsSync(join(cwd,'.git','refs','heads',...branch.split('/'))+'.lock'))fail();
}
function candidateTree(cwd:string,base:string,input:MergeCandidate){
  const candidate=candidateValue(input);if(!sha(base))fail();
  if(exactRef(cwd,candidate.branch)!==candidate.commitSha)fail();
  const commit=trustedGit(cwd,['cat-file','commit',candidate.commitSha]).toString('utf8'),headers=commit.split('\n\n',1)[0].split('\n');
  if(headers.filter(line=>line.startsWith('tree ')).join()!=='tree '+candidate.treeSha||headers.filter(line=>line.startsWith('parent ')).join()!=='parent '+base||headers.some(line=>line.startsWith('gpgsig')))fail();
  return tree(cwd,candidate.commitSha);
}
function assertNoCollisions(cwd:string,base:TreeFile[],next:TreeFile[]){
  const before=new Map(base.map(file=>[file.path,file]));
  // Untracked paths are already blocked by status. Git status omits ignored paths:
  // reject every pre-existing object below a newly introduced file/directory path.
  for(const file of next){if(before.has(file.path))continue;
    const parts=file.path.split('/');for(let index=1;index<=parts.length;index++){
      const part=parts.slice(0,index).join('/'),path=join(cwd,...parts.slice(0,index));
      if(!maybeExists(path))continue;
      const stat=lstatSync(path);if(stat.isSymbolicLink()||index===parts.length||!stat.isDirectory())fail();
      if(!base.some(entry=>entry.path.startsWith(part+'/')))fail();
    }
  }
}

/** Read-only; never chooses another branch or modifies the source workspace. */
export function inspectMergeTarget(projectPath:string,baseSha:string):MergeTarget{return guard(()=>{
  if(!sha(baseSha))fail();const root=repository(projectPath),branch=scalar(root,['symbolic-ref','--quiet','--short','HEAD']);if(!branchName(branch))fail();assertBranch(root,branch);
  const head=objectId(root,['rev-parse','HEAD']);if(head!==baseSha)fail();const files=tree(root,head);assertNoAttributes(root,files);assertClean(root);assertIndex(root,files);rawWorkspace(root,baseSha,files);assertClean(root);
  if(objectId(root,['rev-parse','HEAD'])!==head)fail();assertBranch(root,branch);return {branch,head,treeSha:objectId(root,['rev-parse',head+'^{tree}'])};
});}
export function prepareMergeCandidate(projectPath:string,baseSha:string,input:MergeSnapshot,mergeId:string,scratchRoot:string):MergeCandidate{return guard(()=>{
  const approved=snapshot(input);if(!sha(baseSha)||!uuid(mergeId))fail();const target=inspectMergeTarget(projectPath,baseSha),root=resolve(projectPath),scratch=directory(scratchRoot);
  const branch='orbit-snapshot/'+mergeId;if(exactRef(root,branch))fail();
  assertNoAttributes(root,approved.files);
  assertNoCollisions(root,tree(root,baseSha),approved.files.filter(file=>file.presence==='present').map(file=>({path:file.path,mode:file.mode,sha:''})));
  const temporary=join(scratch,'orbit-index-'+randomUUID());mkdirSync(temporary);const indexFile=join(temporary,'index');
  trustedGit(root,['read-tree','--empty'],{indexFile});let records='';
  for(const file of approved.files)if(file.presence==='present'){
    const id=trustedGit(root,['hash-object','-w','--no-filters','--stdin'],{input:file.bytes}).toString().trim();if(!sha(id))fail();
    records+=`${file.mode} ${id}\t${file.path}\0`;
    if(Buffer.byteLength(records)>512*1024){trustedGit(root,['update-index','-z','--index-info'],{input:Buffer.from(records),indexFile});records='';}
  }
  if(records)trustedGit(root,['update-index','-z','--index-info'],{input:Buffer.from(records),indexFile});
  // write-tree must use the isolated index, never the primary index.
  const actualTree=trustedGit(root,['write-tree'],{indexFile}).toString().trim();if(!sha(actualTree))fail();
  const commitSha=trustedGit(root,['commit-tree',actualTree,'-p',baseSha],{identity:true,input:Buffer.from('Orbit approved snapshot '+mergeId+'\n')}).toString().trim();if(!sha(commitSha))fail();
  const fresh=inspectMergeTarget(root,baseSha);if(JSON.stringify(fresh)!==JSON.stringify(target))fail();
  trustedGit(root,['update-ref','refs/heads/'+branch,commitSha,'0'.repeat(baseSha.length)]);
  const candidate={commitSha,treeSha:actualTree,branch};verifyMergeCandidate(root,baseSha,approved,candidate);return candidate;
});}
export function verifyMergeCandidate(projectPath:string,baseSha:string,input:MergeSnapshot,candidate:MergeCandidate):void {guard(()=>{
  const approved=snapshot(input),root=repository(projectPath),entries=candidateTree(root,baseSha,candidate),files=approved.files.filter(file=>file.presence==='present');
  if(entries.length!==files.length)fail();const byPath=new Map(entries.map(file=>[file.path,file]));
  for(const file of files){const entry=byPath.get(file.path);if(!entry||entry.mode!==file.mode||!trustedGit(root,['cat-file','blob',entry.sha],{maxBytes:4*1024*1024}).equals(Buffer.from(file.bytes)))fail();}
});}
/** ff-only is deliberately the only working-tree write. External writers do not
 * obey this process's lock: failed/post-race observations stay unknown, no rollback.
 */
export function applyMergeCandidate(projectPath:string,input:MergeTarget,candidate:MergeCandidate):void {guard(()=>{
  const target=targetValue(input),root=resolve(projectPath),current=inspectMergeTarget(root,target.head);if(JSON.stringify(current)!==JSON.stringify(target))fail();
  const next=candidateTree(root,target.head,candidate),base=tree(root,target.head);assertNoAttributes(root,next);assertNoCollisions(root,base,next);
  trustedGit(root,['merge','--ff-only','--no-overwrite-ignore','--no-autostash','--no-edit','--no-stat',candidate.commitSha]);
  if(observeMergeApplication(root,target,candidate)!=='applied')fail();
});}
export function observeMergeApplication(projectPath:string,input:MergeTarget,candidate:MergeCandidate):'applied'|'not_applied'|'unknown' {
  try{
    const target=targetValue(input),root=repository(projectPath);assertBranch(root,target.branch);const head=objectId(root,['rev-parse','HEAD']);
    if(head===target.head){const current=inspectMergeTarget(root,target.head);return JSON.stringify(current)===JSON.stringify(target)?'not_applied':'unknown';}
    if(head!==candidate.commitSha)return 'unknown';const files=candidateTree(root,target.head,candidate);assertNoAttributes(root,files);assertClean(root);assertIndex(root,files);rawWorkspace(root,target.head,files,tree(root,target.head));assertClean(root);
    if(objectId(root,['rev-parse','HEAD'])!==head)return 'unknown';assertBranch(root,target.branch);return 'applied';
  }catch{return 'unknown';}
}

/** Caller supplies the repository default from trusted project configuration.
 * Local symbolic remote HEADs add protection without contacting any remote. */
export function inspectIntegrationTarget(projectPath:string,branch:string,defaultBranch:string):MergeTarget {
  if(!branchName(branch)||!branchName(defaultBranch))throw new Error('INTEGRATION_TARGET_INVALID');
  const root=repository(projectPath);
  const defaults=scalar(root,['for-each-ref','--format=%(symref)','refs/remotes']).split('\n').filter(Boolean).map(ref=>ref.split('/').slice(3).join('/'));
  // for-each-ref omits dangling symbolic HEADs in offline repositories.
  const remoteRefs=join(root,'.git','refs','remotes');
  if(existsSync(remoteRefs))for(const remote of readdirSync(remoteRefs)){
    if(branchName(remote)&&existsSync(join(remoteRefs,remote,'HEAD'))){
      const ref=trustedGit(root,['symbolic-ref','--quiet','refs/remotes/'+remote+'/HEAD'],{allowDiffExit:true}).toString().trim();
      if(ref)defaults.push(ref.split('/').slice(3).join('/'));
    }
  }
  if(['main','master',defaultBranch,...defaults].includes(branch))throw new Error('INTEGRATION_TARGET_PROTECTED');
  const head=objectId(projectPath,['rev-parse','--verify','refs/heads/'+branch]);
  const target=inspectMergeTarget(projectPath,head);
  if(target.branch!==branch)throw new Error('INTEGRATION_TARGET_NOT_CHECKED_OUT');
  return target;
}

/** Construct only the worker delta, then three-way merge onto the latest target.
 * The worker index, HEAD and files are never written. */
export function prepareIntegrationCandidate(projectPath:string,baseSha:string,changes:MergeSnapshot,target:MergeTarget,id:string,scratchRoot:string){
  const approved=snapshot(changes),root=repository(projectPath),scratch=directory(scratchRoot);
  if(!sha(baseSha)||!uuid(id))fail();
  tree(root,baseSha);const base=tree(root,target.head);
  const temporary=join(scratch,'orbit-integration-'+id);mkdirSync(temporary);
  const indexFile=join(temporary,'index');trustedGit(root,['read-tree',baseSha],{indexFile});
  for(const file of approved.files){
    const blob=file.presence==='present'?objectIdFromBytes(file.bytes):'0'.repeat(baseSha.length);
    trustedGit(root,['update-index','-z','--index-info'],{indexFile,input:Buffer.from(`${file.presence==='present'?file.mode:'0'} ${blob}\t${file.path}\0`)});
  }
  function objectIdFromBytes(bytes:Uint8Array){const id=trustedGit(root,['hash-object','-w','--no-filters','--stdin'],{input:bytes}).toString().trim();if(!sha(id))fail();return id;}
  const workerTree=trustedGit(root,['write-tree'],{indexFile}).toString().trim();if(!sha(workerTree))fail();
  const sourceSha=trustedGit(root,['commit-tree',workerTree,'-p',baseSha],{identity:true,input:Buffer.from('Orbit worker delta\n')}).toString().trim();if(!sha(sourceSha))fail();
  let merged:string;
  try{merged=scalar(root,['merge-tree','--write-tree','--merge-base='+baseSha,target.head,sourceSha]).split('\n')[0];}
  catch{throw new Error('INTEGRATION_CONFLICT');}
  if(!sha(merged))fail();const next=tree(root,merged);
  const changed=trustedGit(root,['diff-tree','--no-commit-id','--no-renames','--name-only','-z','-r',target.treeSha,merged]).toString('utf8').split('\0').filter(Boolean);
  if(changed.some(path=>!approved.files.some(file=>file.path===path)))throw new Error('INTEGRATION_SCOPE');
  assertNoCollisions(root,base,next);
  const commitSha=trustedGit(root,['commit-tree',merged,'-p',target.head],{identity:true,input:Buffer.from('Orbit verified integration '+id+'\n')}).toString().trim();if(!sha(commitSha))fail();
  const candidate={commitSha,treeSha:merged,branch:'orbit-snapshot/'+id};
  trustedGit(root,['update-ref','refs/heads/'+candidate.branch,commitSha,'0'.repeat(baseSha.length)]);
  const path=join(temporary,'candidate');trustedGit(root,['worktree','add','--detach','--',path,commitSha]);
  return {candidate,path,sourceSha};
}

export function integrationCandidateSnapshot(projectPath:string,target:MergeTarget,candidate:MergeCandidate,path:string):MergeSnapshot {
  const root=repository(projectPath),files=candidateTree(root,target.head,candidate);
  if(objectId(path,['rev-parse','HEAD'])!==candidate.commitSha)fail();
  assertClean(path);assertIndex(path,files);rawWorkspace(path,target.head,files);
  // Ignored writes must not escape candidate verification either.
  if(trustedGit(path,['ls-files','--others','-z']).length)fail();
  return readWorkspaceSnapshot(path,target.head,files.map(({path,mode})=>({path,mode})));
}

/** Read-only ancestry proof over immutable commit IDs; unrelated histories return false. */
export function isAncestor(projectPath:string,ancestor:string,descendant:string):boolean {
  if(!sha(ancestor)||!sha(descendant))fail();
  return trustedGit(projectPath,['merge-base',ancestor,descendant],{allowDiffExit:true}).toString().trim()===ancestor;
}
