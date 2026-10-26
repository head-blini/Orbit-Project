import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readdirSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {tmpdir} from './temp.ts';

const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,stdio:'pipe',windowsHide:true});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'orbit-repository-resource-')),source=join(root,'source');mkdirSync(source);
  git(source,'init','-q','-b','main');writeFileSync(join(source,'code.ts'),'export const value=1;\n');git(source,'add','code.ts');
  git(source,'-c','user.name=Orbit Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const stores:Store[]=[];
  function state(name:string){
    const path=join(root,name);mkdirSync(path);const store=new Store(join(path,'state.sqlite'));stores.push(store);
    const projects=new Projects(store,join(path,'workspaces'),[source]);const project=projects.register(source),workspace=projects.create(project.id);
    return {store,projects,workspace,path};
  }
  return {root,source,state,close(){for(const store of stores)store.close();rmSync(root,{recursive:true,force:true});}};
}

test('different state directories and worktrees share one repository identity without creating an authority',()=>{
  const f=fixture();try{
    const a=f.state('state-a'),b=f.state('state-b'),common=join(f.source,'.git');
    assert.equal(typeof a.projects.repositoryResource,'function');
    const before=readdirSync(common,{recursive:true}).sort(),seqA=a.store.lastSeq(),seqB=b.store.lastSeq();
    const first=a.projects.repositoryResource(a.workspace.id),second=b.projects.repositoryResource(b.workspace.id),directory=lstatSync(common,{bigint:true});
    assert.match(first.repositoryId,/^[a-f0-9]{64}$/);assert.equal(first.repositoryId,second.repositoryId);assert.equal(first.commonGitDir,common);assert.equal(second.commonGitDir,common);
    assert.deepEqual(first.directory,{device:String(directory.dev),inode:String(directory.ino),birthtimeNs:String(directory.birthtimeNs)});
    assert.deepEqual(second.directory,first.directory);assert.equal(first.worktreePath,a.workspace.path);assert.equal(second.worktreePath,b.workspace.path);
    assert.notEqual(first.worktreePath,second.worktreePath);assert.notEqual(first.targetBranch,second.targetBranch);
    assert.equal(first.targetBranch,a.workspace.branch);assert.equal(second.targetBranch,b.workspace.branch);assert.equal(first.baseRevision,a.workspace.baseSha);assert.equal(second.baseRevision,b.workspace.baseSha);
    assert.deepEqual(a.projects.repositoryResource(a.workspace.id),first);
    assert.equal(a.store.lastSeq(),seqA);assert.equal(b.store.lastSeq(),seqB);assert.deepEqual(readdirSync(common,{recursive:true}).sort(),before);
    assert.equal(existsSync(join(common,'.orbit-authority-v1')),false);
    const denied=new Projects(a.store,join(a.path,'workspaces'),[]);assert.throws(()=>denied.repositoryResource(a.workspace.id),/WRITES_DISABLED/);
  }finally{f.close();}
});

test('repository identity rejects metadata links, file replacements and non-primary metadata paths',async()=>{
  const f=fixture();try{
    const a=f.state('state-a');assert.equal(typeof a.projects.repositoryResource,'function');
    const {repositoryIdentity}=await import('../server/repository-resource.ts'),common=join(f.source,'.git');
    const alias=join(f.root,'alias');symlinkSync(f.source,alias,'junction');
    assert.throws(()=>repositoryIdentity(join(alias,'.git')),/LINK_REJECTED/);
    assert.throws(()=>repositoryIdentity(a.workspace.path));
    assert.throws(()=>repositoryIdentity(join(a.workspace.path,'.git')));
    const held=join(f.root,'held-metadata');renameSync(common,held);symlinkSync(held,common,'junction');
    assert.throws(()=>repositoryIdentity(common),/LINK_REJECTED/);assert.throws(()=>a.projects.repositoryResource(a.workspace.id));
    rmSync(common);writeFileSync(common,'gitdir: fixture-only\n');
    assert.throws(()=>repositoryIdentity(common));assert.throws(()=>a.projects.repositoryResource(a.workspace.id));
  }finally{f.close();}
});

test('copying metadata into a new directory cannot retain the former repository identity',async()=>{
  const f=fixture();try{
    const a=f.state('state-a');assert.equal(typeof a.projects.repositoryResource,'function');
    const {repositoryIdentity}=await import('../server/repository-resource.ts'),common=join(f.source,'.git'),before=repositoryIdentity(common);
    const held=join(f.root,'held-metadata');renameSync(common,held);cpSync(held,common,{recursive:true});
    const after=repositoryIdentity(common);
    assert.equal(after.commonGitDir,before.commonGitDir);assert.notEqual(after.repositoryId,before.repositoryId);assert.notDeepEqual(after.directory,before.directory);
    assert.equal(a.projects.repositoryResource(a.workspace.id).repositoryId,after.repositoryId);
    assert.equal(existsSync(join(common,'.orbit-authority-v1')),false);
  }finally{f.close();}
});
