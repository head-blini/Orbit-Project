import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {ParallelWorkerService} from '../server/parallel-workers.ts';
import {trustedGit} from '../server/git-process.ts';
import {repositoryIdentity} from '../server/repository-resource.ts';
import {WorkerSpaces,generalAttemptPath,resolveWorkerPath} from '../server/worker-spaces.ts';
import type {WorkerResourceClaim,WorkerReservation} from '../shared/parallel-workers.ts';

function fixture(kind:'code'|'general'='general'){
  const dir=mkdtempSync(join(tmpdir(),'orbit-worker-spaces-')),store=new Store(join(dir,'state.sqlite'));
  const projects=new Projects(store,join(dir,'managed'),[],join(dir,'projects'));
  const {project,workspace}=projects.createProject({requestId:randomUUID(),name:'Worker fixture',kind});
  const workers=new ParallelWorkerService(store),spaces=new WorkerSpaces(store,projects,workers);
  const batch={id:randomUUID(),projectId:project.id,planningVersionId:'plan',graphRevision:1,planningHash:'a'.repeat(64),taskIds:['a','b'],contractDigests:[],inputArtifactHashes:[],runtimeChoices:[{taskId:'a',runtimeId:'claude-code'},{taskId:'b',runtimeId:'claude-code'}],parallelLimit:2};
  const base=workspace?{batchId:batch.id,projectId:project.id,repositoryId:repositoryIdentity(join(project.path,'.git')).repositoryId,baseSha:workspace.baseSha}:undefined;
  function reserve(taskId='a',paths=['output/report.txt']){
    const attemptId=randomUUID();
    const claims:WorkerResourceClaim[]=base?paths.map(path=>({kind:'repository_file',repositoryId:base.repositoryId,path:resolveWorkerPath(project.path,path),mode:'write'})):
      [{kind:'isolated_folder',host:'local',path:resolveWorkerPath(project.path,join(generalAttemptPath(project.path,attemptId),'output'),true)}];
    return workers.reserve({requestId:randomUUID(),ownerIncarnation:'owner',batch,attempt:{id:attemptId,taskId,runtimeId:'claude-code',dispatchRequestId:randomUUID()},claims});
  }
  function terminal(r:WorkerReservation){workers.transition(r,'dispatched');workers.confirmTerminal(r,{kind:'terminal_confirmed',dispatchRequestId:r.attempt.dispatchRequestId,evidenceId:'receipt'});}
  return {dir,store,projects,project,workers,spaces,base,reserve,terminal,close(){
    store.close();
    const writable=(path:string)=>{chmodSync(path,0o700);for(const entry of readdirSync(path,{withFileTypes:true}))if(entry.isDirectory())writable(join(path,entry.name));};
    writable(dir);rmSync(dir,{recursive:true,force:true});
  }};
}

test('path identity rejects traversal, symlink, hardlink, case aliases and ambiguous globs',()=>{
  const f=fixture();try{
    mkdirSync(join(f.project.path,'Data'));writeFileSync(join(f.project.path,'Data','note.txt'),'input');
    symlinkSync(f.dir,join(f.project.path,'escape'));linkSync(join(f.project.path,'Data','note.txt'),join(f.project.path,'hard'));
    for(const path of ['../outside','escape/file','data/new.txt','Data/note.txt','hard','Data/../new','Data//new','Data/**/../x'])assert.throws(()=>resolveWorkerPath(f.project.path,path),path);
    assert.equal(resolveWorkerPath(f.project.path,'Data/new.txt').canonicalPath,'Data/new.txt');
    assert.throws(()=>resolveWorkerPath(f.project.path,'**/*.txt'));
  }finally{f.close();}
});
test('general attempts have distinct durable spaces, read-only inputs and empty output',()=>{
  const f=fixture();try{
    mkdirSync(join(f.project.path,'inputs'));writeFileSync(join(f.project.path,'inputs','note.txt'),'approved input');
    const a=f.reserve(),b=f.reserve('b'),sa=f.spaces.create(a),sb=f.spaces.create(b);
    assert.notEqual(sa.path,sb.path);assert.deepEqual(readdirSync(join(sa.path,'output')),[]);
    assert.equal(readFileSync(join(sa.path,'inputs','note.txt'),'utf8'),'approved input');
    assert.equal(lstatSync(join(sa.path,'inputs','note.txt')).mode&0o222,0);
    assert.equal(lstatSync(join(sa.path,'inputs')).mode&0o222,0);
    assert.match(sa.inputManifest[0].sha256,/^[a-f0-9]{64}$/);
    assert.equal(existsSync(join(sa.path,'.git')),false);
    assert.deepEqual(new WorkerSpaces(f.store,f.projects,f.workers).create(a),sa);
    assert.throws(()=>f.spaces.cleanup(a),/TERMINAL/);
    f.workers.transition(a,'lost_unknown');assert.throws(()=>f.spaces.cleanup(a),/TERMINAL/);assert.ok(existsSync(sa.path));
  }finally{f.close();}
});
test('general manifest flags modified inputs and writes outside output; cleanup requires termination',()=>{
  const f=fixture();try{
    mkdirSync(join(f.project.path,'inputs'));writeFileSync(join(f.project.path,'inputs','note.txt'),'original');
    const r=f.reserve(),s=f.spaces.create(r);chmodSync(join(s.path,'inputs','note.txt'),0o644);writeFileSync(join(s.path,'inputs','note.txt'),'tampered');
    writeFileSync(join(s.path,'output','report.txt'),'result');writeFileSync(join(s.path,'unexpected.txt'),'escape');
    assert.throws(()=>f.spaces.finish(r),/TERMINAL/);f.terminal(r);
    const m=f.spaces.finish(r);assert.equal(m.inputsUnchanged,false);assert.equal(m.outOfScope,true);
    assert.ok(m.files.some(x=>x.path==='output/report.txt'&&!x.outOfScope&&x.sha256));
    assert.ok(m.files.some(x=>x.path==='unexpected.txt'&&x.outOfScope));
    f.spaces.cleanup(r);assert.equal(existsSync(s.path),false);
  }finally{f.close();}
});
test('code attempts use approved base even after HEAD moves, and compare deleted/staged/untracked/ignored files',()=>{
  const f=fixture('code');try{
    const a=f.reserve('a',['README.md']),b=f.reserve('b',['allowed/**']);
    writeFileSync(join(f.project.path,'later.txt'),'later');trustedGit(f.project.path,['add','later.txt']);trustedGit(f.project.path,['commit','-qm','later'],{identity:true});
    const sa=f.spaces.create(a,f.base),sb=f.spaces.create(b,f.base);
    assert.notEqual(sa.path,sb.path);assert.equal(sa.baseSha,f.base!.baseSha);assert.equal(sa.repositoryId,f.base!.repositoryId);
    assert.equal(existsSync(join(sa.path,'later.txt')),false);
    rmSync(join(sa.path,'README.md'));writeFileSync(join(sa.path,'.gitignore'),'ignored.txt\n');writeFileSync(join(sa.path,'ignored.txt'),'hidden');
    writeFileSync(join(sa.path,'new.txt'),'staged');trustedGit(sa.path,['add','new.txt']);
    f.terminal(a);const m=f.spaces.finish(a);assert.equal(m.outOfScope,true);
    assert.ok(m.files.some(x=>x.path==='README.md'&&x.status==='deleted'&&!x.outOfScope));
    for(const path of ['new.txt','ignored.txt','.gitignore'])assert.ok(m.files.some(x=>x.path===path&&x.outOfScope),path);
    f.spaces.cleanup(a);assert.equal(existsSync(sa.path),false);assert.ok(existsSync(sb.path));
  }finally{f.close();}
});
test('stale fences, mismatched bases and scope aliases fail closed',()=>{
  const f=fixture('code');try{
    const r=f.reserve('a',['README.md']);assert.throws(()=>f.spaces.create(r),/BASE/);
    assert.throws(()=>f.spaces.create(r,{...f.base!,batchId:'other'}),/BASE/);
    const s=f.spaces.create(r,f.base);assert.throws(()=>f.spaces.create(r,{...f.base!,baseSha:'b'.repeat(40)}),/BASE/);
    const next=f.workers.transfer(r,'next');assert.throws(()=>f.spaces.finish(r),/FENCE/);
    f.workers.transition(next,'lost_unknown');assert.throws(()=>f.spaces.cleanup(next),/TERMINAL/);assert.ok(existsSync(s.path));
  }finally{f.close();}
});
test('Git metadata operations hold the shared Store write lock and never overlap',async()=>{
  const f=fixture('code'),other=new Store(join(f.dir,'state.sqlite'));try{
    other.db.exec('PRAGMA busy_timeout=0');let active=0,maxActive=0,observed=0;
    const original=f.store.saveWorkspace.bind(f.store);
    f.store.saveWorkspace=w=>{active++;maxActive=Math.max(maxActive,active);try{
      assert.throws(()=>other.db.exec('BEGIN IMMEDIATE'),/locked/);observed++;original(w);
    }finally{active--;}};
    let removed=0;const remove=f.projects.removeWorkerWorkspace.bind(f.projects);
    f.projects.removeWorkerWorkspace=id=>{
      assert.throws(()=>other.db.exec('BEGIN IMMEDIATE'),/locked/);removed++;remove(id);
    };
    const a=f.reserve('a',['a.txt']),b=f.reserve('b',['b.txt']);
    await Promise.all([a,b].map(r=>Promise.resolve().then(()=>f.spaces.create(r,f.base))));
    for(const r of [a,b]){f.terminal(r);f.spaces.cleanup(r);}
    assert.equal(maxActive,1);assert.ok(observed>=4);assert.equal(removed,2);
  }finally{other.close();f.close();}
});

test('general successful output hashes and not-dispatched release permit idempotent cleanup',()=>{
  const f=fixture();try{
    const r=f.reserve(),s=f.spaces.create(r);writeFileSync(join(s.path,'output','report.txt'),'result');
    f.workers.release(r,{kind:'not_dispatched',dispatchRequestId:r.attempt.dispatchRequestId,evidenceId:'never-started'});
    const result=f.spaces.finish(r);assert.equal(result.inputsUnchanged,true);assert.equal(result.outOfScope,false);
    assert.deepEqual(result.files.map(file=>file.path),['output/report.txt']);
    f.spaces.cleanup(r);f.spaces.cleanup(r);assert.equal(existsSync(s.path),false);
  }finally{f.close();}
});
test('glob claims permit nested declared writes but not sibling prefixes',()=>{
  const f=fixture('code');try{
    const r=f.reserve('a',['allowed/**/*.txt']),s=f.spaces.create(r,f.base);
    mkdirSync(join(s.path,'allowed','nested'),{recursive:true});writeFileSync(join(s.path,'allowed','nested','yes.txt'),'yes');
    writeFileSync(join(s.path,'allowed','no.ts'),'no');mkdirSync(join(s.path,'allowed-other'));writeFileSync(join(s.path,'allowed-other','no.txt'),'no');
    f.terminal(r);const result=f.spaces.finish(r);
    assert.equal(result.files.find(x=>x.path==='allowed/nested/yes.txt')?.outOfScope,false);
    assert.equal(result.files.find(x=>x.path==='allowed/no.ts')?.outOfScope,true);
    assert.equal(result.files.find(x=>x.path==='allowed-other/no.txt')?.outOfScope,true);
  }finally{f.close();}
});
test('failed input snapshot is retained and never recreated on retry',()=>{
  const f=fixture();try{
    mkdirSync(join(f.project.path,'inputs'));symlinkSync(f.dir,join(f.project.path,'inputs','escape'));
    const r=f.reserve();assert.throws(()=>f.spaces.create(r));
    const path=generalAttemptPath(f.project.path,r.attempt.id);assert.ok(existsSync(path));
    rmSync(join(f.project.path,'inputs','escape'));assert.throws(()=>f.spaces.create(r),/IDENTITY_CHANGED/);
    assert.ok(existsSync(path));
  }finally{f.close();}
});
test('replaced space identity prevents cleanup of the replacement',()=>{
  const f=fixture();try{
    const r=f.reserve(),s=f.spaces.create(r);f.terminal(r);
    // Empty input directories are removable even when their own mode is read-only.
    rmSync(s.path,{recursive:true});mkdirSync(s.path);writeFileSync(join(s.path,'keep.txt'),'replacement');
    assert.throws(()=>f.spaces.cleanup(r),/IDENTITY_CHANGED/);assert.equal(readFileSync(join(s.path,'keep.txt'),'utf8'),'replacement');
  }finally{f.close();}
});
test('worker Git entry points refuse calls outside the serialized Store transaction',()=>{
  const f=fixture('code');try{
    assert.throws(()=>f.projects.createWorkerWorkspace(f.project.id,f.base!.baseSha,randomUUID()),/SERIALIZATION_REQUIRED/);
    const r=f.reserve('a',['README.md']),s=f.spaces.create(r,f.base);
    assert.throws(()=>f.projects.removeWorkerWorkspace(s.workspaceId!),/SERIALIZATION_REQUIRED/);
    assert.ok(existsSync(s.path));
  }finally{f.close();}
});

function handoffFile(f:ReturnType<typeof fixture>,content='predecessor'){
  mkdirSync(join(f.project.path,'output'),{recursive:true});writeFileSync(join(f.project.path,'output/report.txt'),content);
  return {predecessors:[{taskId:'parent',integrationId:'integration',commitSha:null,files:[{path:'output/report.txt',sha256:createHash('sha256').update(content).digest('hex')}]}]};
}
test('CQG-6b: direct handoff is read-only, digest-bound and excluded from output manifest',()=>{
 const f=fixture();try{
  const handoff=handoffFile(f),r=f.reserve(),s=f.spaces.create(r,undefined,handoff);
  assert.equal(readFileSync(join(s.path,'inputs/output/report.txt'),'utf8'),'predecessor');
  assert.equal(lstatSync(join(s.path,'inputs/output/report.txt')).mode&0o777,0o444);
  assert.deepEqual(s.inputManifest,handoff.predecessors[0].files);
  const other=f.spaces.create(f.reserve('b'));assert.notEqual(s.inputDigest,other.inputDigest);
  f.terminal(r);assert.deepEqual(f.spaces.finish(r).files,[]);
  chmodSync(join(s.path,'inputs/output/report.txt'),0o644);writeFileSync(join(s.path,'inputs/output/report.txt'),'changed');
  assert.equal(f.spaces.finish(r).inputsUnchanged,false);
 }finally{f.close();}
});
test('CQG-6b: handoff colliding with project inputs refuses even identical bytes',()=>{
 const f=fixture();try{
  const handoff=handoffFile(f);mkdirSync(join(f.project.path,'inputs/output'),{recursive:true});writeFileSync(join(f.project.path,'inputs/output/report.txt'),'predecessor');
  assert.throws(()=>f.spaces.create(f.reserve(),undefined,handoff),/WORKER_SPACE_INPUT_CONFLICT/);
 }finally{f.close();}
});
for(const [first,second] of [['output/A.md','output/a.md'],['output/a','output/a/b']])test(`CQG-6b: aliasing handoff paths ${first} and ${second} refuse before any write`,()=>{
 const f=fixture();try{
  const sha=createHash('sha256').update('x').digest('hex'),r=f.reserve();
  const handoff={predecessors:[{taskId:'p1',integrationId:'i1',commitSha:null,files:[{path:first,sha256:sha}]},{taskId:'p2',integrationId:'i2',commitSha:null,files:[{path:second,sha256:sha}]}]};
  assert.throws(()=>f.spaces.create(r,undefined,handoff),/WORKER_SPACE_INPUT_CONFLICT/);
  assert.equal(existsSync(join(generalAttemptPath(f.project.path,r.attempt.id),'inputs/output')),false);
 }finally{f.close();}
});
test('CQG-6b: attempt handoff pin survives restart and rejects changed or omitted handoff',()=>{
 const f=fixture();try{
  const handoff=handoffFile(f),r=f.reserve(),s=f.spaces.create(r,undefined,handoff);
  const spaces=new WorkerSpaces(f.store,f.projects,f.workers);
  assert.deepEqual(spaces.create(r,undefined,handoff),s);
  assert.throws(()=>spaces.create(r,undefined,{predecessors:[{...handoff.predecessors[0],integrationId:'other'}]}),/WORKER_SPACE_HANDOFF_CONFLICT/);
  assert.throws(()=>spaces.create(r),/WORKER_SPACE_HANDOFF_CONFLICT/);
 }finally{f.close();}
});
test('CQG-6b: source changed during handoff copy fails closed',async t=>{
 const fs=(await import('node:fs')).default,{syncBuiltinESMExports}=await import('node:module');
 const f=fixture();try{
  const handoff=handoffFile(f),r=f.reserve(),write=fs.writeFileSync;let copied=false;
  t.mock.method(fs,'writeFileSync',((path:any,...args:any[])=>{
   const result=Reflect.apply(write,fs,[path,...args]);
   if(String(path)===join(generalAttemptPath(f.project.path,r.attempt.id),'inputs/output/report.txt')){copied=true;write(join(f.project.path,'output/report.txt'),'changed');}
   return result;
  }) as typeof fs.writeFileSync);syncBuiltinESMExports();
  assert.throws(()=>f.spaces.create(r,undefined,handoff),/WORKER_SPACE_INPUT_CHANGED/);assert.equal(copied,true);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();f.close();}
});

test('CQG-6b: code dependent pins independently of batch and omitted handoff is HANDOFF_CONFLICT',()=>{
 const f=fixture('code');try{
  const a=f.reserve('a',['first.txt']);f.spaces.create(a,f.base);
  trustedGit(f.project.path,['commit','--allow-empty','-m','predecessor'],{identity:true});
  const base={...f.base!,baseSha:trustedGit(f.project.path,['rev-parse','HEAD']).toString().trim()};
  const handoff={predecessors:[{taskId:'a',integrationId:'applied',commitSha:base.baseSha,files:[]}]};
  const b=f.reserve('b',['second.txt']),s=f.spaces.create(b,base,handoff);assert.equal(s.baseSha,base.baseSha);
  assert.throws(()=>f.spaces.create(b,base),/WORKER_SPACE_HANDOFF_CONFLICT/);
 }finally{f.close();}
});
