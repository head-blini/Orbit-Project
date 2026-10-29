import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {AppError} from '../server/errors.ts';
import {ClaudeTaskService} from '../server/claude-task-service.ts';
import {claudeFixture,outcome,session,tick} from './claude-task-fixture.ts';
import {tmpdir} from './temp.ts';

// F02-REG blocker: a registered user folder never hosts a non-isolated AI run (task, repair or planning).
const error=(message:string)=>(e:unknown)=>e instanceof AppError&&e.message===message;
// Provenance is enough to fail closed, even if the receipt would not grant ownership.
const markRegistered=(store:Store,projectId:string)=>store.db.prepare('INSERT INTO project_registration_receipts VALUES(?,?,?)').run(randomUUID(),'x',JSON.stringify({projectId}));

test('task dispatch on a registered folder without a worker space is refused before any run',async()=>{
  const f=claudeFixture(),service=new ClaudeTaskService(f.store,f.projects,f.dependencies);
  try{
    const {task}=f.plan();markRegistered(f.store,f.project.id);
    assert.equal(f.projects.isRegisteredFolder(f.project.id),true);
    assert.throws(()=>service.submit(f.project.id,task.id,randomUUID()),error('ISOLATION_REQUIRED'));
    assert.equal(f.runners.length,0);assert.equal(f.store.runs().length,0);
  }finally{await service.close();await f.close();}
});

test('registration that appears before native dispatch is caught by beforeDispatch',async()=>{
  const f=claudeFixture();let threw='',launched=0;
  const service=new ClaudeTaskService(f.store,f.projects,{findExecutable:()=>'/fake/claude',runnerFactory:config=>({
    async start(){markRegistered(f.store,f.project.id);try{config.beforeDispatch();}catch(e){threw=(e as Error).message;throw e;}launched++;return outcome('completed',{dispatch:'started',evidenceSource:'mock'});},
    interrupt(){return 'not_running';}})});
  try{
    const {task}=f.plan(),run=service.submit(f.project.id,task.id,randomUUID());await tick();
    assert.equal(threw,'ISOLATION_REQUIRED');assert.equal(launched,0);assert.notEqual(f.store.getRun(run.id)?.execution,'completed');
  }finally{await service.close();await f.close();}
});

test('quality repair reruns on a registered folder are refused too',async()=>{
  const f=claudeFixture(),service=new ClaudeTaskService(f.store,f.projects,f.dependencies);
  try{
    const {task}=f.plan(),source=service.submit(f.project.id,task.id,randomUUID());
    f.runners[0].finish(outcome('completed',{identity:{providerId:'anthropic',modelId:'observed-model',sessionId:session.sessionId,executionId:null,modelEvidence:'assistant_message'}}));await tick();
    markRegistered(f.store,f.project.id);
    assert.throws(()=>service.repair(source.id,randomUUID(),'Missing citation.'),error('ISOLATION_REQUIRED'));
    assert.equal(f.runners.length,1);
  }finally{await service.close();await f.close();}
});

test('planning on a really registered folder is refused; created projects still plan',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-folder-plan-')),folder=join(dir,'report');mkdirSync(folder);writeFileSync(join(folder,'notes.md'),'existing');
  const store=new Store(':memory:'),projects=new Projects(store,join(dir,'workspaces'),[folder],join(dir,'projects'));
  const controller=new Controller(store,dir,()=>{throw new Error('CODEX_FORBIDDEN');},projects);
  try{
    const {project}=projects.registerGeneralFolder({requestId:randomUUID(),name:'보고서',path:folder});
    assert.equal(projects.list().find(p=>p.id===project.id)?.registeredFolder,true);
    assert.throws(()=>controller.planningSuggestions.preview(project.id,{text:'보고서를 정리해 줘'}),error('ISOLATION_REQUIRED'));
    const created=projects.createProject({requestId:randomUUID(),name:'새 작업',kind:'general'}).project;
    assert.equal(projects.isRegisteredFolder(created.id),false);assert.equal(projects.list().find(p=>p.id===created.id)?.registeredFolder,undefined);
    assert.ok(controller.planningSuggestions.preview(created.id,{text:'보고서를 정리해 줘'}).previewDigest);
  }finally{await controller.close();store.close();}
});

test('replacing a material makes an approved planning preview stale',async()=>{
  const f=claudeFixture();
  try{
    const [item]=f.controller.addMaterials(f.project.id,{files:[{name:'data.txt',text:'one'}]});
    const preview=f.controller.planningSuggestions.preview(f.project.id,{text:'자료를 요약해 줘'});
    f.controller.replaceMaterial(f.project.id,{name:'data.txt',text:'two',expectedSha256:item.sha256});
    assert.notEqual(f.controller.planningSuggestions.preview(f.project.id,{text:'자료를 요약해 줘'}).previewDigest,preview.previewDigest);
    assert.throws(()=>f.controller.planningSuggestions.start(f.project.id,{requestId:randomUUID(),text:'자료를 요약해 줘',expectedPreviewDigest:preview.previewDigest,confirmed:true}),error('PLANNING_PREVIEW_STALE'));
  }finally{await f.close();}
});
