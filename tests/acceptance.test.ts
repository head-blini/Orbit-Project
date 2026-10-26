import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Studio} from '../server/studio.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {VerificationCommandPreview} from '../shared/verification.ts';

async function implementation(){
  assert.ok(existsSync(new URL('../server/acceptance.ts',import.meta.url)),'pre-dispatch acceptance baseline service is missing');
  return import('../server/acceptance.ts');
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'orbit-acceptance-')),root=join(directory,'project');mkdirSync(root);mkdirSync(join(root,'tests'));
  const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,stdio:'pipe'});
  git('init','-q','-b','main');
  writeFileSync(join(root,'tests','acceptance.mjs'),'assert.equal(2 + 2, 4);\n');writeFileSync(join(root,'runner.mjs'),'import "./tests/acceptance.mjs";\n');writeFileSync(join(root,'application.txt'),'before implementation');
  git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','-qm','fixture');
  const path=join(directory,'fixture.sqlite'),store=new Store(path),projects=new Projects(store,join(directory,'managed'),[root]),project=projects.register(root),workspace=projects.create(project.id),studio=new Studio(store);
  const input={format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Acceptance fixture',goal:'Keep approved test assertions',requirements:[{id:'R1',description:'Produce the intended result',acceptance_criteria:['The approved assertions pass']}],constraints:[],open_questions:[]})};
  const draft=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
  const plan=studio.mutate(project.id,'plans',draft.id,'approve',{expectedRevision:1}) as PlanningVersion;
  const [task]=studio.mutate(project.id,'plans',plan.id,'task-drafts',{}) as SavedTask[];
  let commands:(VerificationCommandPreview&{protectedFiles?:string[]})[]=[{id:'test',label:'Approved tests',executable:process.execPath,args:['runner.mjs'],timeoutMs:5000,configDigest:sha('command configuration'),protectedFiles:['tests/acceptance.mjs','runner.mjs']}];
  store.db.exec('CREATE TABLE IF NOT EXISTS run_acceptance_baselines(run_id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL)');
  const bind=(baseline:Record<string,unknown>)=>{
    const run=store.createRun(randomUUID(),'fixture','PRIVATE_PROMPT',workspace.id,{taskId:task.id,planningVersionId:plan.id,requirementLabels:['R1']});
    store.updateRun(run.id,{execution:'completed'},'run.completed');
    const saved=store.getRun(run.id)!;store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify({...saved,acceptanceDigest:baseline.digest}),run.id);
    store.db.prepare('INSERT INTO run_acceptance_baselines VALUES(?,?,?)').run(run.id,String(baseline.digest),JSON.stringify(baseline));return run;
  };
  return {directory,root,path,store,projects,project,workspace,studio,input,plan,task,bind,commands:()=>commands,setCommands:(value:typeof commands)=>{commands=value;},close:()=>{store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('preview freezes approved Task criteria configured commands and selected bytes without exposing file content or writing records',async()=>{
  const {AcceptanceService}=await implementation(),f=fixture();try{
    const service=new AcceptanceService(f.store,f.projects,f.commands),seq=f.store.lastSeq(),view=service.preview(f.project.id,f.workspace.id,f.task.id)!;
    assert.equal(view.projectId,f.project.id);assert.equal(view.taskId,f.task.id);assert.equal(view.planHash,f.plan.contentHash);assert.equal(view.baseSha,f.workspace.baseSha);
    assert.deepEqual(view.criteria,[{label:'R1',description:'Produce the intended result',acceptanceCriteria:['The approved assertions pass']}]);
    assert.deepEqual(view.commands,[{id:'test',label:'Approved tests',configDigest:sha('command configuration'),protectedFiles:['runner.mjs','tests/acceptance.mjs']}]);
    assert.deepEqual(view.files,[{path:'runner.mjs',mode:'100644',sha256:sha('import "./tests/acceptance.mjs";\n')},{path:'tests/acceptance.mjs',mode:'100644',sha256:sha('assert.equal(2 + 2, 4);\n')}]);
    assert.match(view.digest,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(view),/PRIVATE_|assert\.equal|before implementation|"bytes"|"sourceDigest"/);assert.equal(f.store.lastSeq(),seq);assert.equal(f.store.runs().length,0);
  }finally{f.close();}
});
test('ordinary implementation changes preserve a baseline while modified and restored protected bytes change applicability',async()=>{
  const {AcceptanceService}=await implementation(),f=fixture();try{
    const service=new AcceptanceService(f.store,f.projects,f.commands),baseline=service.preview(f.project.id,f.workspace.id,f.task.id)!,run=f.bind(baseline as unknown as Record<string,unknown>);
    writeFileSync(join(f.workspace.path,'application.txt'),'implemented source');assert.equal(service.preview(f.project.id,f.workspace.id,f.task.id)?.digest,baseline.digest);assert.equal(service.status(f.workspace.id,run.id).state,'current');
    writeFileSync(join(f.workspace.path,'tests','acceptance.mjs'),'// removed assertion\n');assert.equal(service.status(f.workspace.id,run.id).state,'changed');
    writeFileSync(join(f.workspace.path,'tests','acceptance.mjs'),'assert.equal(2 + 2, 4);\n');assert.equal(service.status(f.workspace.id,run.id).state,'current');
    assert.equal(JSON.parse(String(f.store.db.prepare('SELECT body FROM run_acceptance_baselines WHERE run_id=?').get(run.id)!.body)).digest,baseline.digest);
  }finally{f.close();}
});
test('deleted protected tests and changed command configuration cannot rebaseline the original Run',async()=>{
  const {AcceptanceService}=await implementation(),f=fixture();try{
    const service=new AcceptanceService(f.store,f.projects,f.commands),baseline=service.preview(f.project.id,f.workspace.id,f.task.id)!,run=f.bind(baseline as unknown as Record<string,unknown>);
    f.setCommands(f.commands().map(command=>({...command,configDigest:sha('different command configuration')})));assert.equal(service.status(f.workspace.id,run.id).state,'changed');
    f.setCommands(f.commands().map(command=>({...command,configDigest:sha('command configuration')})));unlinkSync(join(f.workspace.path,'tests','acceptance.mjs'));
    assert.throws(()=>service.preview(f.project.id,f.workspace.id,f.task.id),/ACCEPTANCE_FILE_UNAVAILABLE/);assert.equal(service.status(f.workspace.id,run.id).state,'changed');
  }finally{f.close();}
});
test('host configuration is wholly legacy or wholly protected and cannot freeze ignored or unselected paths',async()=>{
  const {AcceptanceService}=await implementation(),f=fixture();try{
    const service=new AcceptanceService(f.store,f.projects,f.commands),configured=f.commands()[0];f.setCommands([]);assert.equal(service.preview(f.project.id,f.workspace.id,f.task.id),null);
    f.setCommands([{...configured,protectedFiles:undefined}]);assert.equal(service.preview(f.project.id,f.workspace.id,f.task.id),null);
    f.setCommands([configured,{...configured,id:'legacy',protectedFiles:undefined}]);assert.throws(()=>service.preview(f.project.id,f.workspace.id,f.task.id),/ACCEPTANCE_CONFIGURATION_INCOMPLETE/);
    writeFileSync(join(f.workspace.path,'.gitignore'),'ignored-test.mjs\n');writeFileSync(join(f.workspace.path,'ignored-test.mjs'),'PRIVATE_IGNORED_TEST');
    f.setCommands([{...configured,protectedFiles:['ignored-test.mjs']}]);assert.throws(()=>service.preview(f.project.id,f.workspace.id,f.task.id),/ACCEPTANCE_FILE_UNAVAILABLE/);
  }finally{f.close();}
});
test('missing markers remain unbound and missing or tampered marked baselines are unavailable',async()=>{
  const {AcceptanceService}=await implementation(),f=fixture();try{
    const service=new AcceptanceService(f.store,f.projects,f.commands),baseline=service.preview(f.project.id,f.workspace.id,f.task.id)!,run=f.bind(baseline as unknown as Record<string,unknown>),saved=f.store.getRun(run.id)!;
    const {acceptanceDigest:_,...legacy}=saved as typeof saved&{acceptanceDigest?:string};f.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(legacy),run.id);
    assert.equal(service.status(f.workspace.id,run.id).state,'unbound');
    f.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(saved),run.id);
    f.store.db.prepare('UPDATE run_acceptance_baselines SET body=? WHERE run_id=?').run(JSON.stringify({...baseline,criteria:[]}),run.id);
    const damaged=service.status(f.workspace.id,run.id);assert.equal(damaged.state,'unavailable');assert.equal(damaged.baseline,null);
    f.store.db.prepare('DELETE FROM run_acceptance_baselines WHERE run_id=?').run(run.id);assert.equal(service.status(f.workspace.id,run.id).state,'unavailable');
  }finally{f.close();}
});
test('foreign workspace Task and baseline identities never become current',async()=>{
  const {AcceptanceService}=await implementation(),f=fixture();try{
    const service=new AcceptanceService(f.store,f.projects,f.commands),baseline=service.preview(f.project.id,f.workspace.id,f.task.id)!,run=f.bind(baseline as unknown as Record<string,unknown>),other=f.projects.create(f.project.id);
    assert.throws(()=>service.preview(randomUUID(),f.workspace.id,f.task.id),/WORKSPACE_MISMATCH|PROJECT_NOT_FOUND/);
    assert.throws(()=>service.preview(f.project.id,f.workspace.id,randomUUID()),/TASK_NOT_FOUND/);
    assert.notEqual(service.status(other.id,run.id).state,'current');
    const saved=f.store.getRun(run.id)!;f.store.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify({...saved,taskId:randomUUID()}),run.id);assert.equal(service.status(f.workspace.id,run.id).state,'unavailable');
  }finally{f.close();}
});
test('a superseding approved planning lineage makes the old immutable baseline changed',async()=>{
  const {AcceptanceService}=await implementation(),f=fixture();try{
    const service=new AcceptanceService(f.store,f.projects,f.commands),baseline=service.preview(f.project.id,f.workspace.id,f.task.id)!,run=f.bind(baseline as unknown as Record<string,unknown>);
    f.studio.mutate(f.project.id,'plans',f.plan.id,'revisions',{requestId:randomUUID(),expectedRevision:1,input:f.input});
    const state=service.status(f.workspace.id,run.id);assert.equal(state.state,'changed');assert.equal(state.baseline?.planHash,f.plan.contentHash);
  }finally{f.close();}
});
test('unreadable snapshots expose generic unknown state without raw errors or sensitive content',async t=>{
  const {AcceptanceService}=await implementation(),f=fixture();try{
    const service=new AcceptanceService(f.store,f.projects,f.commands),baseline=service.preview(f.project.id,f.workspace.id,f.task.id)!,run=f.bind(baseline as unknown as Record<string,unknown>);
    t.mock.method(f.projects,'snapshot',()=>{throw new Error('PRIVATE_PATH_AND_INTERNAL_ERROR');});
    const state=service.status(f.workspace.id,run.id);assert.equal(state.state,'unavailable');assert.doesNotMatch(JSON.stringify(state),/PRIVATE_/);
    assert.throws(()=>service.preview(f.project.id,f.workspace.id,f.task.id),/^Error: ACCEPTANCE_SOURCE_UNAVAILABLE$/);
  }finally{f.close();}
});
test('restart preserves the immutable baseline and status reads never change Run or audit history',async()=>{
  const {AcceptanceService}=await implementation(),f=fixture();let reopened:Store|undefined;
  try{
    const service=new AcceptanceService(f.store,f.projects,f.commands),baseline=service.preview(f.project.id,f.workspace.id,f.task.id)!,run=f.bind(baseline as unknown as Record<string,unknown>),seq=f.store.lastSeq(),saved=f.store.getRun(run.id);f.store.close();
    reopened=new Store(f.path);const projects=new Projects(reopened,join(f.directory,'managed'),[f.root]),restored=new AcceptanceService(reopened,projects,f.commands);
    assert.equal(restored.status(f.workspace.id,run.id).state,'current');assert.equal(reopened.lastSeq(),seq);assert.deepEqual(reopened.getRun(run.id),saved);
  }finally{if(reopened)reopened.close();else f.store.close();rmSync(f.directory,{recursive:true,force:true});}
});
test('literal Git-visible filenames containing spaces remain valid protected files',async()=>{
  const {AcceptanceService,protectedFilePaths}=await implementation(),f=fixture();try{
    const path='tests/acceptance file.mjs';writeFileSync(join(f.workspace.path,path),'assert.ok(true);\n');
    f.setCommands(f.commands().map(command=>({...command,protectedFiles:[path]})));
    assert.deepEqual(protectedFilePaths([path]),[path]);
    const service=new AcceptanceService(f.store,f.projects,f.commands),preview=service.preview(f.project.id,f.workspace.id,f.task.id)!;
    assert.deepEqual(preview.files,[{path,mode:'100644',sha256:sha('assert.ok(true);\n')}]);const run=f.bind(preview as unknown as Record<string,unknown>);assert.equal(service.status(f.workspace.id,run.id).state,'current');
  }finally{f.close();}
});
test('valid-shaped but changed criteria plan hash and selected-file hash fail stored baseline integrity',async()=>{
  const {AcceptanceService}=await implementation(),f=fixture();try{
    const service=new AcceptanceService(f.store,f.projects,f.commands),saved=service.preview(f.project.id,f.workspace.id,f.task.id)!,run=f.bind(saved as unknown as Record<string,unknown>);
    for(const changed of [{...saved,criteria:saved.criteria.map(item=>({...item,acceptanceCriteria:['Different criterion']}))},{...saved,planHash:'a'.repeat(64)},{...saved,files:saved.files.map(file=>({...file,sha256:'b'.repeat(64)}))}]){
      f.store.db.prepare('UPDATE run_acceptance_baselines SET body=? WHERE run_id=?').run(JSON.stringify(changed),run.id);const status=service.status(f.workspace.id,run.id);assert.equal(status.state,'unavailable');assert.equal(status.baseline,null);
    }
  }finally{f.close();}
});
test('shared protected paths reject aliases wildcards duplicate sparse accessor and unbounded lists',async()=>{
  const {protectedFilePaths}=await implementation();
  assert.deepEqual(protectedFilePaths(['tests/b.mjs','tests/a.mjs']),['tests/a.mjs','tests/b.mjs']);
  for(const value of [[],['../outside'],['/absolute'],['a/./b'],['a//b'],['a\\b'],['C:/outside'],['tests/*.mjs'],['a','a'],['.git/config'],['.env'],new Array(1),Array.from({length:129},(_,i)=>'f'+i)])assert.throws(()=>protectedFilePaths(value));
  const accessor=['file'];Object.defineProperty(accessor,'0',{get(){throw new Error('MUST_NOT_READ_ACCESSOR');}});assert.throws(()=>protectedFilePaths(accessor),/INVALID_PROTECTED_FILES/);
});
