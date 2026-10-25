import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RpcClient } from './rpc.mjs';

const binary=process.argv[2];
if(!binary?.endsWith('codex.exe')) throw new Error('Pass the installed native codex.exe path');
const dir=mkdtempSync(join(tmpdir(),'aicc-supplement-'));
execFileSync('git',['init','--quiet',dir],{windowsHide:true});
const disabled=['apps','plugins','hooks','browser_use','browser_use_external','computer_use','multi_agent','image_generation','shell_snapshot'];
const args=['app-server','--listen','stdio://','-c','mcp_servers={}','-c','web_search="disabled"',...disabled.flatMap(f=>['--disable',f])];
const report={at:new Date().toISOString(),cases:[],promptCount:0};
const policy={cwd:dir,sandbox:'read-only',approvalPolicy:'untrusted',approvalsReviewer:'user'};
let c;
const log=(name,data)=>{report.cases.push({name,...data});console.log(JSON.stringify({name,...data}));};
const start=async()=>{const rpc=new RpcClient(binary,args,{cwd:dir});await rpc.initialize();return rpc;};
try {
  c=await start();
  const account=await c.request('account/read',{refreshToken:false});
  if(account.account?.type!=='chatgpt') throw new Error('ChatGPT authentication required');
  const t=await c.request('thread/start',policy); const threadId=t.thread.id;
  const turn=async(text)=>{
    report.promptCount++;
    const r=await c.request('turn/start',{threadId,input:[{type:'text',text}]});
    return c.waitFor(e=>e.method==='turn/completed' && e.params?.turn?.id===r.turn.id,60000);
  };
  let e=await turn('Do not use any tools or read files. Reply exactly: PHASE0_NORMAL_COMPLETE');
  log('normal-completion',{status:e.params.turn.status,deltaEvents:c.events.filter(e=>e.method==='item/agentMessage/delta').length});
  const requests=c.requestCount;
  e=await turn('This is a harmless approval-denial test. Use the command execution tool to run Write-Output APPROVAL_PROBE with sandbox_permissions=require_escalated and justification="Phase 0 harmless approval test". Do not read or write files, do not access network. If approval is denied, stop and reply DENIED. Do not retry without approval.');
  log('approval',{status:e.params.turn.status,serverRequests:c.requestCount-requests,defaultDecision:'deny'});
  report.promptCount++;
  const r=await c.request('turn/start',{threadId,input:[{type:'text',text:'Do not use tools. Write the numbers 1 to 100, one per line.'}]});
  c.child.kill(); const exited=await c.closed;
  log('active-process-loss',{turnAccepted:!!r.turn.id,processExit:exited});
  c=await start();
  const resumed=await c.request('thread/resume',{...policy,threadId,excludeTurns:true});
  log('resume-after-loss',{sameThread:resumed.thread.id===threadId,noTurnResent:true});
  log('workspace',{unchanged:execFileSync('git',['-C',dir,'status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim()===''});
} catch(e) { log('failure',{kind:e.rpcCode!==undefined?'rpc-error':'timeout-or-transport',rpcCode:e.rpcCode??null});process.exitCode=1; }
finally {if(c)log('shutdown',{processExit:await c.close()});mkdirSync('.local',{recursive:true});writeFileSync('.local/phase0-supplement.json',JSON.stringify(report,null,2)+'\n');}
