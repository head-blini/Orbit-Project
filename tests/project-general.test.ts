import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {Studio} from '../server/studio.ts';
import {GoalService} from '../server/goal-service.ts';
import {AppError} from '../server/errors.ts';
import type {ArtifactRecord,PlanningVersion,SavedTask} from '../shared/parallel.ts';

const input=()=>({requestId:randomUUID(),name:'Research notes',kind:'general' as const});
const planningInput={format:'markdown',source:'manual',text:'# Research\n## Goal\nSummarize findings\n## Requirements\n### REQ-1\nWrite a report\n#### Acceptance criteria\n- Include evidence\n## Constraints\n- Local only\n## Open questions\n'};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-general-')),db=join(dir,'state.sqlite'),root=join(dir,'projects'),managed=join(dir,'workspaces');
  const store=new Store(db),projects=new Projects(store,managed,[],root);
  return {dir,db,root,managed,store,projects,close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
const gitRequired=(error:unknown)=>error instanceof AppError&&error.message==='GIT_REQUIRED'&&error.status===409;

test('non_git_project_roundtrip',()=>{
  const f=fixture();let store=f.store;
  try{
    const created=f.projects.createProject(input());
    assert.equal(created.project.kind,'general');assert.equal(created.workspace,null);
    assert.equal(created.project.writeEnabled,true);assert.equal(created.project.path,join(f.root,created.project.id));
    assert.deepEqual(f.projects.list(),[created.project]);assert.equal(existsSync(join(created.project.path,'.git')),false);
    store.close();store=new Store(f.db);
    const projects=new Projects(store,f.managed,[],f.root),studio=new Studio(store);
    assert.deepEqual(projects.list(),[created.project]);assert.deepEqual(projects.workspaces(),[]);
    const plan=studio.mutate(created.project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:planningInput}) as PlanningVersion;
    const approved=studio.mutate(created.project.id,'plans',plan.id,'approve',{expectedRevision:1}) as PlanningVersion;
    assert.equal(approved.state,'approved');
    const tasks=studio.mutate(created.project.id,'plans',plan.id,'task-drafts',{}) as SavedTask[];
    assert.equal(tasks.length,1);assert.equal(tasks[0].projectId,created.project.id);
    const artifact=studio.mutate(created.project.id,'artifacts',undefined,undefined,{requestId:randomUUID(),input:{kind:'mermaid',source:'flowchart TD\na["Evidence"]\nb["Report"]\na --> b',metadata:{title:'Research'}}}) as ArtifactRecord;
    const goal=new GoalService(store).create(created.project.id,{requestId:randomUUID(),planningVersionId:plan.id,expectedPlanningHash:plan.contentHash});
    store.close();store=new Store(f.db);
    assert.equal(store.projects()[0].kind,'general');assert.deepEqual(new Studio(store).read(created.project.id,'tasks'),tasks);
    assert.deepEqual(new Studio(store).read(created.project.id,'artifacts'),[artifact]);assert.equal(new GoalService(store).list(created.project.id)[0].goal.id,goal.id);
    assert.equal(existsSync(join(created.project.path,'.git')),false);assert.deepEqual(readdirSync(f.managed),[]);
  }finally{store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('code_workspace_is_opt_in',async()=>{
  const f=fixture();let nativeCalls=0;
  const controller=new Controller(f.store,f.dir,()=>{nativeCalls++;throw new Error('NATIVE_FORBIDDEN');},f.projects);
  try{
    const created=controller.createProject(input()),id=created.project.id;
    assert.equal(created.workspace,null);assert.deepEqual(controller.snapshot().workspaces,[]);
    assert.equal(controller.snapshot().projects?.[0].kind,'general');assert.equal(controller.snapshot().selectedWorkspaceId,null);
    for(const action of [()=>controller.createWorktree(id),()=>f.projects.create(id),()=>f.projects.mergeProject(id),()=>controller.workspaceDiff(id),
      ()=>controller.analyzeSourceGraph(id),()=>controller.verificationSetupView(id),
      ()=>controller.startVerification({requestId:randomUUID(),workspaceId:id,runId:randomUUID(),commandId:'test',expectedSourceDigest:'0'.repeat(64),expectedConfigDigest:'0'.repeat(64)}),
      ()=>controller.prepareMerge({requestId:randomUUID(),workspaceId:id,runId:randomUUID(),expectedSourceDigest:'0'.repeat(64),expectedCheckSetDigest:'0'.repeat(64),expectedApprovalId:randomUUID(),expectedTargetBranch:'main',expectedTargetHead:'0'.repeat(40)})])assert.throws(action,gitRequired);
    await assert.rejects(controller.selectWorkspace(id),gitRequired);
    await assert.rejects(controller.submitTask(id,randomUUID(),{requestId:randomUUID(),workspaceId:randomUUID()}),gitRequired);
    await assert.rejects(controller.submit({requestId:randomUUID(),workspaceId:id,prompt:'Write a report'}),gitRequired);
    assert.equal(nativeCalls,0);assert.deepEqual(f.store.runs(),[]);assert.deepEqual(f.store.workspaces(),[]);
    assert.equal(existsSync(join(created.project.path,'.git')),false);
  }finally{await controller.close();f.close();}
});

test('general projects reject workspace-dependent planning and native review entry points',async()=>{
  const f=fixture(),controller=new Controller(f.store,f.dir,()=>{throw new Error('NATIVE_FORBIDDEN');},f.projects);
  try{
    const {project}=f.projects.createProject(input());
    for(const workspaceId of [project.id,randomUUID()]){
      assert.throws(()=>controller.previewPlanning(project.id,{workspaceId,text:'Write a report'}),gitRequired);
      assert.throws(()=>controller.startPlanning(project.id,{requestId:randomUUID(),workspaceId,text:'Write a report',expectedPreviewDigest:'0'.repeat(64),confirmed:true}),gitRequired);
      assert.throws(()=>controller.taskVerificationPreview(project.id,randomUUID(),workspaceId),gitRequired);
    }
    assert.throws(()=>controller.startReview({requestId:randomUUID(),workspaceId:project.id,runId:randomUUID(),expectedPreviewDigest:'0'.repeat(64),confirmed:true}),gitRequired);
    assert.deepEqual(f.store.runs(),[]);assert.deepEqual(f.store.workspaces(),[]);
  }finally{await controller.close();f.close();}
});

test('existing_projects_default_to_code',()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-legacy-project-')),db=join(dir,'legacy.sqlite');
  // The pre-kind Store schema: raw JSON project rows, no kind column or field.
  const old=new DatabaseSync(db),legacy={id:randomUUID(),name:'Legacy',path:join(dir,'existing'),createdAt:'2026-10-27T00:00:00.000Z',writeEnabled:false};
  old.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE workspaces(id TEXT PRIMARY KEY,body TEXT NOT NULL);');
  old.prepare('INSERT INTO projects VALUES(?,?)').run(legacy.id,JSON.stringify(legacy));old.close();
  const store=new Store(db);try{
    assert.deepEqual(store.projects(),[{...legacy,kind:'code'}]);
    assert.equal(store.db.prepare('SELECT body FROM projects WHERE id=?').get(legacy.id)!.body,JSON.stringify(legacy));
    const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects'));
    const created=projects.createProject({requestId:randomUUID(),name:'Code default'});
    assert.equal(created.project.kind,'code');assert.ok(created.workspace);assert.equal(created.workspace.projectId,created.project.id);
    assert.ok(existsSync(join(created.project.path,'.git')));
    store.saveProject({...legacy,id:randomUUID()});assert.equal(store.projects().at(-1)!.kind,'code');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('general_creation_idempotent_by_request_id',()=>{
  const f=fixture(),request=input();let store=f.store;
  try{
    const first=f.projects.createProject(request);assert.deepEqual(f.projects.createProject(request),first);
    for(const next of [{...request,name:'Changed'},{...request,kind:'code' as const},{requestId:request.requestId,name:request.name}])assert.throws(()=>f.projects.createProject(next),/IDEMPOTENCY_CONFLICT/);
    store.close();store=new Store(f.db);const projects=new Projects(store,f.managed,[],f.root);
    assert.deepEqual(projects.createProject(request),first);assert.equal(store.projects().length,1);assert.deepEqual(store.workspaces(),[]);
    assert.deepEqual(readdirSync(f.root),[first.project.id]);assert.deepEqual(readdirSync(f.managed),[]);
  }finally{store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('pre-kind code receipts remain owned and idempotent with omitted or explicit code kind',()=>{
  const f=fixture(),request={requestId:randomUUID(),name:'Legacy receipt'};let store=f.store;
  try{
    const first=f.projects.createProject(request);assert.ok(first.workspace);
    const receipt=JSON.parse(String(store.db.prepare('SELECT body FROM project_creation_receipts').get()!.body));
    delete receipt.kind;
    store.db.prepare('UPDATE project_creation_receipts SET body=?').run(JSON.stringify(receipt));
    store.close();store=new Store(f.db);const projects=new Projects(store,f.managed,[],f.root);
    assert.deepEqual(projects.createProject(request),first);assert.deepEqual(projects.createProject({...request,kind:'code'}),first);
    assert.throws(()=>projects.createProject({...request,kind:'general'}),/IDEMPOTENCY_CONFLICT/);
    assert.equal(projects.writable(first.workspace.id).id,first.workspace.id);assert.equal(store.workspaces().length,1);
  }finally{store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('general_creation_validates_fields',()=>{
  const f=fixture();try{
    for(const bad of [null,[],{}, {...input(),kind:null},{...input(),kind:undefined},{...input(),kind:'other'},{...input(),kind:1},
      {...input(),path:f.dir},{...input(),command:'git init'},{...input(),writeEnabled:true},{...input(),name:'../escape'},
      {...input(),name:'credentials'},{...input(),name:'secret=fixture-value'},{...input(),name:'line\nname'},
      {...input(),requestId:'../invalid'}, {...input(),get kind(){throw new Error('GETTER_MUST_NOT_RUN');}},
      Object.assign(Object.create({kind:'general'}),{requestId:randomUUID(),name:'Invalid prototype'})]){
      assert.throws(()=>f.projects.createProject(bad as any),error=>error instanceof AppError&&error.message==='INVALID_FIELDS'&&error.status===400);
    }
    assert.deepEqual(f.store.projects(),[]);assert.deepEqual(f.store.workspaces(),[]);assert.deepEqual(readdirSync(f.root),[]);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM project_creation_receipts').get()!.count,0);
    assert.equal(f.projects.createProject({...input(),name:'  Report  '}).project.name,'Report');
  }finally{f.close();}
});

test('general creation retains exact ownership and rejects root, directory, link and Git substitution',()=>{
  for(const target of ['root','project','link','git'] as const){
    const f=fixture();try{
      const request=input(),created=f.projects.createProject(request),path=target==='root'?f.root:created.project.path;
      if(target==='git')mkdirSync(join(path,'.git'));
      else{renameSync(path,path+'-held');if(target==='link')symlinkSync(path+'-held',path,'junction');else mkdirSync(path);}
      assert.equal(f.projects.list()[0].writeEnabled,false,target);
      assert.throws(()=>f.projects.createProject(request),/PROJECT_CREATION_UNAVAILABLE/);
      assert.equal(f.store.projects().length,1);assert.deepEqual(f.store.workspaces(),[]);
    }finally{f.close();}
  }
});

test('general creation failed or interrupted receipts never replay after restart',()=>{
  for(const state of ['failed','creating'] as const){
    const f=fixture(),request=input();let store=f.store;
    try{
      if(state==='failed'){
        store.once('event',event=>{assert.equal(event.kind,'project.creation.intent');const row=store.db.prepare('SELECT body FROM project_creation_receipts').get()!;
          const receipt=JSON.parse(String(row.body));mkdirSync(receipt.projectPath);writeFileSync(join(receipt.projectPath,'foreign.txt'),'preserve');});
        assert.throws(()=>f.projects.createProject(request),/PROJECT_CREATION_INCOMPLETE/);
      }else{
        f.projects.createProject(request);store.db.prepare("UPDATE project_creation_receipts SET body=json_set(body,'$.state','creating')").run();
      }
      const before=readdirSync(f.root);store.close();store=new Store(f.db);
      const projects=new Projects(store,f.managed,[],f.root);
      assert.throws(()=>projects.createProject(request),/PROJECT_CREATION_INCOMPLETE/);
      assert.ok(projects.list().every(project=>!project.writeEnabled));assert.deepEqual(readdirSync(f.root),before);
      assert.deepEqual(store.workspaces(),[]);assert.deepEqual(readdirSync(f.managed),[]);
    }finally{store.close();rmSync(f.dir,{recursive:true,force:true});}
  }
});
