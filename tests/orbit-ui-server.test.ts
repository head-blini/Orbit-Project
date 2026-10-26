import test from 'node:test';
import assert from 'node:assert/strict';
import { fork,execFileSync,type ChildProcess } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { randomUUID,createHash } from 'node:crypto';
import { isolatedEnvironment } from '../scripts/lib/orbit-ui-e2e.ts';

test('E2E fixture reuses production HTTP, persists its private DB on restart and cannot launch AI',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-ui-server-test-'));
  const env=isolatedEnvironment(process.env),sandbox=join(root,'sandbox'),assets=join(root,'assets');
  mkdirSync(sandbox);mkdirSync(assets);writeFileSync(join(assets,'index.html'),'<!doctype html><title>fixture assets</title>');
  writeFileSync(join(root,'e2e-owned.json'),'{}');
  const project=join(sandbox,'orbit-ui-fixture');mkdirSync(project);
  const config=join(root,'empty.gitconfig');writeFileSync(config,'');Object.assign(env,{GIT_CONFIG_GLOBAL:config,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
  execFileSync('git',['init','--quiet',project],{env,windowsHide:true,stdio:'pipe'});
  writeFileSync(join(project,'README.md'),'temporary');
  writeFileSync(join(project,'check.test.mjs'),'import test from "node:test";import assert from "node:assert/strict";test("fixture source check",()=>assert.equal(2+2,4));\n');
  execFileSync('git',['add','README.md','check.test.mjs'],{cwd:project,env,windowsHide:true,stdio:'pipe'});
  execFileSync('git',['-c','user.name=Orbit E2E','-c','user.email=orbit@example.invalid','-c','commit.gpgSign=false','commit','-qm','fixture'],{cwd:project,env,windowsHide:true,stdio:'pipe'});
  let child:ChildProcess|undefined;
  const start=async(port=0)=>{
    child=fork(resolve('scripts/lib/orbit-ui-server.mjs'),[root,assets,String(port)],{env,cwd:sandbox,execArgv:[],silent:true,windowsHide:true});
    let errorOutput='';child.stderr!.on('data',chunk=>{errorOutput+=chunk.toString();});child.stdout!.resume();
    const current=child;
    return new Promise<string>((resolveReady,reject)=>{
      const timer=setTimeout(()=>reject(new Error('fixture startup timeout: '+errorOutput)),10000);
      current.once('message',(value:any)=>{clearTimeout(timer);assert.equal(value.kind,'ready');resolveReady(value.url);});
      current.once('error',error=>{clearTimeout(timer);reject(error);});
      current.once('exit',code=>{clearTimeout(timer);reject(new Error('fixture exited: '+code+' '+errorOutput));});
    });
  };
  const stop=async()=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');child.send({kind:'stop'});const [code]=await exit;assert.equal(code,0);child=undefined;};
  try{
    let url=await start();
    async function session(){const response=await fetch(url+'/api/session');const body=await response.json() as {csrfToken:string};return {cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:body.csrfToken};}
    let credentials=await session();
    const post=async(path:string,body:object)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:url,Cookie:credentials.cookie,'X-CSRF-Token':credentials.csrf},body:JSON.stringify(body)});
    const registered=await post('/api/projects',{path:project});assert.equal(registered.status,200);
    const saved=await registered.json() as {id:string};assert.ok(saved.id);
    const modelView=async()=>await (await fetch(url+'/api/model-hub?projectId='+saved.id,{headers:{Cookie:credentials.cookie}})).json() as any;
    const modelStats=()=>new Promise<any>((resolveStats,reject)=>{
      const timer=setTimeout(()=>{child!.off('message',message);reject(new Error('model fixture stats timeout'));},1500);
      const message=(value:any)=>{if(value?.kind==='model-hub-stats'){clearTimeout(timer);child!.off('message',message);resolveStats(value);}};
      child!.on('message',message);child!.send({kind:'model-hub-stats'});
    });
    let hub=await modelView();assert.equal(hub.providers.length,7);assert.equal(hub.destinations.length,1,'fixture explicitly configures one local model destination');
    const destination=hub.destinations[0];assert.equal(destination.id,'e2e-local-model');assert.equal(destination.providerId,'local');assert.equal(destination.locality,'loopback');
    assert.equal(destination.timeoutMs,5000);assert.equal(destination.maxOutputTokens,8);assert.equal(destination.credential,'not_required');
    assert.deepEqual(destination.configuredModels,['fixture-model']);assert.equal(destination.catalog.status,'not_queried');
    let stats=await modelStats();assert.equal(stats.counts.total,0,'initial GET never contacts the model fixture');const modelPort=stats.port;
    const consent={projectId:saved.id,expectedConfigDigest:destination.configDigest,confirmed:true};
    const catalog=await post('/api/model-hub/destinations/e2e-local-model/models',consent);assert.equal(catalog.status,200);assert.deepEqual((await catalog.json() as any).models,['fixture-model']);
    const modelInput={...consent,requestId:randomUUID(),destinationId:destination.id,model:'fixture-model',text:'ORBIT_MODEL_HUB_NORMAL'};
    const started=await post('/api/model-hub/requests',modelInput);assert.equal(started.status,200);const completedId=(await started.json() as any).id;
    const waitModel=async(id:string,execution:string)=>{
      const deadline=Date.now()+3000;let result:any;
      do{result=(await modelView()).requests.find((record:any)=>record.id===id);if(result?.execution===execution)return result;await new Promise(resolveWait=>setTimeout(resolveWait,25));}while(Date.now()<deadline);
      assert.equal(result?.execution,execution);return result;
    };
    const completed=await waitModel(completedId,'completed');assert.equal(completed.response,'ORBIT_MODEL_HUB_REPLY');assert.equal(completed.usage.source,'provider');assert.equal(completed.usage.totalTokens,5);assert.equal(completed.costUsd,null);
    stats=await modelStats();assert.equal(stats.counts.total,2);assert.equal(stats.counts.models,1);assert.equal(stats.counts.chats,1);
    const privateInput=await post('/api/model-hub/requests',{...modelInput,requestId:randomUUID(),text:'orbit-model-fixture@example.invalid'});assert.equal(privateInput.status,403);
    assert.equal((await modelStats()).counts.total,2,'blocked private text never reaches mock HTTP');
    const hang=await post('/api/model-hub/requests',{...modelInput,requestId:randomUUID(),text:'ORBIT_MODEL_HUB_HANG'});assert.equal(hang.status,200);const interruptedId=(await hang.json() as any).id;
    const hangDeadline=Date.now()+2000;do{stats=await modelStats();if(stats.counts.activeHangs===1)break;await new Promise(resolveWait=>setTimeout(resolveWait,25));}while(Date.now()<hangDeadline);
    assert.equal(stats.counts.activeHangs,1);assert.equal((await post('/api/model-hub/requests/'+interruptedId+'/interrupt',{projectId:saved.id})).status,200);
    await waitModel(interruptedId,'interrupted');
    const abortDeadline=Date.now()+1000;do{stats=await modelStats();if(stats.counts.activeHangs===0)break;await new Promise(resolveWait=>setTimeout(resolveWait,25));}while(Date.now()<abortDeadline);
    assert.equal(stats.counts.activeHangs,0);assert.equal(stats.counts.abortedHangs,1);assert.equal(stats.counts.boundedTimeouts,0);
    const connect=await post('/api/connect',{});assert.equal(connect.status,503);assert.deepEqual(await connect.json(),{error:'CONNECTION_FAILED'});
    const state=await (await fetch(url+'/api/state',{headers:{Cookie:credentials.cookie}})).json() as any;
    assert.equal(state.runs.length,0);assert.notEqual(state.provider,'ready');
    const created=await post('/api/workspaces',{projectId:saved.id});assert.equal(created.status,200);
    const workspace=await created.json() as {id:string;path:string};
    assert.equal((await post('/api/workspaces/select',{workspaceId:workspace.id})).status,200);
    const planResponse=await post('/api/projects/'+saved.id+'/plans',{requestId:randomUUID(),input:{format:'markdown',source:'manual',text:'# Fixture handoff\n\n## Goal\nReview fixture evidence.\n\n## Requirements\n### REQ-01\nPreserve fixture state.\n#### Acceptance criteria\n- Keep the source intact.\n\n## Constraints\n- No external requests.\n\n## Open questions\n'}});assert.equal(planResponse.status,200);
    const plan=await planResponse.json() as any;assert.equal((await post('/api/projects/'+saved.id+'/plans/'+plan.id+'/approve',{expectedRevision:plan.revision})).status,200);
    const tasksResponse=await post('/api/projects/'+saved.id+'/plans/'+plan.id+'/task-drafts',{});assert.equal(tasksResponse.status,200);const task=(await tasksResponse.json() as any[])[0];assert.ok(task);
    const seed=await new Promise<any>((resolveSeed,reject)=>{
      const timer=setTimeout(()=>reject(new Error('synthetic seed timeout')),1500);
      child!.once('message',message=>{clearTimeout(timer);resolveSeed(message);});child!.send({kind:'seed-terminal-run'});
    });
    assert.equal(seed.kind,'synthetic-run-ready');assert.equal(seed.workspaceId,workspace.id);assert.ok(seed.runId);
    assert.equal(seed.taskId,task.id);assert.equal(seed.planningVersionId,plan.id);
    const seededState=await (await fetch(url+'/api/state',{headers:{Cookie:credentials.cookie}})).json() as any;
    const seededRun=seededState.runs.find((run:any)=>run.id===seed.runId);assert.equal(seededRun.taskId,task.id);assert.equal(seededRun.planningVersionId,plan.id);assert.deepEqual(seededRun.requirementLabels,['REQ-01']);
    const readView=async()=>await (await fetch(url+'/api/workspaces/'+workspace.id+'/verification?runId='+seed.runId,{headers:{Cookie:credentials.cookie}})).json() as any;
    let view=await readView();assert.equal(view.commands.length,1);assert.equal(view.commands[0].id,'e2e-node-check');assert.deepEqual(view.commands[0].args,['--test','check.test.mjs']);
    assert.equal(view.canApprove,false);
    const checkResponse=await post('/api/workspaces/'+workspace.id+'/checks',{requestId:randomUUID(),runId:seed.runId,commandId:view.commands[0].id,expectedSourceDigest:view.sourceDigest,expectedConfigDigest:view.commands[0].configDigest});assert.equal(checkResponse.status,200);
    const deadline=Date.now()+10000;
    do{view=await readView();if(view.checks[0]?.execution==='completed')break;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<deadline);
    assert.equal(view.checks[0]?.verdict,'passed');assert.equal(view.checks[0]?.exitCode,0);assert.equal(view.canApprove,true);
    assert.equal((await post('/api/workspaces/'+workspace.id+'/review-approval',{requestId:randomUUID(),runId:seed.runId,expectedSourceDigest:view.sourceDigest,expectedCheckSetDigest:view.checkSetDigest})).status,200);
    view=await readView();assert.equal(view.approvalCurrent,true);const checkId=view.checks[0].id,approvalId=view.approval.id;
    writeFileSync(join(workspace.path,'README.md'),'temporary\nsource changed after approval\n');
    view=await readView();assert.equal(view.approvalCurrent,false);assert.equal(view.canApprove,false);assert.notEqual(view.checks[0].sourceDigest,view.sourceDigest);
    await stop();
    await assert.rejects(fetch('http://127.0.0.1:'+modelPort+'/v1/models',{signal:AbortSignal.timeout(1000)}),TypeError,'owned model HTTP fixture is stopped with its parent');
    url=await start(Number(new URL(url).port));credentials=await session();
    const after=await (await fetch(url+'/api/state',{headers:{Cookie:credentials.cookie}})).json() as any;
    assert.equal(after.projects.length,1);assert.equal(after.projects[0].id,saved.id);assert.equal(after.runs.length,1);assert.match(after.runs[0].prompt,/Synthetic/);
    view=await readView();assert.equal(view.checks[0].id,checkId);assert.equal(view.approval.id,approvalId);assert.equal(view.approvalCurrent,false);assert.equal(view.canApprove,false);
    hub=await modelView();assert.equal(hub.destinations[0].configDigest,destination.configDigest);assert.equal(hub.requests.find((record:any)=>record.id===completedId).response,'ORBIT_MODEL_HUB_REPLY');assert.equal(hub.requests.find((record:any)=>record.id===interruptedId).execution,'interrupted');
    stats=await modelStats();assert.equal(stats.port,modelPort);assert.equal(stats.counts.total,0,'restoring history does not resend model requests');
    assert.equal(readFileSync(join(project,'README.md'),'utf8'),'temporary');
    await stop();
    await assert.rejects(fetch('http://127.0.0.1:'+modelPort+'/v1/models',{signal:AbortSignal.timeout(1000)}),TypeError,'restarted owned model fixture is also stopped');
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}
    // Only the uniquely created test root, never any application data directory.
    assert.ok(root.startsWith(join(tmpdir(),'orbit-ui-server-test-')));rmSync(root,{recursive:true,force:true});
  }
});

test('E2E third merge fixture requires an exact CLI grant and exposes read-only source and primary evidence',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-ui-server-merge-test-')),sandbox=join(root,'sandbox'),assets=join(root,'assets');mkdirSync(sandbox);mkdirSync(assets);
  writeFileSync(join(root,'e2e-owned.json'),'{}');writeFileSync(join(assets,'index.html'),'<!doctype html><title>merge fixture</title>');
  const first=join(sandbox,'orbit-ui-fixture'),merge=join(sandbox,'orbit-ui-merge'),env=isolatedEnvironment(process.env),config=join(root,'empty.gitconfig');writeFileSync(config,'');
  Object.assign(env,{GIT_CONFIG_GLOBAL:config,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
  for(const path of [first,merge]){
    mkdirSync(path);execFileSync('git',['init','-q','-b','main',path],{env,windowsHide:true,stdio:'pipe'});writeFileSync(join(path,'README.md'),'merge fixture base\n');
    writeFileSync(join(path,'check.test.mjs'),'import test from "node:test";import assert from "node:assert/strict";test("merge fixture check",()=>assert.equal(2+2,4));\n');
    execFileSync('git',['add','README.md','check.test.mjs'],{cwd:path,env,windowsHide:true,stdio:'pipe'});execFileSync('git',['-c','user.name=Orbit E2E','-c','user.email=orbit@example.invalid','-c','commit.gpgSign=false','commit','-qm','owned merge fixture'],{cwd:path,env,windowsHide:true,stdio:'pipe'});
  }
  let child:ChildProcess|undefined;
  const start=async(grant:boolean)=>{
    child=fork(resolve('scripts/lib/orbit-ui-server.mjs'),[root,assets,'0',...(grant?[merge]:[])],{env,cwd:sandbox,execArgv:[],silent:true,windowsHide:true});child.stdout!.resume();child.stderr!.resume();
    const current=child;return new Promise<string>((resolveReady,reject)=>{const timer=setTimeout(()=>reject(new Error('merge fixture startup timeout')),10000);current.once('message',(value:any)=>{clearTimeout(timer);assert.equal(value.kind,'ready');resolveReady(value.url);});current.once('error',reject);current.once('exit',code=>{clearTimeout(timer);reject(new Error('merge fixture exited '+code));});});
  };
  const stop=async()=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');child.send({kind:'stop'});const [code]=await exit;assert.equal(code,0);child=undefined;};
  const ipc=(kind:string)=>new Promise<any>((resolveMessage,reject)=>{const expected=kind==='seed-terminal-run'?'synthetic-run-ready':kind,current=child!,timer=setTimeout(()=>{current.off('message',message);reject(new Error('merge fixture IPC timeout: '+kind));},15000);const message=(value:any)=>{if(value?.kind===expected||value?.kind==='fixture-error'){clearTimeout(timer);current.off('message',message);resolveMessage(value);}};current.on('message',message);current.send({kind});});
  try{
    let url=await start(true),sessionResponse=await fetch(url+'/api/session'),session=await sessionResponse.json() as any,cookie=sessionResponse.headers.get('set-cookie')!.split(';')[0];
    const post=(path:string,body:object)=>fetch(url+path,{method:'POST',headers:{Origin:url,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});
    const registered=await post('/api/projects',{path:merge});assert.equal(registered.status,200);const project=await registered.json() as any;assert.equal(project.writeEnabled,true,'exact owned CLI path grants the third fixture only');
    const created=await post('/api/workspaces',{projectId:project.id});assert.equal(created.status,200);const workspace=await created.json() as any;assert.equal((await post('/api/workspaces/select',{workspaceId:workspace.id})).status,200);
    const seed=await ipc('seed-terminal-run');assert.equal(seed.kind,'synthetic-run-ready');assert.equal(seed.workspaceId,workspace.id);assert.equal(seed.taskId,undefined,'plain terminal run is valid for a merge fixture without tasks');
    const before=await ipc('merge-fixture-evidence');assert.equal(before.kind,'merge-fixture-evidence');assert.equal(before.projectId,project.id);assert.equal(before.source.head,before.source.baseSha);assert.equal(before.primary.head,before.source.baseSha);assert.equal(before.primary.branch,'main');assert.equal(before.source.sourceDigest,before.source.snapshotDigest);
    writeFileSync(join(workspace.path,'merge-proof.txt'),'ORBIT_E2E_MERGE_BYTES\n');
    const changed=await ipc('merge-fixture-evidence');assert.equal(changed.source.head,before.source.head);assert.equal(changed.source.indexSha256,before.source.indexSha256);assert.notEqual(changed.source.sourceDigest,before.source.sourceDigest);assert.deepEqual(changed.primary,before.primary);assert.equal(changed.primary.files['merge-proof.txt'].present,false);assert.equal(changed.source.files['merge-proof.txt'].present,true);
    const verification=await (await fetch(url+'/api/workspaces/'+workspace.id+'/verification?runId='+seed.runId,{headers:{Cookie:cookie}})).json() as any;assert.equal(verification.commands.length,1);assert.equal(verification.commands[0].id,'e2e-merge-node-check');
    await stop();url=await start(false);sessionResponse=await fetch(url+'/api/session');session=await sessionResponse.json();cookie=sessionResponse.headers.get('set-cookie')!.split(';')[0];
    const snapshot=await (await fetch(url+'/api/state',{headers:{Cookie:cookie}})).json() as any;assert.equal(snapshot.projects.find((value:any)=>value.id===project.id).writeEnabled,false,'the third fixture grant never persists as production authority');
    assert.equal((await post('/api/workspaces',{projectId:project.id})).status,403);assert.equal(readFileSync(join(merge,'README.md'),'utf8'),'merge fixture base\n');
    await stop();
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}
    assert.ok(root.startsWith(join(tmpdir(),'orbit-ui-server-merge-test-')));rmSync(root,{recursive:true,force:true});
  }
});

test('E2E fourth workflow fixture requires its own exact grant, fixed scoped commands, and bounded read-only evidence',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-ui-server-workflow-test-')),sandbox=join(root,'sandbox'),assets=join(root,'assets');mkdirSync(sandbox);mkdirSync(assets);
  writeFileSync(join(root,'e2e-owned.json'),'{}');writeFileSync(join(assets,'index.html'),'<!doctype html><title>workflow fixture</title>');
  const first=join(sandbox,'orbit-ui-fixture'),other=join(sandbox,'orbit-ui-other'),merge=join(sandbox,'orbit-ui-merge'),workflow=join(sandbox,'orbit-ui-workflow');
  const env=isolatedEnvironment(process.env),config=join(root,'empty.gitconfig');writeFileSync(config,'');Object.assign(env,{GIT_CONFIG_GLOBAL:config,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
  for(const path of [first,other,merge,workflow]){
    mkdirSync(path);execFileSync('git',['init','-q','-b','main',path],{env,windowsHide:true,stdio:'pipe'});writeFileSync(join(path,'README.md'),'owned workflow fixture\n');
    writeFileSync(join(path,'check.test.mjs'),'import test from "node:test";test("fixture",()=>{});\n');
    if(path===workflow){writeFileSync(join(path,'.gitignore'),'.workflow-*.tmp\n');writeFileSync(join(path,'workflow-check.mjs'),'// Synthetic owned fixture. This contract test never runs a workflow command.\n');}
    execFileSync('git',['add','--','.'],{cwd:path,env,windowsHide:true,stdio:'pipe'});execFileSync('git',['-c','user.name=Orbit E2E','-c','user.email=orbit@example.invalid','-c','commit.gpgSign=false','commit','-qm','owned workflow fixture'],{cwd:path,env,windowsHide:true,stdio:'pipe'});
  }
  let child:ChildProcess|undefined;
  const start=async(grants:string[]=[])=>{
    child=fork(resolve('scripts/lib/orbit-ui-server.mjs'),[root,assets,'0',...grants],{env,cwd:sandbox,execArgv:[],silent:true,windowsHide:true});child.stdout!.resume();let errorOutput='';child.stderr!.on('data',chunk=>{errorOutput=(errorOutput+chunk.toString()).slice(-5000);});
    const current=child;return new Promise<string>((resolveReady,reject)=>{const timer=setTimeout(()=>reject(new Error('workflow fixture startup timeout')),10000);current.once('message',(value:any)=>{clearTimeout(timer);assert.equal(value.kind,'ready');resolveReady(value.url);});current.once('error',error=>{clearTimeout(timer);reject(error);});current.once('exit',code=>{clearTimeout(timer);reject(new Error('workflow fixture exited '+code+' '+errorOutput));});});
  };
  const stop=async()=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');child.send({kind:'stop'});const [code]=await exit;assert.equal(code,0);child=undefined;};
  const ipc=()=>new Promise<any>((resolveMessage,reject)=>{const current=child!,timer=setTimeout(()=>{current.off('message',message);reject(new Error('workflow fixture evidence timeout'));},15000);const message=(value:any)=>{if(value?.kind==='workflow-fixture-evidence'||value?.kind==='fixture-error'){clearTimeout(timer);current.off('message',message);resolveMessage(value);}};current.on('message',message);current.send({kind:'workflow-fixture-evidence'});});
  try{
    let url=await start(),sessionResponse=await fetch(url+'/api/session'),session=await sessionResponse.json() as any,cookie=sessionResponse.headers.get('set-cookie')!.split(';')[0];
    const post=(path:string,body:object)=>fetch(url+path,{method:'POST',headers:{Origin:url,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});
    const ids:string[]=[];for(const path of [first,other,merge,workflow]){const response=await post('/api/projects',{path});assert.equal(response.status,200);const value=await response.json() as any;ids.push(value.id);assert.equal(value.writeEnabled,path===first);}
    const commands=async(id:string)=>(await (await fetch(url+'/api/projects/'+id+'/workflows',{headers:{Cookie:cookie}})).json() as any).commands;
    assert.deepEqual((await commands(ids[0])).map((value:any)=>value.id),['e2e-node-check']);for(const id of ids.slice(1))assert.deepEqual(await commands(id),[]);
    assert.equal((await post('/api/workspaces',{projectId:ids[3]})).status,403);assert.deepEqual(await ipc(),{kind:'fixture-error',code:'WORKFLOW_FIXTURE_EVIDENCE_FAILED'});
    await stop();url=await start([merge,workflow]);sessionResponse=await fetch(url+'/api/session');session=await sessionResponse.json();cookie=sessionResponse.headers.get('set-cookie')!.split(';')[0];
    const state=await (await fetch(url+'/api/state',{headers:{Cookie:cookie}})).json() as any;
    assert.deepEqual(ids.map(id=>state.projects.find((value:any)=>value.id===id).writeEnabled),[true,false,true,true]);
    assert.deepEqual((await commands(ids[0])).map((value:any)=>({id:value.id,args:value.args,timeoutMs:value.timeoutMs})),[{id:'e2e-node-check',args:['--test','check.test.mjs'],timeoutMs:10000}]);
    assert.deepEqual(await commands(ids[1]),[]);assert.deepEqual((await commands(ids[2])).map((value:any)=>({id:value.id,args:value.args,timeoutMs:value.timeoutMs})),[{id:'e2e-merge-node-check',args:['--test','check.test.mjs'],timeoutMs:10000}]);
    const configured=await commands(ids[3]);assert.deepEqual(configured.map((value:any)=>({id:value.id,executable:value.executable,args:value.args,timeoutMs:value.timeoutMs})),['first','second','fail','hang'].map(mode=>({id:'e2e-workflow-'+mode,executable:process.execPath,args:['workflow-check.mjs',mode],timeoutMs:10000})));
    const created=await post('/api/workspaces',{projectId:ids[3]});assert.equal(created.status,200);const workspace=await created.json() as any;assert.equal((await post('/api/workspaces/select',{workspaceId:workspace.id})).status,200);
    const before=await ipc();assert.equal(before.kind,'workflow-fixture-evidence');assert.equal(before.projectId,ids[3]);assert.equal(before.workspaceId,workspace.id);assert.equal(before.actualAiExecuted,false);
    assert.equal(before.primary.head,before.source.head);assert.equal(before.source.head,before.source.baseSha);assert.match(before.source.sourceDigest,/^[a-f0-9]{64}$/);
    const markers={'.workflow-order.tmp':'firstsecond','.workflow-fail.tmp':'failure','.workflow-hang.tmp':'started'};
    for(const name of Object.keys(markers))assert.deepEqual(before.source.markers[name],{present:false});
    for(const [name,bytes] of Object.entries(markers))writeFileSync(join(workspace.path,name),bytes);
    const after=await ipc();assert.deepEqual(after.primary,before.primary);assert.equal(after.source.head,before.source.head);assert.equal(after.source.indexSha256,before.source.indexSha256);assert.equal(after.source.sourceDigest,before.source.sourceDigest);
    for(const [name,bytes] of Object.entries(markers))assert.deepEqual(after.source.markers[name],{present:true,bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')});
    assert.equal(JSON.stringify(after).includes('Synthetic owned fixture'),false);assert.equal(JSON.stringify(after).includes('firstsecond'),false);
    writeFileSync(join(workspace.path,'.workflow-order.tmp'),Buffer.alloc(4097));assert.deepEqual(await ipc(),{kind:'fixture-error',code:'WORKFLOW_FIXTURE_EVIDENCE_FAILED'});writeFileSync(join(workspace.path,'.workflow-order.tmp'),markers['.workflow-order.tmp']);
    const firstWorkspace=await post('/api/workspaces',{projectId:ids[0]});assert.equal(firstWorkspace.status,200);assert.equal((await post('/api/workspaces/select',{workspaceId:(await firstWorkspace.json() as any).id})).status,200);
    assert.deepEqual(await ipc(),{kind:'fixture-error',code:'WORKFLOW_FIXTURE_EVIDENCE_FAILED'});
    await stop();
    url=await start();sessionResponse=await fetch(url+'/api/session');session=await sessionResponse.json();cookie=sessionResponse.headers.get('set-cookie')!.split(';')[0];
    const restarted=await (await fetch(url+'/api/state',{headers:{Cookie:cookie}})).json() as any;assert.equal(restarted.projects.find((value:any)=>value.id===ids[3]).writeEnabled,false,'fourth-fixture grant never persists as production authority');
    assert.deepEqual(await commands(ids[3]),[]);assert.equal((await post('/api/workspaces',{projectId:ids[3]})).status,403);await stop();
    for(const grants of [[other,workflow],[merge,other],[merge,workflow+'-sibling'],[merge,workflow,'extra']])await assert.rejects(start(grants),/workflow fixture exited 1/);
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}
    assert.ok(root.startsWith(join(tmpdir(),'orbit-ui-server-workflow-test-')));rmSync(root,{recursive:true,force:true});
  }
});

test('E2E missing Bedrock CLI destination requires the explicit fourth-project grant and never creates a CLI or model request',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-ui-server-bedrock-test-')),sandbox=join(root,'sandbox'),assets=join(root,'assets');mkdirSync(sandbox);mkdirSync(assets);
  writeFileSync(join(root,'e2e-owned.json'),'{}');writeFileSync(join(assets,'index.html'),'<!doctype html><title>missing Bedrock fixture</title>');
  const first=join(sandbox,'orbit-ui-fixture'),other=join(sandbox,'orbit-ui-other'),merge=join(sandbox,'orbit-ui-merge'),workflow=join(sandbox,'orbit-ui-workflow'),missingCli=join(root,'missing-bedrock','aws.exe');
  const env=isolatedEnvironment(process.env),config=join(root,'empty.gitconfig');writeFileSync(config,'');Object.assign(env,{GIT_CONFIG_GLOBAL:config,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
  for(const path of [first,other,merge,workflow]){
    mkdirSync(path);execFileSync('git',['init','-q','-b','main',path],{env,windowsHide:true,stdio:'pipe'});writeFileSync(join(path,'README.md'),'owned missing CLI fixture\n');
    execFileSync('git',['add','--','README.md'],{cwd:path,env,windowsHide:true,stdio:'pipe'});execFileSync('git',['-c','user.name=Orbit E2E','-c','user.email=orbit@example.invalid','-c','commit.gpgSign=false','commit','-qm','owned missing CLI fixture'],{cwd:path,env,windowsHide:true,stdio:'pipe'});
  }
  let child:ChildProcess|undefined;
  const start=async(grant=false)=>{
    child=fork(resolve('scripts/lib/orbit-ui-server.mjs'),[root,assets,'0',...(grant?[merge,workflow]:[])],{env,cwd:sandbox,execArgv:[],silent:true,windowsHide:true});child.stdout!.resume();let diagnostic='';child.stderr!.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-1500);});
    const current=child;return new Promise<string>((resolveReady,reject)=>{const timer=setTimeout(()=>reject(new Error('Bedrock fixture startup timeout')),10000);current.once('message',(value:any)=>{clearTimeout(timer);assert.equal(value.kind,'ready');resolveReady(value.url);});current.once('error',error=>{clearTimeout(timer);reject(error);});current.once('exit',code=>{clearTimeout(timer);reject(new Error('Bedrock fixture exited '+code+' '+diagnostic));});});
  };
  const stop=async()=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');child.send({kind:'stop'});const [code]=await exit;assert.equal(code,0);child=undefined;};
  const stats=()=>new Promise<any>((resolveStats,reject)=>{const current=child!,timer=setTimeout(()=>{current.off('message',message);reject(new Error('Bedrock fixture mock stats timeout'));},1500);const message=(value:any)=>{if(value?.kind==='model-hub-stats'){clearTimeout(timer);current.off('message',message);resolveStats(value);}};current.on('message',message);current.send({kind:'model-hub-stats'});});
  try{
    let url=await start(),sessionResponse=await fetch(url+'/api/session'),session=await sessionResponse.json() as any,cookie=sessionResponse.headers.get('set-cookie')!.split(';')[0];
    const post=(path:string,body:object)=>fetch(url+path,{method:'POST',headers:{Origin:url,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});
    const hub=async(id:string)=>await (await fetch(url+'/api/model-hub?projectId='+id,{headers:{Cookie:cookie}})).json() as any;
    const ids:string[]=[];for(const path of [first,other,merge,workflow]){const response=await post('/api/projects',{path});assert.equal(response.status,200);const value=await response.json() as any;ids.push(value.id);assert.equal(value.writeEnabled,path===first);}
    for(const id of ids){const view=await hub(id);assert.equal(view.destinations.length,1);assert.equal(view.destinations[0].id,'e2e-local-model');assert.equal(view.requests.length,0);}
    assert.equal(existsSync(missingCli),false);assert.equal((await stats()).counts.total,0);await stop();
    url=await start(true);sessionResponse=await fetch(url+'/api/session');session=await sessionResponse.json();cookie=sessionResponse.headers.get('set-cookie')!.split(';')[0];
    for(const id of ids.slice(0,3)){const view=await hub(id);assert.equal(view.destinations.length,2);assert.equal(view.destinations.find((value:any)=>value.id==='bedrock-missing-cli').status,'project_blocked');}
    const view=await hub(ids[3]),bedrock=view.destinations.find((value:any)=>value.id==='bedrock-missing-cli');assert.ok(bedrock,'only the explicitly granted workflow fixture adds the Bedrock destination');
    assert.deepEqual({id:bedrock.id,label:bedrock.label,providerId:bedrock.providerId,endpoint:bedrock.endpoint,locality:bedrock.locality,status:bedrock.status,models:bedrock.configuredModels,credential:bedrock.credential,timeoutMs:bedrock.timeoutMs,maxOutputTokens:bedrock.maxOutputTokens,transport:bedrock.transport},
      {id:'bedrock-missing-cli',label:'Bedrock CLI missing fixture',providerId:'bedrock',endpoint:'https://bedrock-runtime.us-east-1.amazonaws.com',locality:'external',status:'configured',models:['amazon.nova-micro-v1:0'],credential:'reference_configured',timeoutMs:2000,maxOutputTokens:8,transport:'aws_cli_converse'});
    assert.equal(bedrock.catalog.status,'not_queried');assert.equal(view.destinations.find((value:any)=>value.id==='e2e-local-model').status,'project_blocked');
    assert.equal(JSON.stringify(view).includes(missingCli),false);assert.equal(JSON.stringify(view).includes('ORBIT_BEDROCK_ACCESS_KEY'),false);assert.equal(JSON.stringify(view).includes('ORBIT_BEDROCK_SECRET_KEY'),false);assert.equal((await stats()).counts.total,0,'GET does not contact the existing HTTP model fixture');
    const consent={projectId:ids[3],expectedConfigDigest:bedrock.configDigest,confirmed:true};
    assert.equal((await post('/api/model-hub/destinations/bedrock-missing-cli/models',{...consent,confirmed:false})).status,403);
    const diagnostic=await post('/api/model-hub/destinations/bedrock-missing-cli/models',consent);assert.equal(diagnostic.status,200);const catalog=await diagnostic.json() as any;
    assert.equal(catalog.status,'failed');assert.equal(catalog.issue,'BEDROCK_CLI_NOT_FOUND');assert.deepEqual(catalog.models,[]);
    const denied=await post('/api/model-hub/requests',{...consent,requestId:randomUUID(),destinationId:bedrock.id,model:'amazon.nova-micro-v1:0',text:'ORBIT_BEDROCK_MISSING_CLI_FIXTURE'});assert.equal(denied.status,409);assert.deepEqual(await denied.json(),{error:'MODEL_CATALOG_REQUIRED'});
    const after=await hub(ids[3]);assert.equal(after.requests.length,0);assert.equal(after.destinations.find((value:any)=>value.id===bedrock.id).catalog.issue,'BEDROCK_CLI_NOT_FOUND');
    assert.equal((await post('/api/model-hub/destinations/bedrock-missing-cli/models',{...consent,projectId:ids[0]})).status,403);assert.equal((await stats()).counts.total,0);assert.equal(existsSync(missingCli),false);assert.equal(existsSync(join(root,'missing-bedrock')),false);
    for(const path of [first,other,merge,workflow])assert.equal(readFileSync(join(path,'README.md'),'utf8'),'owned missing CLI fixture\n');
    await stop();url=await start();sessionResponse=await fetch(url+'/api/session');session=await sessionResponse.json();cookie=sessionResponse.headers.get('set-cookie')!.split(';')[0];
    const ungranted=await hub(ids[3]);assert.equal(ungranted.destinations.length,1);assert.equal(ungranted.destinations.some((value:any)=>value.id==='bedrock-missing-cli'),false);assert.equal((await stats()).counts.total,0);await stop();
  }finally{
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}
    assert.ok(root.startsWith(join(tmpdir(),'orbit-ui-server-bedrock-test-')));rmSync(root,{recursive:true,force:true});
  }
});

test('E2E mock native review requires a sixth exact grant, rejects write/foreign sessions and runs only the product readonly review protocol',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-ui-server-review-test-')),sandbox=join(root,'sandbox'),assets=join(root,'assets');mkdirSync(sandbox);mkdirSync(assets);
  writeFileSync(join(root,'e2e-owned.json'),'{}');writeFileSync(join(assets,'index.html'),'<!doctype html><title>mock review fixture</title>');
  const first=join(sandbox,'orbit-ui-fixture'),merge=join(sandbox,'orbit-ui-merge'),workflow=join(sandbox,'orbit-ui-workflow');
  const env=isolatedEnvironment(process.env),config=join(root,'empty.gitconfig');writeFileSync(config,'');Object.assign(env,{GIT_CONFIG_GLOBAL:config,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
  for(const path of [first,merge,workflow]){mkdirSync(path);execFileSync('git',['init','-q','-b','main',path],{env,windowsHide:true,stdio:'pipe'});writeFileSync(join(path,'README.md'),'owned review fixture\n');execFileSync('git',['add','README.md'],{cwd:path,env,windowsHide:true,stdio:'pipe'});execFileSync('git',['-c','user.name=Orbit E2E','-c','user.email=orbit@example.invalid','-c','commit.gpgSign=false','commit','-qm','owned review fixture'],{cwd:path,env,windowsHide:true,stdio:'pipe'});}
  let child:ChildProcess|undefined,url='',cookie='',csrf='';
  const start=async(grants:string[])=>{child=fork(resolve('scripts/lib/orbit-ui-server.mjs'),[root,assets,'0',...grants],{env,cwd:sandbox,execArgv:[],silent:true,windowsHide:true});child.stdout!.resume();let diagnostic='';child.stderr!.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-1500);});const current=child;
    url=await new Promise<string>((ready,reject)=>{const timer=setTimeout(()=>reject(new Error('review fixture startup timeout')),10000);current.once('message',(message:any)=>{clearTimeout(timer);assert.equal(message.kind,'ready');ready(message.url);});current.once('error',error=>{clearTimeout(timer);reject(error);});current.once('exit',code=>{clearTimeout(timer);reject(new Error('review fixture exited '+code+' '+diagnostic));});});
    const response=await fetch(url+'/api/session'),session=await response.json() as any;cookie=response.headers.get('set-cookie')!.split(';')[0];csrf=session.csrfToken;};
  const stop=async()=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.send({kind:'stop'});assert.equal((await exited)[0],0);child=undefined;};
  const post=(path:string,body:object)=>fetch(url+path,{method:'POST',headers:{Origin:url,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
  const get=async(path:string)=>{const response=await fetch(url+path,{headers:{Cookie:cookie}});assert.equal(response.status,200);return response.json() as Promise<any>;};
  const ipc=(body:object)=>new Promise<any>((ready,reject)=>{const current=child!,timer=setTimeout(()=>{current.off('message',message);reject(new Error('review fixture IPC timeout'));},10000);const message=(value:any)=>{if(value?.kind==='review-fixture'||value?.kind==='fixture-error'){clearTimeout(timer);current.off('message',message);ready(value);}};current.on('message',message);current.send(body);});
  const wait=async(workspaceId:string,id:string,status:string)=>{const deadline=Date.now()+5000;while(Date.now()<deadline){const record=(await get('/api/workspaces/'+workspaceId+'/reviews')).records.find((value:any)=>value.id===id);if(record?.execution===status)return record;await new Promise(resolveWait=>setTimeout(resolveWait,30));}throw Error('review fixture state timeout');};
  const begin=async(workspaceId:string)=>{const preview=await get('/api/workspaces/'+workspaceId+'/reviews/preview');const response=await post('/api/reviews/start',{requestId:randomUUID(),workspaceId,runId:null,expectedPreviewDigest:preview.previewDigest,confirmed:true});assert.equal(response.status,200);return response.json() as Promise<any>;};
  try{
    await start([merge,workflow,workflow]);
    const ids:string[]=[];for(const path of [first,workflow]){const response=await post('/api/projects',{path});assert.equal(response.status,200);ids.push((await response.json() as any).id);}
    const create=async(projectId:string)=>{const response=await post('/api/workspaces',{projectId});assert.equal(response.status,200);const workspace=await response.json() as any;assert.equal((await post('/api/workspaces/select',{workspaceId:workspace.id})).status,200);writeFileSync(join(workspace.path,'README.md'),'owned review fixture\nORBIT_E2E_REVIEW_INPUT\n');return workspace;};
    const fourth=await create(ids[1]),before=readFileSync(join(fourth.path,'README.md'));
    let stats=await ipc({kind:'review-fixture'});assert.equal(stats.actualAiExecuted,false);assert.equal(stats.counts.reviewStarts,0);
    assert.deepEqual(await ipc({kind:'review-fixture',mode:'invalid'}),{kind:'fixture-error',code:'REVIEW_FIXTURE_CONTROL_FAILED'});assert.deepEqual(await ipc({kind:'review-fixture',mode:'complete',instructions:'override'}),{kind:'fixture-error',code:'REVIEW_FIXTURE_CONTROL_FAILED'});
    assert.equal((await post('/api/connect',{})).status,503,'normal writable native sessions remain disabled');stats=await ipc({kind:'review-fixture'});assert.equal(stats.counts.created,0);assert.equal(stats.counts.rejectedFactory,1);
    const complete=await begin(fourth.id),completed=await wait(fourth.id,complete.id,'completed');assert.match(completed.response,/Synthetic review fixture.*No actual AI/);assert.equal(completed.processStopped,true);stats=await ipc({kind:'review-fixture'});assert.deepEqual({created:stats.counts.created,reviewStarts:stats.counts.reviewStarts,closed:stats.counts.closed,active:stats.counts.active},{created:1,reviewStarts:1,closed:1,active:0});assert.equal(stats.last.workspaceId,fourth.id);assert.ok(!JSON.stringify(stats).includes('ORBIT_E2E_REVIEW_INPUT'));
    assert.equal((await get('/api/state')).runs.length,0);const verification=await get('/api/workspaces/'+fourth.id+'/verification');assert.equal(verification.checks.length,0);assert.equal(verification.approval,null);
    assert.equal((await ipc({kind:'review-fixture',mode:'hang'})).mode,'hang');const hanging=await begin(fourth.id);const deadline=Date.now()+5000;do{stats=await ipc({kind:'review-fixture'});if(stats.counts.reviewStarts===2)break;await new Promise(resolveWait=>setTimeout(resolveWait,20));}while(Date.now()<deadline);assert.equal(stats.counts.active,1);assert.equal(stats.counts.reviewStarts,2);
    assert.equal((await post('/api/reviews/'+hanging.id+'/interrupt',{workspaceId:fourth.id})).status,200);const interrupted=await wait(fourth.id,hanging.id,'interrupted');assert.equal(interrupted.processStopped,true);stats=await ipc({kind:'review-fixture'});assert.equal(stats.counts.interrupts,1);assert.equal(stats.counts.closed,2);assert.equal(stats.counts.active,0);assert.deepEqual(readFileSync(join(fourth.path,'README.md')),before);
    const foreign=await create(ids[0]);assert.deepEqual(await ipc({kind:'review-fixture'}),{kind:'fixture-error',code:'REVIEW_FIXTURE_CONTROL_FAILED'});const rejected=await begin(foreign.id);assert.equal((await wait(foreign.id,rejected.id,'failed')).processStopped,true);
    assert.equal((await post('/api/workspaces/select',{workspaceId:fourth.id})).status,200);assert.equal((await ipc({kind:'review-fixture'})).counts.rejectedFactory,2);await stop();
    await start([merge,workflow]);assert.deepEqual(await ipc({kind:'review-fixture'}),{kind:'fixture-error',code:'REVIEW_FIXTURE_CONTROL_FAILED'});const restored=await get('/api/workspaces/'+fourth.id+'/reviews');assert.equal(restored.records.find((record:any)=>record.id===complete.id).execution,'completed');assert.equal(restored.records.find((record:any)=>record.id===hanging.id).execution,'interrupted');const ungranted=await begin(fourth.id);assert.equal((await wait(fourth.id,ungranted.id,'failed')).processStopped,true);await stop();
    for(const grants of [[merge,workflow,first],[merge,workflow,workflow+'-sibling'],[merge,workflow,workflow,'extra']])await assert.rejects(start(grants),/review fixture exited 1/);
    for(const path of [first,merge,workflow])assert.equal(readFileSync(join(path,'README.md'),'utf8'),'owned review fixture\n');
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}assert.ok(root.startsWith(join(tmpdir(),'orbit-ui-server-review-test-')));rmSync(root,{recursive:true,force:true});}
});

test('E2E extension inventory requires a seventh exact grant, explicit connect and metadata collection without model turns or raw persistence',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-ui-server-inventory-test-')),sandbox=join(root,'sandbox'),assets=join(root,'assets');mkdirSync(sandbox);mkdirSync(assets);
  writeFileSync(join(root,'e2e-owned.json'),'{}');writeFileSync(join(assets,'index.html'),'<!doctype html><title>inventory fixture</title>');
  const first=join(sandbox,'orbit-ui-fixture'),merge=join(sandbox,'orbit-ui-merge'),workflow=join(sandbox,'orbit-ui-workflow'),env=isolatedEnvironment(process.env),config=join(root,'empty.gitconfig');writeFileSync(config,'');Object.assign(env,{GIT_CONFIG_GLOBAL:config,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
  for(const path of [first,merge,workflow]){mkdirSync(path);execFileSync('git',['init','-q','-b','main',path],{env,windowsHide:true,stdio:'pipe'});writeFileSync(join(path,'README.md'),'owned inventory fixture\n');execFileSync('git',['add','README.md'],{cwd:path,env,windowsHide:true,stdio:'pipe'});execFileSync('git',['-c','user.name=Orbit E2E','-c','user.email=orbit@example.invalid','-c','commit.gpgSign=false','commit','-qm','owned inventory fixture'],{cwd:path,env,windowsHide:true,stdio:'pipe'});}
  let child:ChildProcess|undefined,url='',cookie='',csrf='';
  const start=async(grants:string[])=>{child=fork(resolve('scripts/lib/orbit-ui-server.mjs'),[root,assets,'0',...grants],{env,cwd:sandbox,execArgv:[],silent:true,windowsHide:true});child.stdout!.resume();let diagnostic='';child.stderr!.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-1500);});const current=child;
    url=await new Promise<string>((ready,reject)=>{const timer=setTimeout(()=>reject(new Error('inventory fixture startup timeout')),10000);current.once('message',(message:any)=>{clearTimeout(timer);assert.equal(message.kind,'ready');ready(message.url);});current.once('error',error=>{clearTimeout(timer);reject(error);});current.once('exit',code=>{clearTimeout(timer);reject(new Error('inventory fixture exited '+code+' '+diagnostic));});});const response=await fetch(url+'/api/session'),session=await response.json() as any;cookie=response.headers.get('set-cookie')!.split(';')[0];csrf=session.csrfToken;};
  const stop=async()=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.send({kind:'stop'});assert.equal((await exited)[0],0);child=undefined;};
  const post=(path:string,body:object)=>fetch(url+path,{method:'POST',headers:{Origin:url,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
  const get=async(path:string)=>{const response=await fetch(url+path,{headers:{Cookie:cookie}});assert.equal(response.status,200);return response.json() as Promise<any>;};
  const ipc=(body:object)=>new Promise<any>((ready,reject)=>{const current=child!,timer=setTimeout(()=>{current.off('message',message);reject(new Error('inventory fixture IPC timeout'));},10000);const message=(value:any)=>{if(value?.kind==='inventory-fixture'||value?.kind==='workflow-fixture-evidence'||value?.kind==='fixture-error'){clearTimeout(timer);current.off('message',message);ready(value);}};current.on('message',message);current.send(body);});
  try{
    await start([merge,workflow,workflow,workflow]);
    const ids:string[]=[];for(const path of [first,workflow]){const response=await post('/api/projects',{path});assert.equal(response.status,200);ids.push((await response.json() as any).id);}
    const created=await post('/api/workspaces',{projectId:ids[1]});assert.equal(created.status,200);const fourth=await created.json() as any;assert.equal((await post('/api/workspaces/select',{workspaceId:fourth.id})).status,200);
    const before=await ipc({kind:'workflow-fixture-evidence'}),initial=await get('/api/extensions');assert.equal(initial.source,'not_queried');assert.equal(initial.status,'unknown');let stats=await ipc({kind:'inventory-fixture'});assert.equal(stats.counts.created,0);assert.equal(stats.counts.skills,0);assert.equal(stats.counts.hooks,0);
    assert.equal((await fetch(url+'/api/extensions?workspaceId='+fourth.id,{headers:{Cookie:cookie}})).status,400);assert.equal((await post('/api/extensions/refresh',{workspaceId:fourth.id})).status,409);
    assert.equal((await post('/api/connect',{})).status,200);assert.equal((await get('/api/state')).provider,'ready');stats=await ipc({kind:'inventory-fixture'});assert.equal(stats.counts.created,1);assert.equal(stats.counts.mcp,1);assert.equal(stats.counts.skills,0);assert.equal(stats.counts.hooks,0);assert.equal((await get('/api/extensions')).source,'not_queried');
    assert.equal((await post('/api/extensions/refresh',{workspaceId:randomUUID()})).status,409);assert.equal((await post('/api/extensions/refresh',{workspaceId:fourth.id,cwd:first})).status,400);
    const response=await post('/api/extensions/refresh',{workspaceId:fourth.id});assert.equal(response.status,200);const inventory=await response.json() as any;assert.equal(inventory.workspaceId,fourth.id);assert.equal(inventory.source,'codex_app_server');assert.ok(inventory.checkedAt);assert.deepEqual(inventory.sections.map((value:any)=>value.kind),['skills','hooks','mcp','plugins']);
    for(const kind of ['skills','hooks','mcp']){const section=inventory.sections.find((value:any)=>value.kind===kind);assert.equal(section.status,'available');assert.equal(section.items.length,1);assert.equal(section.items[0].effective,kind==='skills'?'unknown':'blocked_policy');assert.equal(section.items[0].version,null);}
    assert.equal(inventory.sections.find((value:any)=>value.kind==='plugins').status,'not_connected');assert.ok(JSON.stringify(inventory).includes('fixture skill'));assert.ok(JSON.stringify(inventory).includes('preToolUse'));assert.ok(JSON.stringify(inventory).includes('fixture-disabled-mcp'));assert.ok(!JSON.stringify(inventory).includes('ORBIT_INVENTORY_FORBIDDEN_RAW'));assert.ok(!JSON.stringify(inventory).includes(fourth.path));
    stats=await ipc({kind:'inventory-fixture'});assert.equal(stats.actualAiExecuted,false);assert.equal(stats.actualCliExecuted,false);assert.equal(stats.counts.mcp,2);assert.equal(stats.counts.skills,1);assert.equal(stats.counts.hooks,1);assert.equal(stats.counts.forbidden,0);
    assert.deepEqual(await get('/api/extensions'),inventory);assert.equal((await post('/api/extensions/refresh',{workspaceId:fourth.id})).status,200);assert.deepEqual((await ipc({kind:'inventory-fixture'})).counts,stats.counts,'GET and bounded cached refresh never rescan native metadata');assert.deepEqual(await ipc({kind:'workflow-fixture-evidence'}),before);
    const other=await post('/api/workspaces',{projectId:ids[0]});assert.equal(other.status,200);const foreign=await other.json() as any;assert.equal((await post('/api/workspaces/select',{workspaceId:foreign.id})).status,200);assert.equal((await post('/api/connect',{})).status,503,'the inventory grant cannot connect another project');assert.deepEqual(await ipc({kind:'inventory-fixture'}),{kind:'fixture-error',code:'INVENTORY_FIXTURE_CONTROL_FAILED'});
    assert.equal((await post('/api/workspaces/select',{workspaceId:fourth.id})).status,200);assert.equal((await get('/api/extensions')).source,'not_queried');assert.equal((await ipc({kind:'inventory-fixture'})).counts.closed,1);await stop();assert.equal(readFileSync(join(sandbox,'test.sqlite')).includes(Buffer.from('ORBIT_INVENTORY_FORBIDDEN_RAW')),false);
    await start([merge,workflow,workflow,workflow]);assert.equal((await get('/api/state')).provider,'disconnected');assert.equal((await get('/api/extensions')).source,'not_queried');assert.equal((await ipc({kind:'inventory-fixture'})).counts.created,0);assert.equal((await ipc({kind:'inventory-fixture'})).counts.mcp,0);assert.deepEqual(await ipc({kind:'workflow-fixture-evidence'}),before);await stop();
    await start([merge,workflow,workflow]);assert.equal((await post('/api/connect',{})).status,503,'the prior review grant never authorizes inventory sessions');assert.deepEqual(await ipc({kind:'inventory-fixture'}),{kind:'fixture-error',code:'INVENTORY_FIXTURE_CONTROL_FAILED'});await stop();
    for(const grants of [[merge,workflow,workflow,first],[merge,workflow,workflow,workflow+'-sibling'],[merge,workflow,workflow,workflow,'extra']])await assert.rejects(start(grants),/inventory fixture exited 1/);
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}assert.ok(root.startsWith(join(tmpdir(),'orbit-ui-server-inventory-test-')));rmSync(root,{recursive:true,force:true});}
});
