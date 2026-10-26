import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,lstatSync,unlinkSync} from 'node:fs';
import {join,delimiter,isAbsolute,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

const gitBinary=(process.env.PATH??'').split(delimiter).filter(isAbsolute).map(path=>join(path,process.platform==='win32'?'git.exe':'git')).find(path=>existsSync(path)&&lstatSync(path).isFile())!;
const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,
  GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',
  GIT_AUTHOR_NAME:'Orbit Fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'Orbit Fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'};
const module=await import('../server/merge-git.ts').catch(()=>null);
function api(){assert.ok(module,'merge Git implementation must exist');return module;}
function fixture(){
  const owner=mkdtempSync(join(tmpdir(),'orbit-merge-git-')),primary=join(owner,'primary'),source=join(owner,'source'),scratch=join(owner,'scratch');
  // Every actual mutation in this harness stays beneath this freshly owned temp root.
  for(const path of [primary,source,scratch])assert.ok(relative(resolve(owner),resolve(path))&&!relative(resolve(owner),resolve(path)).startsWith('..'));
  mkdirSync(primary);mkdirSync(scratch);writeFileSync(join(owner,'owned.json'),JSON.stringify({purpose:'merge Git disposable fixture'}));
  const git=(cwd:string,args:string[],input?:Uint8Array)=>execFileSync(gitBinary,['-c','core.hooksPath=/dev/null','-c','core.autocrlf=false','-c','commit.gpgSign=false',...args],{cwd,env,input,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  git(primary,['init','-b','target']);
  for(const [path,bytes] of [['a.txt',Buffer.from('base\n')],['delete.txt',Buffer.from('removed\n')],['binary.bin',Buffer.from([0,1,255])],['empty.txt',Buffer.alloc(0)],['.gitignore',Buffer.from('ignored.txt\n.gitattributes\nignored-dir/\n')]] as const)writeFileSync(join(primary,path),bytes);
  git(primary,['add','--','.']);git(primary,['commit','-m','fixture base']);const baseSha=git(primary,['rev-parse','HEAD']).toString().trim();
  git(primary,['worktree','add','-b','source','--',source,baseSha]);
  writeFileSync(join(source,'a.txt'),'approved\r\nraw\n');unlinkSync(join(source,'delete.txt'));writeFileSync(join(source,'new.txt'),'new\n');writeFileSync(join(source,'binary.bin'),Buffer.from([0,255,128,2]));
  const files=git(source,['ls-files','--stage','-z']).toString().split('\0').filter(Boolean).map(row=>{const [meta,path]=row.split('\t');return {path,mode:meta.split(' ')[0],...(existsSync(join(source,path))?{presence:'present' as const,bytes:readFileSync(join(source,path))}:{presence:'deleted' as const})};});
  files.push({path:'new.txt',mode:'100644',presence:'present',bytes:readFileSync(join(source,'new.txt'))});
  const snapshot={sourceDigest:'a'.repeat(64),files};
  const sourceBefore={head:git(source,['rev-parse','HEAD']),index:readFileSync(join(primary,'.git','worktrees','source','index')),status:git(source,['status','--porcelain=v1','-z'])};
  const originalFiles=files.map(file=>file.presence==='present'?{...file,bytes:Buffer.from(file.bytes)}:{...file});
  const unchanged=()=>{assert.deepEqual(git(source,['rev-parse','HEAD']),sourceBefore.head);assert.deepEqual(readFileSync(join(primary,'.git','worktrees','source','index')),sourceBefore.index);assert.deepEqual(git(source,['status','--porcelain=v1','-z']),sourceBefore.status);for(const file of originalFiles)if(file.presence==='present')assert.deepEqual(readFileSync(join(source,file.path)),file.bytes);else assert.equal(existsSync(join(source,file.path)),false);};
  return {owner,primary,source,scratch,git,baseSha,snapshot,unchanged};
}

test('raw binary/empty/deleted snapshot candidate preserves source index and HEAD, applies ff, and is observable',()=>{
  const m=api(),f=fixture(),primaryIndex=readFileSync(join(f.primary,'.git','index')),target=m.inspectMergeTarget(f.primary,f.baseSha);
  assert.equal(target.branch,'target');assert.equal(target.head,f.baseSha);
  const candidate=m.prepareMergeCandidate(f.primary,f.baseSha,f.snapshot,randomUUID(),f.scratch);
  f.unchanged();assert.equal(f.git(f.primary,['rev-parse','HEAD']).toString().trim(),f.baseSha);assert.deepEqual(readFileSync(join(f.primary,'.git','index')),primaryIndex);
  m.verifyMergeCandidate(f.primary,f.baseSha,f.snapshot,candidate);assert.equal(m.observeMergeApplication(f.primary,target,candidate),'not_applied');
  m.applyMergeCandidate(f.primary,target,candidate);assert.equal(m.observeMergeApplication(f.primary,target,candidate),'applied');
  for(const file of f.snapshot.files)if(file.presence==='present')assert.deepEqual(readFileSync(join(f.primary,file.path)),file.bytes);else assert.equal(existsSync(join(f.primary,file.path)),false);
  f.unchanged();assert.equal(f.git(f.primary,['status','--porcelain=v1','-z']).length,0);
});

test('candidate verification rejects altered bytes, modes, extra paths, forged parent and moved candidate ref',()=>{
  const m=api(),f=fixture(),candidate=m.prepareMergeCandidate(f.primary,f.baseSha,f.snapshot,randomUUID(),f.scratch);
  const copy=()=>structuredClone(f.snapshot);
  const changed=copy();const file=changed.files.find(file=>file.presence==='present')!;if(file.presence==='present')file.bytes=Buffer.from('different');
  assert.throws(()=>m.verifyMergeCandidate(f.primary,f.baseSha,changed,candidate),/MERGE_/);
  const modes=copy();modes.files[0].mode='100755';assert.throws(()=>m.verifyMergeCandidate(f.primary,f.baseSha,modes,candidate),/MERGE_/);
  const extra=copy();extra.files.push({path:'extra.txt',mode:'100644',presence:'present',bytes:Buffer.alloc(0)});assert.throws(()=>m.verifyMergeCandidate(f.primary,f.baseSha,extra,candidate),/MERGE_/);
  const wrong=f.git(f.primary,['commit-tree',candidate.treeSha,'-p',candidate.commitSha],Buffer.from('wrong parent')).toString().trim();
  f.git(f.primary,['update-ref','refs/heads/'+candidate.branch,wrong,candidate.commitSha]);
  assert.throws(()=>m.verifyMergeCandidate(f.primary,f.baseSha,f.snapshot,{...candidate,commitSha:wrong}),/MERGE_/);f.unchanged();
});

test('inspection blocks staged/unstaged/untracked state and never selects a fallback branch',()=>{
  const m=api();
  for(const kind of ['staged','unstaged','untracked','detached','head'] as const){const f=fixture();
    if(kind==='untracked')writeFileSync(join(f.primary,'user.txt'),'preserve user data');
    if(kind==='unstaged'||kind==='staged')writeFileSync(join(f.primary,'a.txt'),'preserve user data');
    if(kind==='staged')f.git(f.primary,['add','--','a.txt']);
    if(kind==='detached')f.git(f.primary,['checkout','--detach',f.baseSha]);
    if(kind==='head')f.git(f.primary,['commit','--allow-empty','-m','user commit']);
    assert.throws(()=>m.inspectMergeTarget(f.primary,f.baseSha),/MERGE_/);f.unchanged();
    if(['unstaged','staged'].includes(kind))assert.equal(readFileSync(join(f.primary,'a.txt'),'utf8'),'preserve user data');
  }
});

test('ignored collisions, attributes, executable hooks and Git operation markers block without overwriting user files',()=>{
  const m=api();
  for(const kind of ['ignored','attributes','config','hook','operation','lock'] as const){const f=fixture();
    if(kind==='ignored'){writeFileSync(join(f.primary,'ignored.txt'),'preserve ignored');f.snapshot.files.push({path:'ignored.txt',mode:'100644',presence:'present',bytes:Buffer.from('approved')});}
    if(kind==='attributes')writeFileSync(join(f.primary,'.git','info','attributes'),'* filter=untrusted\n');
    if(kind==='config')f.git(f.primary,['config','--local','core.autocrlf','true']);
    if(kind==='hook')writeFileSync(join(f.primary,'.git','hooks','post-merge'),'#!/bin/sh\nexit 99\n');
    if(kind==='operation')writeFileSync(join(f.primary,'.git','MERGE_HEAD'),f.baseSha);
    if(kind==='lock')writeFileSync(join(f.primary,'.git','index.lock'),'user lock');
    assert.throws(()=>{const target=m.inspectMergeTarget(f.primary,f.baseSha),candidate=m.prepareMergeCandidate(f.primary,f.baseSha,f.snapshot,randomUUID(),f.scratch);m.applyMergeCandidate(f.primary,target,candidate);},/MERGE_/);
    if(kind==='ignored')assert.equal(readFileSync(join(f.primary,'ignored.txt'),'utf8'),'preserve ignored');f.unchanged();
  }
});

test('fresh target races and dirty post-application state stay unknown without rollback or a second merge',()=>{
  const m=api(),f=fixture(),target=m.inspectMergeTarget(f.primary,f.baseSha),candidate=m.prepareMergeCandidate(f.primary,f.baseSha,f.snapshot,randomUUID(),f.scratch);
  f.git(f.primary,['commit','--allow-empty','-m','new user head']);const userHead=f.git(f.primary,['rev-parse','HEAD']);
  assert.throws(()=>m.applyMergeCandidate(f.primary,target,candidate),/MERGE_/);assert.deepEqual(f.git(f.primary,['rev-parse','HEAD']),userHead);assert.equal(m.observeMergeApplication(f.primary,target,candidate),'unknown');
  const g=fixture(),other=m.inspectMergeTarget(g.primary,g.baseSha),next=m.prepareMergeCandidate(g.primary,g.baseSha,g.snapshot,randomUUID(),g.scratch);m.applyMergeCandidate(g.primary,other,next);
  writeFileSync(join(g.primary,'a.txt'),'new user content');assert.equal(m.observeMergeApplication(g.primary,other,next),'unknown');assert.equal(readFileSync(join(g.primary,'a.txt'),'utf8'),'new user content');
});

test('invalid manifests and accessors are rejected before candidate refs or object writes',()=>{
  const m=api(),f=fixture();let reads=0;
  const malformed=[{...f.snapshot,files:[{path:'../escape',mode:'100644',presence:'present',bytes:Buffer.from('secret')}]},{...f.snapshot,files:[{path:'.env',mode:'100644',presence:'present',bytes:Buffer.from('secret')}]},
    {...f.snapshot,files:[{path:'a.txt',mode:'120000',presence:'present',bytes:Buffer.from('link')}]},{...f.snapshot,files:[{path:'a.txt',mode:'100644',presence:'present',get bytes(){reads++;throw new Error('RAW_SECRET');}}]}];
  for(const snapshot of malformed)assert.throws(()=>m.prepareMergeCandidate(f.primary,f.baseSha,snapshot as never,randomUUID(),f.scratch),/^Error: MERGE_/);
  assert.equal(reads,0);assert.equal(f.git(f.primary,['for-each-ref','--format=%(refname)','refs/heads/orbit-snapshot/']).length,0);f.unchanged();
});

test('trusted Git uses bounded byte IO, strips injected Git environment, and returns fixed errors',async()=>{
  api();const {trustedGit}=await import('../server/git-process.ts'),f=fixture();
  const before=process.env.GIT_DIR;process.env.GIT_DIR=join(f.owner,'untrusted-metadata');
  try{assert.equal(trustedGit(f.primary,['rev-parse','HEAD']).toString().trim(),f.baseSha);}finally{if(before===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=before;}
  assert.throws(()=>trustedGit(f.primary,['show','HEAD:a.txt'],{maxBytes:1}),/^Error: GIT_OPERATION_FAILED$/);
  assert.throws(()=>trustedGit(f.primary,['show','HEAD:RAW_SECRET_DO_NOT_RETURN']),/^Error: GIT_OPERATION_FAILED$/);
  assert.throws(()=>trustedGit(f.primary,['rev-parse','HEAD'],{indexFile:'relative-index'}),/^Error: GIT_OPERATION_FAILED$/);
  for(const maxBytes of [null,0,NaN,4*1024*1024+1])assert.throws(()=>trustedGit(f.primary,['rev-parse','HEAD'],{maxBytes} as never),/^Error: GIT_OPERATION_FAILED$/);
  let reads=0;assert.throws(()=>trustedGit(f.primary,['rev-parse','HEAD'],Object.create({get input(){reads++;throw new Error('RAW_ERROR');}})),/^Error: GIT_OPERATION_FAILED$/);assert.equal(reads,0);
});

test('hidden index flags and ignored checkout attributes are rejected before any fast-forward',()=>{
  const m=api();
  for(const kind of ['--assume-unchanged','--skip-worktree','attributes'] as const){const f=fixture();
    if(kind==='attributes')writeFileSync(join(f.primary,'.gitattributes'),'* text eol=crlf\n');else f.git(f.primary,['update-index',kind,'--','a.txt']);
    const primaryIndex=readFileSync(join(f.primary,'.git','index'));
    assert.throws(()=>m.inspectMergeTarget(f.primary,f.baseSha),/MERGE_/);
    assert.deepEqual(readFileSync(join(f.primary,'.git','index')),primaryIndex);f.unchanged();
  }
});

test('ignored directory/file collisions and changed target branch preserve every user object',()=>{
  const m=api(),f=fixture();mkdirSync(join(f.primary,'ignored-dir'));writeFileSync(join(f.primary,'ignored-dir','user.txt'),'user ignored directory');
  f.snapshot.files.push({path:'ignored-dir',mode:'100644',presence:'present',bytes:Buffer.from('replacement')});
  assert.throws(()=>m.prepareMergeCandidate(f.primary,f.baseSha,f.snapshot,randomUUID(),f.scratch),/MERGE_/);
  assert.equal(readFileSync(join(f.primary,'ignored-dir','user.txt'),'utf8'),'user ignored directory');
  const g=fixture(),target=m.inspectMergeTarget(g.primary,g.baseSha),candidate=m.prepareMergeCandidate(g.primary,g.baseSha,g.snapshot,randomUUID(),g.scratch);
  g.git(g.primary,['checkout','-b','different-user-branch']);assert.throws(()=>m.applyMergeCandidate(g.primary,target,candidate),/MERGE_/);
  assert.equal(m.observeMergeApplication(g.primary,target,candidate),'unknown');assert.equal(g.git(g.primary,['branch','--show-current']).toString().trim(),'different-user-branch');g.unchanged();
});

test('maximum four-MiB raw blobs survive candidate validation and ff without text encoding conversion',()=>{
  const m=api(),f=fixture(),target=m.inspectMergeTarget(f.primary,f.baseSha),bytes=Buffer.alloc(4*1024*1024,255);bytes[0]=0;
  const file=f.snapshot.files.find(file=>file.path==='binary.bin')!;if(file.presence==='present')file.bytes=bytes;
  const candidate=m.prepareMergeCandidate(f.primary,f.baseSha,f.snapshot,randomUUID(),f.scratch);m.verifyMergeCandidate(f.primary,f.baseSha,f.snapshot,candidate);
  m.applyMergeCandidate(f.primary,target,candidate);assert.deepEqual(readFileSync(join(f.primary,'binary.bin')),bytes);f.unchanged();
});

test('a branch checked out by another worktree cannot be selected as a merge target',()=>{
  const m=api(),f=fixture(),other=join(f.owner,'duplicate-target');
  assert.ok(relative(f.owner,other)&&!relative(f.owner,other).startsWith('..'));
  f.git(f.primary,['worktree','add','--force','--',other,'target']);
  assert.throws(()=>m.inspectMergeTarget(f.primary,f.baseSha),/MERGE_/);f.unchanged();
});

test('a source ref transaction in the common Git metadata blocks target inspection',()=>{
  const m=api(),f=fixture();writeFileSync(join(f.primary,'.git','refs','heads','source.lock'),'external Git transaction');
  assert.throws(()=>m.inspectMergeTarget(f.primary,f.baseSha),/MERGE_/);assert.equal(readFileSync(join(f.primary,'.git','refs','heads','source.lock'),'utf8'),'external Git transaction');f.unchanged();
});

test('a late dirty target cannot activate repository-configured automatic stash',async()=>{
  const m=api(),{trustedGit}=await import('../server/git-process.ts'),f=fixture();
  f.git(f.primary,['config','--local','merge.autoStash','true']);
  const candidate=m.prepareMergeCandidate(f.primary,f.baseSha,f.snapshot,randomUUID(),f.scratch);
  // This is the actual final native command after a concurrent editor writes
  // between the last application clean gate and Git acquiring its own locks.
  writeFileSync(join(f.primary,'a.txt'),'late user edit\n');
  assert.throws(()=>trustedGit(f.primary,['merge','--ff-only','--no-overwrite-ignore','--no-edit','--no-stat',candidate.commitSha]),/^Error: GIT_OPERATION_FAILED$/);
  assert.equal(f.git(f.primary,['rev-parse','HEAD']).toString().trim(),f.baseSha);
  assert.equal(readFileSync(join(f.primary,'a.txt'),'utf8'),'late user edit\n');
  assert.equal(f.git(f.primary,['for-each-ref','--format=%(refname)','refs/stash']).length,0);
  assert.equal(existsSync(join(f.primary,'.git','MERGE_AUTOSTASH')),false);f.unchanged();
});

test('an external repository-configured excludes file cannot hide target user changes',()=>{
  const m=api(),f=fixture(),outside=join(f.owner,'outside-ignore.txt');writeFileSync(outside,'hidden.txt\n');
  f.git(f.primary,['config','--local','core.excludesFile',outside]);writeFileSync(join(f.primary,'hidden.txt'),'untracked user edit');
  assert.throws(()=>m.inspectMergeTarget(f.primary,f.baseSha),/MERGE_/);
  assert.equal(readFileSync(join(f.primary,'hidden.txt'),'utf8'),'untracked user edit');f.unchanged();
});
