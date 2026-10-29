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
    assert.equal(service.list('p',files,id).length,2);assert.equal(service.list('p',files,id)[0].available,false);
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
    const service=new DeliverableVersions(store),id=deliverableId(project.id,'output/report.txt');service.observe(project.id,project.path,listDeliverables(project.path,[]));
    const version=service.list(project.id,project.path,id)[0];assert.equal(version.runId,run.id);assert.equal(version.taskId,'task');assert.equal(version.runAt,store.getRun(run.id)!.updatedAt);
    writeFileSync(join(project.path,'output','report.txt'),'new version');assert.equal(service.download(project.id,project.path,id,version.id).bytes.toString(),'retained');
    writeFileSync(join(space.path,'output','report.txt'),'tampered');assert.throws(()=>service.download(project.id,project.path,id,version.id),/VERSION_UNAVAILABLE/);
  }finally{store.close();const writable=(path:string)=>{chmodSync(path,0o700);for(const e of readdirSync(path,{withFileTypes:true}))if(e.isDirectory())writable(join(path,e.name));};writable(dir);rmSync(dir,{recursive:true,force:true});}
});

test('controller records output observations on completed runs without executing models; reads stay inert',async()=>{
  const {Projects}=await import('../server/projects.ts'),{Controller}=await import('../server/controller.ts'),{randomUUID}=await import('node:crypto');
  const dir=mkdtempSync(join(tmpdir(),'orbit-observe-')),store=new Store(join(dir,'state.sqlite'));
  const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects')),{project}=projects.createProject({requestId:randomUUID(),name:'Observed',kind:'general'});
  const controller=new Controller(store,dir,()=>{throw Error('NATIVE_FORBIDDEN');},projects);
  try{
    writeFileSync(join(project.path,'result.txt'),'version one');const run=store.createRun(randomUUID(),'digest','fixture',undefined,{projectId:project.id,taskId:'task'});
    store.updateRun(run.id,{execution:'completed'},'run.completed');
    const id=deliverableId(project.id,'result.txt');assert.equal(controller.deliverableHistory(project.id,id).length,1);
    assert.equal(controller.deliverableHistory(project.id,id)[0].runId,null,'completion alone is not producing-run proof');
    writeFileSync(join(project.path,'result.txt'),'version two');controller.observeDeliverables(project.id);assert.equal(controller.deliverableHistory(project.id,id).length,2);
    const changes=store.db.prepare('SELECT total_changes() AS n').get()!.n;controller.deliverables(project.id);controller.deliverableDownload(project.id,id);
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
  }finally{await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
