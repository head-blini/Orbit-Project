import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {tmpdir} from './temp.ts';
import type {ConfigureVerificationInput} from '../shared/verification-setup.ts';
import {VerificationSetupService} from '../server/verification-setup.ts';
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
function write(root:string,path:string,content='throw new Error("must never execute during discovery");'){
  mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),content);
}
function fixture(files:Record<string,string>={}){
  const directory=mkdtempSync(join(tmpdir(),'orbit-setup-')),root=join(directory,'repo'),managed=join(directory,'workspaces'),db=join(directory,'state.sqlite');
  mkdirSync(root);git(root,'init','-q','-b','main');write(root,'README.md','fixture');
  for(const [path,content] of Object.entries(files))write(root,path,content);
  git(root,'add','.');git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const store=new Store(db),projects=new Projects(store,managed,[root]),project=projects.register(root),workspace=projects.create(project.id);
  const service=new VerificationSetupService(store,projects);
  const input=(requestId=randomUUID()):ConfigureVerificationInput=>({requestId,profileId:'node-test-v1',expectedPreviewDigest:service.view(workspace.id).candidate!.previewDigest,confirmed:true});
  return {directory,root,managed,db,store,projects,project,workspace,service,input};
}

test('empty repositories have no runnable candidate and setup cannot manufacture a successful check',()=>{
  const f=fixture();try{
    const before=f.store.lastSeq(),view=f.service.view(f.workspace.id);
    assert.equal(view.source,'none');assert.equal(view.revision,0);assert.equal(view.lastRequestId,null);assert.equal(view.candidate,null);assert.equal(view.issue,'NO_NODE_TEST_FILES');assert.deepEqual(view.commands,[]);
    assert.throws(()=>f.service.configure(f.workspace.id,{requestId:randomUUID(),profileId:'node-test-v1',expectedPreviewDigest:'a'.repeat(64),confirmed:true}),/NO_NODE_TEST_FILES/);
    assert.equal(f.store.lastSeq(),before);assert.equal(f.store.runs().length,0);
  }finally{f.store.close();}
});

test('discovery selects every present Git-visible Node test and protects exact tests and root manifests without running them',()=>{
  const f=fixture({'tests/a.test.mjs':'import{writeFileSync}from"node:fs";writeFileSync("started","unexpected");','old.test.js':'throw 1','package.json':'{}','package-lock.json':'{}','.gitignore':'ignored/\n'});try{
    rmSync(join(f.workspace.path,'old.test.js'));write(f.workspace.path,'--watch.test.cjs');write(f.workspace.path,'nested/b.test.js');write(f.workspace.path,'ignored/hidden.test.js');write(f.workspace.path,'not-a-test.js');write(f.workspace.path,'nested/package.json','{}');
    const before=git(f.workspace.path,'status','--porcelain'),source=f.projects.snapshot(f.workspace.id).sourceDigest,view=f.service.view(f.workspace.id),candidate=view.candidate!;
    assert.equal(view.issue,null);assert.deepEqual(candidate.tests,['--watch.test.cjs','nested/b.test.js','tests/a.test.mjs']);
    assert.equal(candidate.sourceDigest,source);assert.equal(candidate.baseSha,f.workspace.baseSha);assert.equal(candidate.profileId,'node-test-v1');
    assert.equal(candidate.command.executable,process.execPath);assert.deepEqual(candidate.command.args,['--test','--','--watch.test.cjs','nested/b.test.js','tests/a.test.mjs']);
    assert.deepEqual(candidate.command.protectedFiles,['--watch.test.cjs','nested/b.test.js','package-lock.json','package.json','tests/a.test.mjs']);assert.equal(candidate.command.timeoutMs,60000);
    const receipt=f.service.configure(f.workspace.id,f.input());assert.equal(receipt.revision,1);
    assert.deepEqual(f.service.commands(f.root),[candidate.command]);assert.equal(git(f.workspace.path,'status','--porcelain'),before);assert.equal(f.projects.snapshot(f.workspace.id).sourceDigest,source);
    assert.equal(f.store.runs().length,0);assert.equal(existsSync(join(f.workspace.path,'started')),false);
  }finally{f.store.close();}
});

test('discovery accepts sixty tests and rejects sixty-one without truncating the command',()=>{
  const f=fixture();try{
    for(let i=0;i<60;i++)write(f.workspace.path,`test-${i}.test.js`);
    assert.equal(f.service.view(f.workspace.id).candidate!.tests.length,60);
    write(f.workspace.path,'test-60.test.js');const view=f.service.view(f.workspace.id);assert.equal(view.candidate,null);assert.equal(view.issue,'TOO_MANY_TEST_FILES');
    assert.deepEqual(f.service.commands(f.root),[]);
  }finally{f.store.close();}
});

test('unavailable whole-source snapshots and invalid protected paths fail closed without partial discovery',()=>{
  for(const path of ['private.key','invalid[glob].test.js']){
    const f=fixture({'good.test.js':'throw 1'});try{
      write(f.workspace.path,path);const view=f.service.view(f.workspace.id);assert.equal(view.candidate,null);assert.equal(view.issue,'SOURCE_UNAVAILABLE',path);
      assert.throws(()=>f.service.configure(f.workspace.id,{requestId:randomUUID(),profileId:'node-test-v1',expectedPreviewDigest:'a'.repeat(64),confirmed:true}),/SOURCE_UNAVAILABLE/);
    }finally{f.store.close();}
  }
});

test('an existing ignored root manifest cannot be silently omitted from protected files',()=>{
  for(const manifest of ['package.json','package-lock.json']){
    const f=fixture({'a.test.js':'throw 1','.gitignore':`${manifest}\n`});try{
      write(f.workspace.path,manifest,'{}');const view=f.service.view(f.workspace.id);
      assert.equal(view.candidate,null);assert.equal(view.issue,'SOURCE_UNAVAILABLE');
      assert.throws(()=>f.service.configure(f.workspace.id,{requestId:randomUUID(),profileId:'node-test-v1',expectedPreviewDigest:'a'.repeat(64),confirmed:true}),/SOURCE_UNAVAILABLE/);
    }finally{f.store.close();}
  }
});

test('source, workspace, and current revision changes invalidate preview compare-and-swap',()=>{
  const f=fixture({'a.test.js':'throw 1'});try{
    const initial=f.input();write(f.workspace.path,'README.md','changed');assert.throws(()=>f.service.configure(f.workspace.id,initial),/VERIFICATION_SETUP_PREVIEW_STALE/);
    const next=f.input(),second=f.projects.create(f.project.id);write(second.path,'README.md','changed');
    assert.equal(f.projects.snapshot(f.workspace.id).sourceDigest,f.projects.snapshot(second.id).sourceDigest);
    assert.throws(()=>f.service.configure(second.id,next),/VERIFICATION_SETUP_PREVIEW_STALE/);
    const receipt=f.service.configure(f.workspace.id,next);assert.equal(receipt.revision,1);
    assert.throws(()=>f.service.configure(f.workspace.id,{...next,requestId:randomUUID()}),/VERIFICATION_SETUP_PREVIEW_STALE/);
    const updated=f.service.configure(f.workspace.id,f.input());assert.equal(updated.revision,2);
    assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM verification_setup_presets WHERE project_id=?').get(f.project.id)!.n),2);
  }finally{f.store.close();}
});

test('exact consent input rejects extra fields, unknown profiles, invalid identities and accessor properties',()=>{
  const f=fixture({'a.test.js':'throw 1'});try{
    const valid=f.input(),before=f.store.lastSeq();
    assert.throws(()=>f.service.configure(f.workspace.id,{...valid,confirmed:false}),error=>error instanceof Error&&error.message==='VERIFICATION_SETUP_CONFIRMATION_REQUIRED'&&(error as any).status===409);
    for(const patch of [{confirmed:1},{profileId:'shell'},{requestId:'../x'},{requestId:''},{expectedPreviewDigest:'bad'},{executable:process.execPath},{args:['-e','process.exit()']}]){
      assert.throws(()=>f.service.configure(f.workspace.id,{...valid,...patch} as any),/INVALID_FIELDS/);
    }
    let accessed=false;const accessor={...valid};Object.defineProperty(accessor,'confirmed',{get(){accessed=true;return true;}});
    assert.throws(()=>f.service.configure(f.workspace.id,accessor),/INVALID_FIELDS/);assert.equal(accessed,false);
    assert.throws(()=>f.service.configure(f.workspace.id,Object.create(valid)),/INVALID_FIELDS/);assert.equal(f.store.lastSeq(),before);
  }finally{f.store.close();}
});

test('same request replays its original receipt across revisions and rejects conflicting content',()=>{
  const f=fixture({'a.test.js':'throw 1'});try{
    const firstInput=f.input(),first=f.service.configure(f.workspace.id,firstInput),after=f.store.lastSeq();
    assert.deepEqual(f.service.configure(f.workspace.id,firstInput),first);assert.equal(f.store.lastSeq(),after);
    const secondInput=f.input();f.service.configure(f.workspace.id,secondInput);write(f.workspace.path,'a.test.js','throw 2');
    assert.deepEqual(f.service.configure(f.workspace.id,firstInput),first);
    assert.throws(()=>f.service.configure(f.workspace.id,{...firstInput,expectedPreviewDigest:'a'.repeat(64)}),/IDEMPOTENCY_CONFLICT/);
    const other=f.projects.create(f.project.id);assert.throws(()=>f.service.configure(other.id,firstInput),/IDEMPOTENCY_CONFLICT/);
  }finally{f.store.close();}
});

test('host configuration takes priority over saved presets and blocks replacing host commands',()=>{
  const f=fixture({'a.test.js':'throw 1'});try{
    f.service.configure(f.workspace.id,f.input());
    const host={projectPath:f.root,id:'host-check',label:'Host',executable:process.execPath,args:['--version'],timeoutMs:3000};
    const service=new VerificationSetupService(f.store,f.projects,[host]),view=service.view(f.workspace.id);
    assert.equal(view.source,'host');assert.equal(view.candidate,null);assert.equal(view.issue,'HOST_CONFIGURATION');assert.equal(view.commands[0].id,'host-check');assert.deepEqual(service.commands(f.root),view.commands);
    assert.throws(()=>service.configure(f.workspace.id,{requestId:randomUUID(),profileId:'node-test-v1',expectedPreviewDigest:'a'.repeat(64),confirmed:true}),/HOST_CONFIGURATION/);
    assert.equal(f.service.commands(f.root)[0].id,'orbit-node-tests');
  }finally{f.store.close();}
});

test('saved settings and replay receipts survive restart while new tests require explicit reconfiguration',()=>{
  const f=fixture({'a.test.js':'throw 1'}),input=f.input(),receipt=f.service.configure(f.workspace.id,input),commands=f.service.commands(f.root);f.store.close();
  const store=new Store(f.db);try{
    const projects=new Projects(store,f.managed,[f.root]),service=new VerificationSetupService(store,projects);
    write(f.workspace.path,'b.test.mjs');assert.deepEqual(service.commands(f.root),commands);assert.deepEqual(service.configure(f.workspace.id,input),receipt);
    const view=service.view(f.workspace.id);assert.equal(view.source,'preset');assert.equal(view.revision,1);assert.equal(view.lastRequestId,input.requestId);assert.deepEqual(view.candidate!.tests,['a.test.js','b.test.mjs']);
    service.configure(f.workspace.id,{...input,requestId:randomUUID(),expectedPreviewDigest:view.candidate!.previewDigest});
    assert.deepEqual(service.commands(f.root)[0].args,['--test','--','a.test.js','b.test.mjs']);
  }finally{store.close();}
});

test('settings are bound to exact project ID and path and never leak to another registered repository',()=>{
  const f=fixture({'a.test.js':'throw 1'});try{
    const input=f.input();f.service.configure(f.workspace.id,input);
    const other=join(f.directory,'other');mkdirSync(other);git(other,'init','-q','-b','main');write(other,'README.md','other');git(other,'add','.');git(other,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','other');
    const projects=new Projects(f.store,f.managed,[f.root,other]),project=projects.register(other),workspace=projects.create(project.id),service=new VerificationSetupService(f.store,projects);
    assert.deepEqual(service.commands(other),[]);assert.equal(service.view(workspace.id).source,'none');assert.throws(()=>service.configure(workspace.id,input),/IDEMPOTENCY_CONFLICT/);
    const changed={...f.project,path:other};f.store.db.prepare('UPDATE projects SET body=? WHERE id=?').run(JSON.stringify(changed),f.project.id);
    assert.throws(()=>service.commands(other),/VERIFICATION_SETUP_CORRUPT/);
  }finally{f.store.close();}
});

test('service independently rejects disabled writes and missing project support',()=>{
  const f=fixture({'a.test.js':'throw 1'});try{
    const input=f.input(),disabled=new VerificationSetupService(f.store,new Projects(f.store,f.managed));
    assert.throws(()=>disabled.configure(f.workspace.id,input),/WRITES_DISABLED/);
    assert.throws(()=>new VerificationSetupService(f.store,undefined).view(f.workspace.id),/VERIFICATION_SETUP_UNAVAILABLE/);
    assert.throws(()=>f.service.configure('missing-workspace',input),/WORKSPACE_NOT_READY/);assert.deepEqual(f.service.commands(f.root),[]);
  }finally{f.store.close();}
});

test('revision, receipt, and event write failures roll back together and emit no successful event',()=>{
  const f=fixture({'a.test.js':'throw 1'});try{
    const input=f.input(),before=f.store.lastSeq(),events:unknown[]=[];f.store.on('event',event=>events.push(event));
    f.store.db.exec("CREATE TRIGGER reject_setup_receipt BEFORE INSERT ON verification_setup_receipts BEGIN SELECT RAISE(ABORT,'fixture write failed'); END;");
    assert.throws(()=>f.service.configure(f.workspace.id,input));assert.equal(f.service.view(f.workspace.id).revision,0);assert.equal(f.store.lastSeq(),before);assert.deepEqual(events,[]);
    f.store.db.exec('DROP TRIGGER reject_setup_receipt');
    f.store.db.exec("CREATE TRIGGER reject_setup_event BEFORE INSERT ON events WHEN NEW.kind='verification.setup.configured' BEGIN SELECT RAISE(ABORT,'fixture event failed'); END;");
    assert.throws(()=>f.service.configure(f.workspace.id,input));assert.equal(f.service.view(f.workspace.id).revision,0);assert.equal(f.store.lastSeq(),before);assert.deepEqual(events,[]);
    f.store.db.exec('DROP TRIGGER reject_setup_event');assert.equal(f.service.configure(f.workspace.id,input).revision,1);assert.equal(events.length,1);
  }finally{f.store.close();}
});

test('corrupt persisted preset or receipt rejects reads and writes instead of returning unconfigured commands',()=>{
  for(const table of ['verification_setup_presets','verification_setup_receipts']){
    const f=fixture({'a.test.js':'throw 1'});try{
      const input=f.input();f.service.configure(f.workspace.id,input);f.store.db.exec(`UPDATE ${table} SET body='{"executable":"/bin/sh","args":["-c","echo bad"]}'`);
      for(const operation of [()=>f.service.commands(f.root),()=>f.service.view(f.workspace.id),()=>f.service.configure(f.workspace.id,input)])assert.throws(operation,/VERIFICATION_SETUP_CORRUPT/);
    }finally{f.store.close();}
  }
});

test('one hundred immutable revisions fill the project quota while existing receipts remain replayable',()=>{
  const f=fixture({'a.test.js':'throw 1'});try{
    // Quota policy is independent of Git I/O; use one already validated real snapshot.
    const snapshot=f.projects.snapshot(f.workspace.id),projects={writable:()=>f.workspace,list:()=>[f.project],snapshot:()=>snapshot} as unknown as Projects;
    const service=new VerificationSetupService(f.store,projects);let first:ConfigureVerificationInput|undefined;
    for(let revision=1;revision<=100;revision++){
      const input={requestId:randomUUID(),profileId:'node-test-v1' as const,expectedPreviewDigest:service.view(f.workspace.id).candidate!.previewDigest,confirmed:true};
      first??=input;assert.equal(service.configure(f.workspace.id,input).revision,revision);
    }
    const before=f.store.lastSeq(),input={...first!,requestId:randomUUID(),expectedPreviewDigest:service.view(f.workspace.id).candidate!.previewDigest};
    assert.throws(()=>service.configure(f.workspace.id,input),error=>error instanceof Error&&error.message==='VERIFICATION_SETUP_QUOTA'&&(error as any).status===413);
    assert.equal(service.configure(f.workspace.id,first!).revision,1);assert.equal(service.view(f.workspace.id).revision,100);assert.equal(f.store.lastSeq(),before);
  }finally{f.store.close();}
});
