import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,renameSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {tmpdir} from './temp.ts';

const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,stdio:'pipe'}).trim();
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-creation-')),root=join(dir,'projects'),managed=join(dir,'workspaces'),db=join(dir,'state.sqlite');
  const store=new Store(db),projects=new Projects(store,managed,[],root);
  return {dir,root,managed,db,store,projects};
}
const input=()=>({requestId:randomUUID(),name:'나의 첫 프로젝트'});
function receipt(store:Store,requestId:string):any{
  const row=store.db.prepare('SELECT body FROM project_creation_receipts WHERE request_id=?').get(requestId);
  assert.ok(row);return JSON.parse(String(row.body));
}

test('a name creates a committed owned project and isolated ready workspace without external allowlist',()=>{
  const f=fixture();try{
    assert.equal(f.projects.creationAvailable,true);const request=input(),result=f.projects.createProject(request);
    assert.equal(result.project.name,request.name);assert.equal(result.project.writeEnabled,true);
    assert.equal(result.project.path,join(f.root,result.project.id));assert.equal(result.workspace.projectId,result.project.id);
    assert.equal(result.workspace.path,join(f.managed,result.workspace.id));assert.equal(result.workspace.status,'ready');
    assert.equal(git(result.project.path,'branch','--show-current'),'main');assert.equal(git(result.project.path,'status','--porcelain'),'');
    assert.equal(git(result.project.path,'log','-1','--format=%an <%ae>'),'Orbit Local <orbit@localhost>');
    assert.equal(git(result.workspace.path,'rev-parse','HEAD'),result.workspace.baseSha);
    assert.deepEqual(git(result.project.path,'ls-tree','--name-only','HEAD').split('\n'),['README.md']);
    writeFileSync(join(result.workspace.path,'app.txt'),'workspace only');assert.equal(existsSync(join(result.project.path,'app.txt')),false);
    assert.equal(f.projects.writable(result.workspace.id).id,result.workspace.id);assert.equal(f.store.runs().length,0);
  }finally{f.store.close();}
});
test('ready requests survive response loss and Store restart without another project or worktree',()=>{
  const f=fixture(),request=input();const first=f.projects.createProject(request);
  assert.deepEqual(f.projects.createProject(request),first);
  assert.throws(()=>f.projects.createProject({...request,name:'다른 이름'}),/IDEMPOTENCY_CONFLICT/);
  f.store.close();const reopened=new Store(f.db);try{
    const projects=new Projects(reopened,f.managed,[],f.root);
    assert.deepEqual(projects.createProject(request),first);assert.equal(projects.writable(first.workspace.id).id,first.workspace.id);
    assert.equal(reopened.projects().length,1);assert.equal(reopened.workspaces().length,1);assert.deepEqual(readdirSync(f.root),[first.project.id]);
  }finally{reopened.close();}
});
test('disabled construction creates no creation root and cannot grant persisted ownership',()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-disabled-')),store=new Store(':memory:');try{
    const projects=new Projects(store,join(dir,'workspaces'));assert.equal(projects.creationAvailable,false);
    assert.throws(()=>projects.createProject(input()),/PROJECT_CREATION_UNAVAILABLE/);assert.equal(existsSync(join(dir,'projects')),false);
  }finally{store.close();}
  const f=fixture();try{const result=f.projects.createProject(input()),disabled=new Projects(f.store,f.managed);
    assert.equal(disabled.list()[0].writeEnabled,false);assert.throws(()=>disabled.writable(result.workspace.id),/WRITES_DISABLED/);
  }finally{f.store.close();}
});
test('display names and exact input reject path, command, markup, secret and control payloads before allocation',()=>{
  const f=fixture();try{
    for(const name of ['', ' '.repeat(3),'a'.repeat(81),'../escape','/tmp/escape','C:\\escape','--upload-pack=bad','<img src=x>','secret=fixture-value','sk-fixture-not-real','line\nname']){
      assert.throws(()=>f.projects.createProject({requestId:randomUUID(),name}),/INVALID_FIELDS/,name);
    }
    assert.throws(()=>f.projects.createProject({...input(),path:f.dir} as any),/INVALID_FIELDS/);
    assert.throws(()=>f.projects.createProject({requestId:'../bad',name:'Valid'}),/INVALID_FIELDS/);
    assert.deepEqual(readdirSync(f.root),[]);assert.equal(f.store.projects().length,0);
    const result=f.projects.createProject({requestId:randomUUID(),name:'  우리 앱  '});assert.equal(result.project.name,'우리 앱');
    assert.notEqual(basename(result.project.path),'우리 앱');
  }finally{f.store.close();}
});
test('an unrelated repository under the same root and a forged project ID never inherit ownership',()=>{
  const f=fixture();try{
    const owned=f.projects.createProject(input()),foreign=join(f.root,randomUUID());mkdirSync(foreign);
    git(foreign,'init','-q','-b','main');writeFileSync(join(foreign,'note.txt'),'foreign');git(foreign,'add','note.txt');
    git(foreign,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','foreign');
    const registered=f.projects.register(foreign);assert.equal(registered.writeEnabled,false);assert.throws(()=>f.projects.create(registered.id),/WRITES_DISABLED/);
    const forged={...owned.project,id:randomUUID()};f.store.saveProject(forged);
    assert.equal(f.projects.list().find(p=>p.id===forged.id)!.writeEnabled,false);assert.equal(git(foreign,'status','--porcelain'),'');
  }finally{f.store.close();}
});
test('root, parent, project and common Git directory replacement revoke owned grants',()=>{
  for(const target of ['root','parent','project','git'] as const){
    const f=fixture();try{
      const request=input(),created=f.projects.createProject(request);
      const path=target==='root'?f.root:target==='parent'?f.dir:target==='project'?created.project.path:join(created.project.path,'.git');
      renameSync(path,path+'-held');mkdirSync(path);
      assert.equal(f.projects.list()[0].writeEnabled,false,target);assert.throws(()=>f.projects.createProject(request),/PROJECT_CREATION_UNAVAILABLE/);
      if(target==='root'||target==='parent')assert.equal(f.projects.creationAvailable,false,target);
      assert.ok(existsSync(path+'-held'));assert.deepEqual(readdirSync(path),[]);
    }finally{f.store.close();}
  }
});
test('root symlink substitution denies new allocation and preserves existing files',()=>{
  const f=fixture();try{
    const created=f.projects.createProject(input()),held=f.root+'-held';renameSync(f.root,held);symlinkSync(held,f.root,'junction');
    assert.equal(f.projects.creationAvailable,false);assert.equal(f.projects.list()[0].writeEnabled,false);
    assert.throws(()=>f.projects.createProject(input()),/PROJECT_CREATION_UNAVAILABLE/);assert.ok(existsSync(join(held,created.project.id,'README.md')));
  }finally{f.store.close();}
});
test('intent exists before a conflicting directory can fail creation and failed requests never allocate again',()=>{
  const f=fixture(),request=input();try{
    f.store.once('event',event=>{assert.equal(event.kind,'project.creation.intent');const r=receipt(f.store,request.requestId);
      assert.equal(existsSync(r.projectPath),false);assert.equal(existsSync(r.workspacePath),false);
      mkdirSync(r.projectPath);writeFileSync(join(r.projectPath,'foreign.txt'),'preserve');
    });
    assert.throws(()=>f.projects.createProject(request),/PROJECT_CREATION_INCOMPLETE/);
    const r=receipt(f.store,request.requestId);assert.equal(r.state,'failed');assert.ok(r.projectId);assert.ok(r.workspaceId);
    assert.equal(readFileSync(join(r.projectPath,'foreign.txt'),'utf8'),'preserve');assert.equal(f.store.projects().length,0);
    assert.throws(()=>f.projects.createProject(request),/PROJECT_CREATION_INCOMPLETE/);assert.deepEqual(readdirSync(f.root),[r.projectId]);
  }finally{f.store.close();}
});
test('Git failure preserves the allocated path and preallocated IDs without replay',()=>{
  const f=fixture(),request=input();try{
    let injected=false;f.store.db.function('fixture_break_git',value=>{
      const r=JSON.parse(String(value));if(!injected){injected=true;writeFileSync(join(r.projectPath,'.git','config'),'[invalid config\n');}return 0;
    });
    f.store.db.exec("CREATE TRIGGER break_git AFTER UPDATE ON project_creation_receipts WHEN json_extract(new.body,'$.gitIdentity') IS NOT NULL BEGIN SELECT fixture_break_git(new.body); END;");
    assert.throws(()=>f.projects.createProject(request),/PROJECT_CREATION_INCOMPLETE/);
    const r=receipt(f.store,request.requestId);assert.equal(injected,true);assert.ok(r.gitIdentity);assert.equal(r.baseSha,null);
    assert.ok(existsSync(join(r.projectPath,'README.md')));assert.equal(readFileSync(join(r.projectPath,'.git','config'),'utf8'),'[invalid config\n');
    assert.equal(f.store.projects().length,0);assert.equal(f.store.workspaces().length,0);assert.equal(existsSync(r.workspacePath),false);
    assert.throws(()=>f.projects.createProject(request),/PROJECT_CREATION_INCOMPLETE/);
  }finally{f.store.close();}
});
test('intent storage failure cannot create an unjournaled repository',()=>{
  const f=fixture();try{
    f.store.db.exec("CREATE TRIGGER reject_intent BEFORE INSERT ON project_creation_receipts BEGIN SELECT RAISE(ABORT,'fixture intent failure'); END;");
    assert.throws(()=>f.projects.createProject(input()),/PROJECT_CREATION_INCOMPLETE/);
    assert.deepEqual(readdirSync(f.root),[]);assert.equal(f.store.projects().length,0);assert.equal(f.store.workspaces().length,0);
  }finally{f.store.close();}
});
test('reopening a replaced root cannot rebaseline its identity or create another project',()=>{
  const f=fixture(),request=input(),created=f.projects.createProject(request);f.store.close();renameSync(f.root,f.root+'-held');mkdirSync(f.root);
  const reopened=new Store(f.db);try{
    const projects=new Projects(reopened,f.managed,[],f.root);assert.equal(projects.creationAvailable,false);assert.equal(projects.list()[0].writeEnabled,false);
    assert.throws(()=>projects.createProject(request),/PROJECT_CREATION_UNAVAILABLE/);assert.throws(()=>projects.createProject(input()),/PROJECT_CREATION_UNAVAILABLE/);
    assert.deepEqual(readdirSync(f.root),[]);assert.ok(existsSync(join(f.root+'-held',created.project.id,'README.md')));
  }finally{reopened.close();}
});
test('linked creation parent is rejected before it can create any target directory',()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-linked-parent-')),target=join(dir,'target'),link=join(dir,'link');mkdirSync(target);symlinkSync(target,link,'junction');
  const store=new Store(':memory:');try{
    assert.throws(()=>new Projects(store,join(dir,'managed'),[],join(link,'projects')),/LINK_REJECTED/);
    assert.equal(existsSync(join(target,'projects')),false);
  }finally{store.close();}
});
test('creation root cannot equal, contain, or nest under the worktree root',()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-root-overlap-')),managed=join(dir,'workspaces'),store=new Store(':memory:');try{
    for(const root of [managed,join(managed,'nested'),dir])assert.throws(()=>new Projects(store,managed,[],root),/INVALID_PROJECT_CREATION_ROOT/);
    assert.equal(existsSync(join(managed,'nested')),false);
  }finally{store.close();}
});
test('Windows mixed-case roots cannot bypass worktree overlap checks',{skip:process.platform!=='win32'},()=>{
  const dir=mkdtempSync(join(tmpdir(),'orbit-root-case-')),managed=join(dir,'workspaces'),store=new Store(':memory:');try{
    assert.throws(()=>new Projects(store,managed,[],join(managed.toUpperCase(),'nested')),/INVALID_PROJECT_CREATION_ROOT/);
    assert.equal(existsSync(join(managed,'nested')),false);
  }finally{store.close();}
});
test('project save failure leaves the initialized repository but never grants it ownership',()=>{
  const f=fixture(),request=input();try{
    f.store.db.exec("CREATE TRIGGER reject_project BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT,'fixture save failure'); END;");
    assert.throws(()=>f.projects.createProject(request),/PROJECT_CREATION_INCOMPLETE/);
    const r=receipt(f.store,request.requestId);assert.equal(r.state,'failed');assert.ok(git(r.projectPath,'rev-parse','HEAD'));
    assert.equal(f.store.projects().length,0);assert.equal(existsSync(r.workspacePath),false);
    f.store.db.exec('DROP TRIGGER reject_project');const registered=f.projects.register(r.projectPath);assert.equal(registered.writeEnabled,false);
    assert.throws(()=>f.projects.createProject(request),/PROJECT_CREATION_INCOMPLETE/);
  }finally{f.store.close();}
});
test('workspace save failure retains both allocated identifiers and never replays after restart',()=>{
  const f=fixture(),request=input();
  f.store.db.exec("CREATE TRIGGER reject_workspace BEFORE INSERT ON workspaces BEGIN SELECT RAISE(ABORT,'fixture workspace failure'); END;");
  assert.throws(()=>f.projects.createProject(request),/PROJECT_CREATION_INCOMPLETE/);const r=receipt(f.store,request.requestId);
  assert.equal(r.state,'failed');assert.equal(f.store.projects()[0].id,r.projectId);assert.equal(f.projects.list()[0].writeEnabled,false);
  f.store.db.exec('DROP TRIGGER reject_workspace');f.store.close();const reopened=new Store(f.db);try{
    const projects=new Projects(reopened,f.managed,[],f.root);assert.throws(()=>projects.createProject(request),/PROJECT_CREATION_INCOMPLETE/);
    assert.equal(reopened.workspaces().length,0);assert.equal(existsSync(r.workspacePath),false);assert.deepEqual(readdirSync(f.root),[r.projectId]);
  }finally{reopened.close();}
});
test('a persisted incomplete receipt is not automatically replayed or treated as writable on reopen',()=>{
  const f=fixture(),request=input(),created=f.projects.createProject(request),r=receipt(f.store,request.requestId);
  f.store.db.prepare('UPDATE project_creation_receipts SET body=? WHERE request_id=?').run(JSON.stringify({...r,state:'creating'}),request.requestId);f.store.close();
  const reopened=new Store(f.db);try{
    const projects=new Projects(reopened,f.managed,[],f.root);assert.equal(projects.list()[0].writeEnabled,false);
    assert.throws(()=>projects.createProject(request),/PROJECT_CREATION_INCOMPLETE/);assert.ok(existsSync(join(created.project.path,'README.md')));
    assert.equal(reopened.projects().length,1);assert.equal(reopened.workspaces().length,1);
  }finally{reopened.close();}
});
