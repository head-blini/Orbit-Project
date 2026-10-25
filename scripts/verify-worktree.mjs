// Live test: uses the existing Codex ChatGPT login; never reads authentication files.
// All writes target a new disposable Git repository and a separate SQLite DB.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.ts';
import { Projects } from '../server/projects.ts';
import { Controller } from '../server/controller.ts';
import { codexFactory } from '../server/codex.ts';
import { createWorkspace } from '../server/workspace.ts';
import { terminal } from '../shared/types.ts';

const dir=mkdtempSync(join(tmpdir(),'orbit-live-'));const root=join(dir,'source');mkdirSync(root);
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,stdio:'pipe'}).trim();
git('init','-q','-b','main');writeFileSync(join(root,'greeting.ts'),'export const greeting = "before";\n');git('add','greeting.ts');git('-c','user.name=Orbit Test','-c','user.email=orbit@example.invalid','commit','-qm','fixture');
const base=git('rev-parse','HEAD');const store=new Store(join(dir,'test.sqlite'));const projects=new Projects(store,join(dir,'workspaces'),[root]);
const w=projects.create(projects.register(root).id);const controller=new Controller(store,createWorkspace(dir),(path,write)=>codexFactory(path,write)(),projects);
const result={connected:false,execution:'not_started',fileEdited:false,diffVerified:false,sourceUnchanged:false,denials:0};
try{
  await controller.selectWorkspace(w.id);await controller.connect();result.connected=true;
  const run=await controller.submit({requestId:crypto.randomUUID(),workspaceId:w.id,prompt:'Use the apply_patch tool to change greeting.ts from exactly `export const greeting = "before";` to exactly `export const greeting = "Orbit";` with a final newline. Do not run shell commands or use network. Modify only this file inside the current worktree. Then respond with ORBIT_EDIT_DONE only if the patch succeeded.'});
  const until=Date.now()+125000;while(!terminal(store.getRun(run.id).execution)&&Date.now()<until)await new Promise(r=>setTimeout(r,200));
  result.execution=store.getRun(run.id).execution;result.fileEdited=readFileSync(join(w.path,'greeting.ts'),'utf8')==='export const greeting = "Orbit";\n';
  result.diffVerified=projects.diff(w.id).files.some(f=>f.path==='greeting.ts'&&f.patch?.includes('+export const greeting = "Orbit";'));
}catch(e){result.issue=['POLICY_MISMATCH','MCP_ISOLATION_REQUIRED','CONNECTION_FAILED','SUBMIT_UNCERTAIN'].includes(e.message)?e.message:'LIVE_TEST_FAILED';}
finally{
  result.sourceUnchanged=git('rev-parse','HEAD')===base&&git('branch','--show-current')==='main'&&git('status','--porcelain')===''&&readFileSync(join(root,'greeting.ts'),'utf8')==='export const greeting = "before";\n';
  result.denials=store.eventsAfter(0).filter(e=>e.kind==='approval.denied').length;
  await controller.close();store.close();writeFileSync(join(dir,'summary.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({directory:dir,...result}));
  if(!result.fileEdited||!result.diffVerified||!result.sourceUnchanged)process.exitCode=1;
}
