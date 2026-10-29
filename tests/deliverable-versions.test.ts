import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,linkSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {DeliverableVersions,deliverableId} from '../server/deliverable-versions.ts';
import {listDeliverables,readOutputDeliverable,downloadHeaders} from '../server/deliverables.ts';

test('observations append, deduplicate, survive restart and never overwrite unavailable versions',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-versions-')),files=join(root,'outputs'),db=join(root,'state.sqlite');mkdirSync(files);
  let store=new Store(db);
  try{
    let service=new DeliverableVersions(store);const id=deliverableId('p','result.txt');
    const observe=()=>service.observe('p',files,listDeliverables(files,[]));
    writeFileSync(join(files,'result.txt'),'first');observe();observe();
    assert.equal(service.list('p',files,id).length,1);
    const first=service.list('p',files,id)[0];assert.equal(first.runId,null);assert.equal(first.runAt,null);
    assert.equal(service.download('p',files,id,first.id).bytes.toString(),'first');
    writeFileSync(join(files,'result.txt'),'second');observe();
    assert.equal(service.list('p',files,id).length,2);assert.equal(service.list('p',files,id)[0].available,undefined,'list must not claim byte retention');
    assert.throws(()=>service.download('p',files,id,first.id),/VERSION_UNAVAILABLE/);
    assert.throws(()=>service.download('other',files,id,first.id),/NOT_FOUND/);
    assert.throws(()=>store.db.prepare('UPDATE deliverable_versions SET body=?').run('{}'),/APPEND_ONLY/);
    assert.throws(()=>store.db.exec('DELETE FROM deliverable_versions'),/APPEND_ONLY/);
    writeFileSync(join(files,'result.txt'),'first');observe();assert.equal(service.list('p',files,id).length,3);
    store.close();store=new Store(db);service=new DeliverableVersions(store);
    assert.equal(service.list('p',files,id).length,3);assert.equal(service.download('p',files,id,first.id).bytes.toString(),'first');
    const changes=store.db.prepare('SELECT total_changes() AS n').get()!.n;service.list('p',files,id);service.download('p',files,id,first.id);
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('output boundary rejects inputs, aliases, hard links and symbolic links; headers force attachment',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-output-'));
  try{
    mkdirSync(join(root,'inputs'));writeFileSync(join(root,'inputs','source.txt'),'input');
    writeFileSync(join(root,'result.txt'),'result');
    for(const path of ['inputs/source.txt','inputs/../result.txt','./result.txt','../result.txt','/result.txt','result.txt/','result.txt\0','sub//result.txt'])assert.throws(()=>readOutputDeliverable(root,path));
    linkSync(join(root,'result.txt'),join(root,'alias.txt'));assert.throws(()=>readOutputDeliverable(root,'result.txt'));assert.throws(()=>readOutputDeliverable(root,'alias.txt'));
    symlinkSync(join(root,'inputs'),join(root,'linked'));assert.throws(()=>readOutputDeliverable(root,'linked/source.txt'));
    const path='bad"name.html';writeFileSync(join(root,path),'<script>alert(1)</script>');
    const headers=downloadHeaders(readOutputDeliverable(root,path));assert.equal(headers['Content-Type'],'application/octet-stream');
    assert.equal(headers['Content-Disposition'],'attachment; filename="bad_name.html"');assert.equal(headers['X-Content-Type-Options'],'nosniff');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('validated retained worker bytes preserve provenance and remain downloadable after published bytes change',async()=>{
  const {Projects}=await import('../server/projects.ts'),{ParallelWorkerService}=await import('../server/parallel-workers.ts');
  const {WorkerSpaces,generalAttemptPath,resolveWorkerPath}=await import('../server/worker-spaces.ts');
  const {randomUUID}=await import('node:crypto');const {chmodSync,readdirSync}=await import('node:fs');
  const dir=mkdtempSync(join(tmpdir(),'orbit-retained-')),store=new Store(join(dir,'state.sqlite'));
  try{
    const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects'));
    const {project}=projects.createProject({requestId:randomUUID(),name:'Retained',kind:'general'});
    const workers=new ParallelWorkerService(store),spaces=new WorkerSpaces(store,projects,workers),attemptId=randomUUID(),dispatchRequestId=randomUUID();
    const batch={id:randomUUID(),projectId:project.id,planningVersionId:'plan',graphRevision:1,planningHash:'a'.repeat(64),taskIds:['task'],contractDigests:[],inputArtifactHashes:[],runtimeChoices:[{taskId:'task',runtimeId:'claude-code' as const}],parallelLimit:1};
    const reservation=workers.reserve({requestId:randomUUID(),ownerIncarnation:'owner',batch,attempt:{id:attemptId,taskId:'task',runtimeId:'claude-code',dispatchRequestId},claims:[{kind:'isolated_folder',host:'local',path:resolveWorkerPath(project.path,join(generalAttemptPath(project.path,attemptId),'output'),true)}]});
    const space=spaces.create(reservation);writeFileSync(join(space.path,'output','report.txt'),'retained');
    const run=store.createRun(dispatchRequestId,'digest','fixture',undefined,{projectId:project.id,taskId:'task',planningVersionId:'plan',planningContentHash:batch.planningHash});
    store.updateRun(run.id,{execution:'completed'},'run.completed');workers.transition(reservation,'dispatched');workers.confirmTerminal(reservation,{kind:'terminal_confirmed',dispatchRequestId,evidenceId:'receipt'});
    const manifest=spaces.finish(reservation);
    store.db.exec('CREATE TABLE integration_queue(body TEXT NOT NULL)');store.db.prepare('INSERT INTO integration_queue VALUES(?)').run(JSON.stringify({space,manifest}));
    mkdirSync(join(project.path,'output'));writeFileSync(join(project.path,'output','report.txt'),'retained');
    const service=new DeliverableVersions(store),id=deliverableId(project.id,'output/report.txt');service.observe(project.id,project.path,listDeliverables(project.path,[]),run.id);
    const version=service.list(project.id,project.path,id)[0];assert.equal(version.runId,run.id);assert.equal(version.taskId,'task');assert.equal(version.runAt,store.getRun(run.id)!.updatedAt);
    writeFileSync(join(project.path,'output','report.txt'),'new version');assert.equal(service.download(project.id,project.path,id,version.id).bytes.toString(),'retained');
    writeFileSync(join(space.path,'output','report.txt'),'tampered');assert.throws(()=>service.download(project.id,project.path,id,version.id),/VERSION_UNAVAILABLE/);
  }finally{store.close();const writable=(path:string)=>{chmodSync(path,0o700);for(const e of readdirSync(path,{withFileTypes:true}))if(e.isDirectory())writable(join(path,e.name));};writable(dir);rmSync(dir,{recursive:true,force:true});}
});

test('controller records output observations on completed runs without executing models; reads stay inert',async t=>{
  const {Projects}=await import('../server/projects.ts'),{Controller}=await import('../server/controller.ts'),{randomUUID}=await import('node:crypto');
  const dir=mkdtempSync(join(tmpdir(),'orbit-observe-')),store=new Store(join(dir,'state.sqlite'));
  const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects')),{project}=projects.createProject({requestId:randomUUID(),name:'Observed',kind:'general'});
  const controller=new Controller(store,dir,()=>{throw Error('NATIVE_FORBIDDEN');},projects);
  try{
    const observations=t.mock.method(controller.deliverableVersions,'observe');
    writeFileSync(join(project.path,'result.txt'),'version one');const run=store.createRun(randomUUID(),'digest','fixture',undefined,{projectId:project.id,taskId:'task'});
    store.updateRun(run.id,{execution:'completed'},'run.completed');
    assert.equal(observations.mock.calls[0].arguments[3],run.id);
    const id=deliverableId(project.id,'result.txt');assert.equal(controller.deliverableHistory(project.id,id).length,1);
    assert.equal(controller.deliverableHistory(project.id,id)[0].runId,null,'completion alone is not producing-run proof');
    writeFileSync(join(project.path,'result.txt'),'version two');controller.observeDeliverables(project.id);assert.equal(controller.deliverableHistory(project.id,id).length,2);
    const changes=store.db.prepare('SELECT total_changes() AS n').get()!.n;controller.deliverables(project.id);controller.deliverableDownload(project.id,id);
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
  }finally{await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('observation hashes outside the transaction, snapshots only the supplied run, and rechecks duplicates under lock',async t=>{
  const fs=(await import('node:fs')).default,{syncBuiltinESMExports}=await import('node:module');
  const dir=mkdtempSync(join(tmpdir(),'orbit-observation-lock-')),store=new Store(':memory:');
  try{
    const service=new DeliverableVersions(store);writeFileSync(join(dir,'result.txt'),'result');
    const list=listDeliverables(dir,[]),id=deliverableId('p','result.txt');
    const old=store.createRun('older-run','digest','fixture',undefined,{projectId:'p'});store.updateRun(old.id,{execution:'completed'},'run.completed');
    const run=store.createRun('current-run','digest','fixture',undefined,{projectId:'p'});store.updateRun(run.id,{execution:'completed'},'run.completed');
    const get=store.getRun.bind(store),seen:string[]=[];t.mock.method(store,'getRun',(id:string)=>{seen.push(id);return get(id);});
    const runs=t.mock.method(store,'runs');
    let locked=false,reads=0,lockedReads=0;
    for(const name of ['readSync','openSync','closeSync','lstatSync','fstatSync','realpathSync','readdirSync'] as const){
      const original=fs[name];t.mock.method(fs,name,(...args:any[])=>{if(name==='readSync')reads++;if(locked)lockedReads++;return (original as any)(...args);});
    }
    syncBuiltinESMExports();
    const transaction=store.transaction.bind(store);let injected=false;
    t.mock.method(store,'transaction',(<T>(work:()=>T)=>{
      // A competing observation commits after our file reads but before our write transaction.
      if(!injected){injected=true;service.observe('p',dir,list,run.id);}
      return transaction(()=>{locked=true;try{return work();}finally{locked=false;}});
    }));
    service.observe('p',dir,list,run.id);
    assert.ok(reads>0);assert.equal(lockedReads,0);assert.equal(runs.mock.callCount(),0);
    assert.deepEqual(seen,[run.id,run.id]);assert.equal(service.list('p',dir,id).length,1,'duplicate committed before lock acquisition must not append twice');
    const readCount=reads;
    for(let i=0;i<120;i++)store.db.prepare('INSERT INTO deliverable_versions VALUES(?,?,?,?)').run('v'+i,'p',id,JSON.stringify({...service.list('p',dir,id).at(-1),id:'v'+i}));
    const versions=service.list('p',dir,id);assert.equal(versions.length,100);assert.equal(versions[0].id,'v20');assert.equal(versions.at(-1)!.id,'v119');
    assert.equal(reads,readCount,'history metadata reads must not read file bytes');assert.ok(versions.every(v=>v.available===undefined));
  }finally{t.mock.restoreAll();syncBuiltinESMExports();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('current download reads only the requested output and observation lists once',async t=>{
  const fs=(await import('node:fs')).default,{syncBuiltinESMExports}=await import('node:module');
  const {Projects}=await import('../server/projects.ts'),{Controller}=await import('../server/controller.ts'),{randomUUID}=await import('node:crypto');
  const dir=mkdtempSync(join(tmpdir(),'orbit-target-download-')),store=new Store(join(dir,'state.sqlite'));
  const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects')),{project}=projects.createProject({requestId:randomUUID(),name:'Target',kind:'general'});
  const controller=new Controller(store,dir,()=>{throw Error('NATIVE_FORBIDDEN');},projects);
  try{
    writeFileSync(join(project.path,'a.txt'),'requested');writeFileSync(join(project.path,'z.txt'),'unrelated');
    const opened:string[]=[],open=fs.openSync;t.mock.method(fs,'openSync',(...args:any[])=>{opened.push(String(args[0]));return (open as any)(...args);});syncBuiltinESMExports();
    const list=t.mock.method(controller,'deliverables');
    assert.equal(controller.deliverableDownload(project.id,deliverableId(project.id,'a.txt')).bytes.toString(),'requested');
    assert.equal(list.mock.callCount(),0);assert.deepEqual(opened,[join(project.path,'a.txt')]);
    controller.observeDeliverables(project.id);assert.equal(list.mock.callCount(),1);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
