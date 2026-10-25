import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, mkdirSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.ts';
import { Projects } from '../server/projects.ts';
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,stdio:'pipe'}).trim();
function fixture(){const dir=mkdtempSync(join(tmpdir(),'orbit-unit-'));const root=join(dir,'source');mkdirSync(root);git(root,'init','-q','-b','main');writeFileSync(join(root,'hello.ts'),'export const greeting = "before";\n');git(root,'add','hello.ts');git(root,'-c','user.name=Orbit Test','-c','user.email=orbit@example.invalid','commit','-qm','fixture');const store=new Store(':memory:');return {dir,root,store,projects:new Projects(store,join(dir,'managed'),[root])};}
test('registration is read-only and worktree writes require exact server allowlist',()=>{
  const {dir,root,store}=fixture();try{const p=new Projects(store,join(dir,'disabled'),[]);const registered=p.register(root);assert.equal(p.register(root).id,registered.id);assert.throws(()=>p.create(registered.id),/WRITES_DISABLED/);assert.equal(git(root,'branch','--show-current'),'main');assert.equal(git(root,'status','--porcelain'),'');}finally{store.close();}
});
test('worktree isolates changes from main; diff includes tracked and untracked changes and omits secrets',()=>{
  const {root,store,projects}=fixture();try{const project=projects.register(root);const w=projects.create(project.id);assert.match(w.branch,/^orbit\//);assert.equal(git(w.path,'branch','--show-current'),w.branch);writeFileSync(join(w.path,'hello.ts'),'export const greeting = "after";\n');writeFileSync(join(w.path,'new.txt'),'new text\n');writeFileSync(join(w.path,'.env'),'PASSWORD=must-not-display\n');const d=projects.diff(w.id);assert.equal(d.files.length,3);assert.match(d.files.find(f=>f.path==='hello.ts')!.patch!,/\+export const greeting = "after"/);assert.match(d.files.find(f=>f.path==='new.txt')!.patch!,/\+new text/);assert.equal(d.files.find(f=>f.path==='.env')!.patch,null);assert.ok(!JSON.stringify(d).includes('must-not-display'));assert.match(readFileSync(join(root,'hello.ts'),'utf8'),/before/);assert.equal(git(root,'status','--porcelain'),'');assert.equal(git(root,'branch','--show-current'),'main');}finally{store.close();}
});
test('reject traversal, option-like paths, nested repository paths and junctions',()=>{
  const {dir,root,store,projects}=fixture();try{for(const value of ['--upload-pack=bad',root+'\\..\\source',join(root,'.git'),dir])assert.throws(()=>projects.register(value));const link=join(dir,'link');symlinkSync(root,link,'junction');assert.throws(()=>projects.register(link));const w=projects.create(projects.register(root).id);symlinkSync(root,join(w.path,'escape'),'junction');assert.throws(()=>projects.validate(w.id),/LINK_REJECTED/);assert.ok(existsSync(join(w.path,'hello.ts')));}finally{store.close();}
});
test('unsafe checkout filters and tracked symlinks are rejected before worktree creation',()=>{
  const {root,store,projects}=fixture();try{git(root,'config','filter.fixture.smudge','some-external-command');assert.throws(()=>projects.register(root),/GIT_CONFIG_REJECTED/);git(root,'config','--remove-section','filter.fixture');const hash=git(root,'hash-object','-w','hello.ts');git(root,'update-index','--add','--cacheinfo',`120000,${hash},escape`);git(root,'-c','user.name=Orbit Test','-c','user.email=orbit@example.invalid','commit','-qm','unsafe-link');assert.throws(()=>projects.register(root),/UNSUPPORTED_TREE/);}finally{store.close();}
});
test('SQLite project/workspace records and changed files survive reopening',()=>{
  const {dir,root,store}=fixture();store.close();const db=join(dir,'test.sqlite');let s=new Store(db);let p=new Projects(s,join(dir,'durable'),[root]);const w=p.create(p.register(root).id);writeFileSync(join(w.path,'hello.ts'),'preserved\n');s.close();s=new Store(db);try{p=new Projects(s,join(dir,'durable'),[root]);assert.equal(p.workspaces()[0].id,w.id);assert.match(p.diff(w.id).files[0].patch!,/preserved/);}finally{s.close();}
});
test('new worktrees contain protected configuration directories before agent connection',()=>{
  const {store,projects,root}=fixture();try{const w=projects.create(projects.register(root).id);for(const name of ['.codex','.agents','.aws'])assert.ok(existsSync(join(w.path,name)),name);}finally{store.close();}
});
test('revoked allowlist blocks existing workspaces; diff never executes external helpers or option-like filenames',()=>{
  const {dir,root,store,projects}=fixture();try{const p=projects.register(root),w=projects.create(p.id);writeFileSync(join(w.path,'--output=elsewhere'),'plain\n');git(root,'config','diff.external','must-not-run');assert.ok(projects.diff(w.id).files.some(f=>f.path==='--output=elsewhere'&&f.patch?.includes('+plain')));const denied=new Projects(store,join(dir,'managed'),[]);assert.equal(denied.list()[0].writeEnabled,false);assert.throws(()=>denied.writable(w.id),/WRITES_DISABLED/);assert.ok(existsSync(w.path));}finally{store.close();}
});
test('literal tracked filename cannot select a sensitive sibling through Git pathspec globbing',()=>{
  const {root,store,projects}=fixture();try{writeFileSync(join(root,'[.]env'),'ordinary\n');writeFileSync(join(root,'.env'),'fixture-only-private-value\n');git(root,'add','--','.env','[.]env');git(root,'-c','user.name=Orbit Test','-c','user.email=orbit@example.invalid','commit','-qm','pathspec fixture');const w=projects.create(projects.register(root).id);writeFileSync(join(w.path,'[.]env'),'ordinary change\n');writeFileSync(join(w.path,'.env'),'different-fixture-private-value\n');const diff=projects.diff(w.id);assert.equal(diff.files.find(f=>f.path==='.env')!.patch,null);assert.match(diff.files.find(f=>f.path==='[.]env')!.patch!,/ordinary change/);assert.equal(JSON.stringify(diff).includes('fixture-private-value'),false);assert.equal(JSON.stringify(diff).includes('fixture-only-private-value'),false);}finally{store.close();}
});
test('Windows project-local git.exe cannot hijack registration before validation', {skip:process.platform!=='win32'},()=>{
  const {root,store,projects}=fixture();try{copyFileSync(process.execPath,join(root,'git.exe'));assert.equal(projects.register(root).path,root);}finally{store.close();}
});
test('missing promisor objects cannot execute a transport helper during read-only registration',()=>{
  const {dir,root,store}=fixture();try{const tree=git(root,'rev-parse','HEAD^{tree}');const marker=join(dir,'helper-started'),script=join(dir,'probe.cjs');writeFileSync(script,`require('fs').writeFileSync(${JSON.stringify(marker)},'started');process.exit(1);`);git(root,'config','remote.fixture.promisor','true');git(root,'config','remote.fixture.url','ext::'+process.execPath.replace(/ /g,'% ')+' '+script.replace(/ /g,'% '));git(root,'config','protocol.ext.allow','always');renameSync(join(root,'.git','objects',tree.slice(0,2),tree.slice(2)),join(dir,'held-tree-object'));const projects=new Projects(store,join(dir,'readonly'),[]);let error:unknown;try{projects.register(root);}catch(e){error=e;}assert.equal(existsSync(marker),false,'transport helper must not execute');assert.match((error as Error).message,/GIT_CONFIG_REJECTED/);}finally{store.close();}
});
