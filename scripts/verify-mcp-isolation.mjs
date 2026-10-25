// Native protocol check only: disposable CODEX_HOME, no credentials or inference.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findCodex, codexArgs } from '../server/codex.ts';
import { Rpc } from '../server/rpc.ts';
import { createWorkspace } from '../server/workspace.ts';

const binary=findCodex();
const root=mkdtempSync(join(tmpdir(),'aicc-mcp-isolation-'));
const workspace=createWorkspace(root),marker=join(root,'mcp-started');
const probe=join(root,'probe.cjs');
writeFileSync(probe,`require('fs').writeFileSync(${JSON.stringify(marker)},'started');
let b='';process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){
const e=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(e.id===undefined)continue;
const result=e.method==='initialize'?{protocolVersion:e.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:e.method==='tools/list'?{tools:[]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:e.id,result})+'\\n');}});
process.stdin.on('end',()=>process.exit(0));`);
writeFileSync(join(root,'config.toml'),`[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(probe)}]\nenabled=true\n`);
// This environment belongs only to this verification process and its child.
process.env.CODEX_HOME=root;
const coding=process.argv.includes('--coding');
const report={mode:coding?'coding':'read-only',preflightDoesNotStartMcp:false,disabledStart:false,disabledResume:'not_tested_no_persisted_turn',positiveControl:false};
let rpc;
const start=async()=>{rpc=new Rpc(binary,codexArgs(coding),workspace);await rpc.initialize();return rpc;};
const params={cwd:workspace,sandbox:coding?'workspace-write':'read-only',approvalPolicy:coding?'on-request':'untrusted',approvalsReviewer:'user'};
try{
  await start();
  const result=await rpc.request('config/read',{includeLayers:false,cwd:workspace});
  assert.ok(result.config.mcp_servers.fixture);
  assert.equal(existsSync(marker),false);report.preflightDoesNotStartMcp=true;
  const config={mcp_servers:{fixture:{enabled:false}},...(coding?{sandbox_workspace_write:{writable_roots:[],network_access:false,exclude_tmpdir_env_var:true,exclude_slash_tmp:true}}:{})};
  const first=await rpc.request('thread/start',{...params,config});
  const inventory=await rpc.request('mcpServerStatus/list',{threadId:first.thread.id,detail:'toolsAndAuthOnly'});
  assert.equal(inventory.data.length,1);assert.equal(inventory.data[0].runtimeStatus,'disabled');assert.deepEqual(inventory.data[0].tools,{});assert.equal(existsSync(marker),false);report.disabledStart=true;
  // Native 0.164 does not persist a no-turn thread. Restart/resume requires
  // an actual turn and belongs to the explicitly authorized live browser test.
  await rpc.close();await start();
  const positive=await rpc.request('thread/start',params);
  await rpc.request('mcpServerStatus/list',{threadId:positive.thread.id,detail:'toolsAndAuthOnly'});
  assert.equal(existsSync(marker),true);report.positiveControl=true;
}catch{process.exitCode=1;}
finally{if(rpc)await rpc.close();console.log(JSON.stringify(report));}
