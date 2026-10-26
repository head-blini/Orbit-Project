import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import type {Projects} from '../server/projects.ts';
import {VerificationService,verificationCommandPreviews,type VerificationConfiguration} from '../server/verification-service.ts';
import {WorkflowService} from '../server/workflow-service.ts';

test('verification and workflow resolve the same current commands, invalidating old approval after a configuration update',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'orbit-config-source-')),store=new Store(':memory:');
  const project={id:'project-1',name:'Fixture',path:directory,createdAt:'',writeEnabled:true};
  const workspace={id:'workspace-1',projectId:project.id,path:directory,baseSha:'a'.repeat(40),branch:'orbit/fixture',createdAt:'',status:'ready' as const};
  store.saveProject(project);store.saveWorkspace(workspace);writeFileSync(join(directory,'check.mjs'),"console.log('checked');\n");
  const projects={writable:()=>workspace,list:()=>[project],fingerprint:()=>'b'.repeat(64)} as unknown as Projects;
  let configuration:VerificationConfiguration[]=[{projectPath:directory,id:'tests',label:'Tests',executable:process.execPath,args:['check.mjs'],timeoutMs:5000}];
  const resolve=(path:string)=>verificationCommandPreviews(configuration,path);
  const verification=new VerificationService(store,projects,resolve as any),workflow=new WorkflowService(store,projects,resolve as any);
  const run=store.createRun('configured-run','c'.repeat(64),'fixture',workspace.id);store.updateRun(run.id,{execution:'completed'},'run.completed');
  const current=()=>verification.view(workspace.id,run.id);
  const start=(requestId:string)=>{const view=current();return verification.start({requestId,runId:run.id,workspaceId:workspace.id,commandId:'tests',expectedSourceDigest:view.sourceDigest!,expectedConfigDigest:view.commands[0].configDigest});};
  try{
    assert.equal(current().commands.length,1);assert.deepEqual(workflow.view(project.id,workspace.id).commands,current().commands);
    start('check-before-change');await verification.settle();assert.equal(current().checks[0].verdict,'passed');assert.equal(current().canApprove,true);
    const view=current();verification.approve({requestId:'approval-before-change',runId:run.id,workspaceId:workspace.id,expectedSourceDigest:view.sourceDigest!,expectedCheckSetDigest:view.checkSetDigest!});assert.equal(current().approvalCurrent,true);
    configuration=[{...configuration[0],args:['-e','process.exit(7)']}];
    assert.equal(current().approvalCurrent,false);assert.equal(current().canApprove,false);assert.deepEqual(workflow.view(project.id,workspace.id).commands,current().commands);
    start('check-after-change');await verification.settle();assert.equal(current().checks[0].verdict,'failed');assert.equal(current().checks[0].exitCode,7);assert.equal(current().checks.length,2);
  }finally{await verification.close();await workflow.close();store.close();}
});

test('a failed current configuration resolver cannot fall back to the last successful command set',()=>{
  const store=new Store(':memory:');const project={id:'project-1',name:'Fixture',path:tmpdir(),createdAt:'',writeEnabled:true};
  const workspace={id:'workspace-1',projectId:project.id,path:project.path,baseSha:'a'.repeat(40),branch:'orbit/fixture',createdAt:'',status:'ready' as const};
  store.saveProject(project);store.saveWorkspace(workspace);
  const projects={writable:()=>workspace,list:()=>[project]} as unknown as Projects;
  const broken=()=>{throw new Error('CONFIGURATION_CORRUPT');};
  try{const verification=new VerificationService(store,projects,broken as any),workflow=new WorkflowService(store,projects,broken as any);
    assert.throws(()=>verification.view(workspace.id,null),/CONFIGURATION_CORRUPT/);assert.throws(()=>workflow.view(project.id,workspace.id),/CONFIGURATION_CORRUPT/);
  }finally{store.close();}
});
