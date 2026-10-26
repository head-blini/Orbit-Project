import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,execFileSync,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,linkSync,renameSync,copyFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {RepositoryAuthority} from '../server/repository-authority.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'orbit-authority-')),repo=join(root,'repo');mkdirSync(repo);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,stdio:'pipe',windowsHide:true});
  git('init','-q','-b','main');writeFileSync(join(repo,'index.txt'),'owned fixture\n');git('add','index.txt');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','-qm','fixture');
  const store=new Store(':memory:'),projects=new Projects(store,join(root,'state-a','workspaces'),[repo]);
  const workspace=projects.create(projects.register(repo).id),resource=projects.repositoryResource(workspace.id);
  const common=join(repo,'.git'),directory=join(common,'.orbit-authority-v1'),path=join(directory,'authority.sqlite');
  return {root,repo,store,projects,resource,common,directory,path,cleanup(){store.close();rmSync(root,{recursive:true,force:true});}};
}
const input=(resource:any,id='operation-a')=>({operationId:id,requestId:'request-'+id,kind:'solo_turn',resource});

test('authority is explicitly created, readonly inspection is inert, and one repository has one durable manager',()=>{
  const f=fixture();let a:RepositoryAuthority|undefined,b:RepositoryAuthority|undefined;
  try{
    assert.equal(RepositoryAuthority.inspect(f.common),null);assert.equal(existsSync(f.directory),false);
    a=RepositoryAuthority.create(f.common);const token=a.acquire('owner-a');
    b=RepositoryAuthority.open(f.common);assert.deepEqual(b.acquire('owner-a'),token);assert.throws(()=>b!.acquire('owner-b'),/REPOSITORY_OWNED/);
    assert.equal(b.snapshot().claim?.ownerIncarnation,'owner-a');a.close();a=undefined;
    assert.throws(()=>b!.acquire('owner-b'),/REPOSITORY_OWNED/,'closing a handle cannot release the manager claim');
    assert.equal(RepositoryAuthority.inspect(f.common)?.claim?.ownerIncarnation,'owner-a');
  }finally{a?.close();b?.close();f.cleanup();}
});

test('CAS transitions retain dispatched work and never-dispatched release advances fencing',()=>{
  const f=fixture(),a=RepositoryAuthority.create(f.common);try{
    const first=a.acquire('owner-a'),intent=a.begin(first,input(f.resource));
    assert.deepEqual(a.begin(first,input(f.resource)),intent,'exact request replay creates no duplicate intent');
    const reordered={baseRevision:f.resource.baseRevision,targetBranch:f.resource.targetBranch,worktreePath:f.resource.worktreePath,directory:{birthtimeNs:f.resource.directory.birthtimeNs,inode:f.resource.directory.inode,device:f.resource.directory.device},commonGitDir:f.resource.commonGitDir,repositoryId:f.resource.repositoryId};
    assert.deepEqual(a.begin(first,input(reordered)),intent,'field order cannot turn the same request into a conflict');
    assert.throws(()=>a.begin(first,{...input(f.resource),kind:'review'}),/REQUEST_CONFLICT/);
    assert.throws(()=>a.relinquishUnstarted(first),/OPERATIONS_UNRESOLVED/);
    assert.throws(()=>a.cancelIntent(first,intent.operationId,intent.revision+1),/REVISION_MISMATCH/);
    a.cancelIntent(first,intent.operationId,intent.revision);a.relinquishUnstarted(first);
    const second=a.acquire('owner-b');assert.ok(second.fencingGeneration>first.fencingGeneration);
    assert.throws(()=>a.begin(first,input(f.resource,'stale')),/OWNERSHIP_STALE/);
    assert.throws(()=>a.relinquishUnstarted(first),/OWNERSHIP_STALE/);
    const next=a.begin(second,input(f.resource,'operation-b')),sent=a.dispatch(second,next.operationId,next.revision);
    assert.throws(()=>a.cancelIntent(second,sent.operationId,sent.revision),/ALREADY_DISPATCHED/);
    const uncertain=a.quarantine(second,sent.operationId,sent.revision);assert.equal(uncertain.state,'quarantined');
    assert.throws(()=>a.relinquishUnstarted(second),/OPERATIONS_UNRESOLVED/);
    assert.throws(()=>a.begin(second,input(f.resource,'conflicting')),/OPERATIONS_UNRESOLVED/);
    assert.throws(()=>a.dispatch(second,sent.operationId,sent.revision),/REVISION_MISMATCH/);
  }finally{a.close();f.cleanup();}
});

test('resource drift blocks dispatch and corrupted current claims cannot grant authority',()=>{
  const f=fixture(),a=RepositoryAuthority.create(f.common),db=new DatabaseSync(f.path);try{
    const token=a.acquire('owner-a'),intent=a.begin(token,input(f.resource));
    execFileSync('git',['checkout','-qb','different-branch'],{cwd:f.resource.worktreePath,stdio:'pipe',windowsHide:true});
    assert.throws(()=>a.dispatch(token,intent.operationId,intent.revision),/RESOURCE_MISMATCH/);assert.equal(a.snapshot().operations[0].state,'intent');
    db.exec("UPDATE authority_claims SET body=json_set(body,'$.fencingGeneration',999)");
    assert.throws(()=>a.acquire('owner-a'),/AUTHORITY_INTEGRITY/);
  }finally{db.close();a.close();f.cleanup();}
});

test('failed durable intent or audit leaves no partial operation or release',()=>{
  const f=fixture(),a=RepositoryAuthority.create(f.common),db=new DatabaseSync(f.path);try{
    const token=a.acquire('owner-a');db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON authority_events BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    assert.throws(()=>a.begin(token,input(f.resource)),/AUTHORITY_WRITE_FAILED/);assert.equal(a.snapshot().operations.length,0);
    assert.throws(()=>a.relinquishUnstarted(token),/AUTHORITY_WRITE_FAILED/);assert.equal(a.snapshot().claim?.ownerIncarnation,'owner-a');
    db.exec('DROP TRIGGER reject_event');const intent=a.begin(token,input(f.resource));
    db.exec("CREATE TRIGGER reject_dispatch BEFORE UPDATE ON authority_operations BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    assert.throws(()=>a.dispatch(token,intent.operationId,intent.revision),/AUTHORITY_WRITE_FAILED/);assert.equal(a.snapshot().operations[0].state,'intent');
    db.exec('DROP TRIGGER reject_dispatch');const sent=a.dispatch(token,intent.operationId,intent.revision);
    db.exec("CREATE TRIGGER reject_quarantine BEFORE UPDATE ON authority_operations BEGIN SELECT RAISE(FAIL,'fixture'); END;");
    assert.throws(()=>a.quarantine(token,sent.operationId,sent.revision),/AUTHORITY_WRITE_FAILED/);assert.equal(a.snapshot().operations[0].state,'dispatched');
    assert.throws(()=>a.relinquishUnstarted(token),/OPERATIONS_UNRESOLVED/);
  }finally{db.close();a.close();f.cleanup();}
});

test('a corrupted operation generation cannot hide a dispatched operation during release',()=>{
  const f=fixture(),a=RepositoryAuthority.create(f.common),db=new DatabaseSync(f.path);try{
    const token=a.acquire('owner-a'),intent=a.begin(token,input(f.resource));a.dispatch(token,intent.operationId,intent.revision);
    db.exec('UPDATE authority_operations SET generation=999');
    assert.throws(()=>a.relinquishUnstarted(token),/AUTHORITY_INTEGRITY/);
  }finally{db.close();a.close();f.cleanup();}
});

test('missing held or released claim rows cannot reset fencing while their audit remains',()=>{
  for(const release of [false,true]){
    const f=fixture(),a=RepositoryAuthority.create(f.common),db=new DatabaseSync(f.path);try{
      const token=a.acquire('owner-a');if(release)a.relinquishUnstarted(token);
      db.exec('DELETE FROM authority_claims');
      assert.throws(()=>a.snapshot(),/AUTHORITY_INTEGRITY/);assert.throws(()=>a.acquire('owner-b'),/AUTHORITY_INTEGRITY/);
    }finally{db.close();a.close();f.cleanup();}
  }
});

test('silently ignored dispatch or audit writes cannot return a successful dispatch receipt',()=>{
  const f=fixture(),a=RepositoryAuthority.create(f.common),db=new DatabaseSync(f.path);try{
    const token=a.acquire('owner-a'),intent=a.begin(token,input(f.resource));
    db.exec('CREATE TRIGGER ignore_dispatch BEFORE UPDATE ON authority_operations BEGIN SELECT RAISE(IGNORE); END;');
    assert.throws(()=>a.dispatch(token,intent.operationId,intent.revision),/AUTHORITY_WRITE_FAILED/);
    assert.equal(a.snapshot().operations[0].state,'intent');db.exec('DROP TRIGGER ignore_dispatch');
    db.exec('CREATE TRIGGER ignore_audit BEFORE INSERT ON authority_events BEGIN SELECT RAISE(IGNORE); END;');
    assert.throws(()=>a.dispatch(token,intent.operationId,intent.revision),/AUTHORITY_WRITE_FAILED/);
    assert.equal(a.snapshot().operations[0].state,'intent');
    db.exec("DROP TRIGGER ignore_audit; CREATE TRIGGER alter_after_audit AFTER INSERT ON authority_events WHEN NEW.kind='operation.dispatched' BEGIN UPDATE authority_operations SET body=json_set(body,'$.kind','review') WHERE operation_id=NEW.operation_id; END;");
    assert.throws(()=>a.dispatch(token,intent.operationId,intent.revision),/AUTHORITY_WRITE_FAILED/);
    assert.equal(a.snapshot().operations[0].kind,'solo_turn');assert.equal(a.snapshot().operations[0].state,'intent');
  }finally{db.close();a.close();f.cleanup();}
});

test('authority rejects inert-input violations, cross-repository resources and replaced storage',()=>{
  const f=fixture(),other=fixture(),a=RepositoryAuthority.create(f.common);try{
    const token=a.acquire('owner-a');let getter=false;
    assert.throws(()=>a.begin(token,{...input(f.resource),get kind(){getter=true;return 'solo_turn';}}));assert.equal(getter,false);
    assert.throws(()=>a.begin(token,input(other.resource)),/RESOURCE_MISMATCH/);
    const copied=join(f.root,'held.sqlite');renameSync(f.path,copied);copyFileSync(copied,f.path);
    assert.throws(()=>a.acquire('owner-a'),/AUTHORITY_PATH_CHANGED/);
  }finally{a.close();f.cleanup();other.cleanup();}
});

test('unknown data, linked databases and journals never become an authority',()=>{
  const f=fixture();try{
    mkdirSync(f.directory);writeFileSync(join(f.directory,'unrelated.txt'),'preserve');
    assert.throws(()=>RepositoryAuthority.create(f.common),/AUTHORITY_INTEGRITY/);assert.equal(readFileSync(join(f.directory,'unrelated.txt'),'utf8'),'preserve');
  }finally{f.cleanup();}
  for(const kind of ['symlink','hardlink','journal']){
    const f=fixture();try{
      const a=RepositoryAuthority.create(f.common);a.close();const target=join(f.root,'target');writeFileSync(target,'untouched');
      if(kind==='journal')symlinkSync(target,f.path+'-journal');
      else {renameSync(f.path,join(f.root,'original.sqlite'));if(kind==='symlink')symlinkSync(target,f.path);else linkSync(target,f.path);}
      assert.throws(()=>RepositoryAuthority.open(f.common),/AUTHORITY_INTEGRITY/);assert.equal(readFileSync(target,'utf8'),'untouched');
    }finally{f.cleanup();}
  }
});

async function message(child:ChildProcess):Promise<any>{return new Promise((yes,no)=>{const timer=setTimeout(()=>{cleanup();no(Error('fixture IPC timeout'));},10000);const onMessage=(value:any)=>{cleanup();yes(value);};const onExit=()=>{cleanup();no(Error('fixture exited before response'));};const cleanup=()=>{clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit);};child.once('message',onMessage);child.once('exit',onExit);});}

test('independent live processes contend atomically and killing the owner preserves the unresolved claim',{timeout:20000},async()=>{
  const f=fixture();RepositoryAuthority.create(f.common).close();const script=join(f.root,'manager.mjs');
  writeFileSync(script,`import {RepositoryAuthority} from ${JSON.stringify(new URL('../server/repository-authority.ts',import.meta.url).href)};const a=RepositoryAuthority.open(process.argv[2]);let token;process.send({ready:true});process.on('message',message=>{try{if(message.dispatch){const intent=a.begin(token,message.input);process.send(a.dispatch(token,intent.operationId,intent.revision));}else{token=a.acquire(process.argv[3]);process.send({owned:true,token});}}catch(e){process.send({owned:false,code:e.message});}});`);
  const children:ChildProcess[]=[];try{
    for(const owner of ['manager-a','manager-b']){const state=join(f.root,owner);mkdirSync(state);const child=fork(script,[f.common,owner],{cwd:state,execArgv:[],silent:true});children.push(child);child.stdout!.resume();child.stderr!.resume();assert.deepEqual(await message(child),{ready:true});}
    const replies=children.map(child=>message(child));for(const child of children)child.send({acquire:true});
    const outcomes=await Promise.all(replies);assert.equal(outcomes.filter(value=>value.owned).length,1);assert.equal(outcomes.filter(value=>!value.owned).length,1);
    const ownerIndex=outcomes.findIndex(value=>value.owned),winner=children[ownerIndex];
    const dispatched=message(winner);winner.send({dispatch:true,input:input(f.resource)});assert.equal((await dispatched).state,'dispatched');
    const exit=once(winner,'exit');winner.kill('SIGKILL');await exit;
    const observer=RepositoryAuthority.open(f.common);try{assert.throws(()=>observer.acquire('replacement-manager'),/REPOSITORY_OWNED/);assert.deepEqual(observer.snapshot().claim?.ownerIncarnation,outcomes[ownerIndex].token.ownerIncarnation);assert.equal(observer.snapshot().operations[0].state,'dispatched');}finally{observer.close();}
  }finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}f.cleanup();}
});
