// Explicit opt-in only. One safe prompt, no retries and no external tools requested.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RpcClient } from './rpc.mjs';
import { initialRun, applyEvent, validateRoot } from './contracts.ts';

if (!process.argv.includes('--one-prompt')) throw new Error('Requires --one-prompt; consumes existing Codex subscription usage');
const entry=process.argv[process.argv.indexOf('--codex-entry')+1];
if (!process.argv.includes('--codex-entry') || !entry) throw new Error('Explicit installed codex.js entry required');
const dir=mkdtempSync(join(tmpdir(),'phase0-codex-'));
const result={timestamp:new Date().toISOString(),transport:'stdio',listener:'none',promptCount:0,stages:{},processExits:[],gitInitExit:null,gitStatusExit:null};
const output=resolve('spikes/phase0/evidence.json');
let c, state, interruptPromise, timer;
function record(name,status,details={}) { result.stages[name]={status,...details}; console.log(JSON.stringify({stage:name,status,...details})); }
function failure(e) { return {kind:e.rpcCode!==undefined?'rpc_error':/timeout/.test(e.message)?'timeout':/transport closed/.test(e.message)?'transport_closed':'local_error',...(e.rpcCode!==undefined?{code:e.rpcCode}:{})}; }
const start=()=>new RpcClient(process.execPath,[entry,'app-server','--listen','stdio://'],{cwd:dir});
try {
  execFileSync('git',['init','--quiet',dir],{windowsHide:true,stdio:'pipe'}); result.gitInitExit=0;
  const before=execFileSync('git',['-C',dir,'status','--porcelain'],{encoding:'utf8',windowsHide:true});
  if (!validateRoot(dir,dir)) throw new Error('Invalid disposable root');
  c=start(); await c.initialize(); record('initialize','verified');
  const account=await c.request('account/read',{refreshToken:false});
  // Discard email and all other account fields; never persist the raw response.
  const authType=account.account?.type ?? 'unknown'; const plan=account.account?.planType;
  record('account','verified',{authType,planType:['free','go','plus','pro','prolite','promax','team','self_serve_business_prolite','self_serve_business_usage_based','business','ent26','enterprise_cbp_automation','enterprise_cbp_usage_based','enterprise','edu','edu_plus','edu_pro','sci','sci_plus','unknown'].includes(plan)?plan:'unknown'});
  if(authType!=='chatgpt') throw new Error('Existing ChatGPT login required; no API fallback');
  for (const method of ['account/rateLimits/read','account/usage/read']) {
    try {
      const r=await c.request(method,null);
      if (method==='account/rateLimits/read') {
        const windows=[r.rateLimits?.primary,r.rateLimits?.secondary].filter(Boolean).map(w=>({usedPercent:typeof w.usedPercent==='number'?w.usedPercent:'unknown',windowDurationMins:w.windowDurationMins ?? 'unknown',resetsAt:w.resetsAt ?? 'unknown'}));
        record(method,windows.length?'verified':'unknown',{windows});
      } else {
        const summary={};
        for(const key of ['currentStreakDays','lifetimeTokens','longestRunningTurnSec','longestStreakDays','peakDailyTokens']) summary[key]=typeof r.summary?.[key]==='number'?r.summary[key]:'unknown';
        record(method,Object.values(summary).some(v=>typeof v==='number')?'verified':'unknown',{summary});
      }
    } catch(e) { record(method,'unknown',failure(e)); }
  }
  const policy={cwd:dir,sandbox:'read-only',approvalPolicy:'on-request',approvalsReviewer:'user'};
  const t=await c.request('thread/start',policy); const threadId=t.thread.id;
  state=initialRun(threadId); result.threadId=threadId; record('thread/start','verified');
  const cancel=()=>{
    if(state.turnId && !interruptPromise) interruptPromise=c.request('turn/interrupt',{threadId,turnId:state.turnId}).then(()=>record('turn/interrupt','verified')).catch(e=>record('turn/interrupt','failed',failure(e)));
  };
  c.on('notification',e=>{
    state=applyEvent(state,e);
    if(e.method==='item/agentMessage/delta' && e.params?.threadId===threadId) cancel();
  });
  timer=setTimeout(cancel,12000);
  result.promptCount=1;
  const turn=await c.request('turn/start',{threadId,input:[{type:'text',text:'Do not use tools, read files, or change anything. Reply with the numbers 1 through 30, one per line.'}]});
  state.turnId=turn.turn.id; result.turnId=turn.turn.id; record('turn/start','verified');
  const done=await c.waitFor(e=>e.method==='turn/completed' && e.params?.threadId===threadId && e.params?.turn?.id===state.turnId,45000);
  clearTimeout(timer); if(interruptPromise) await interruptPromise;
  record('stream',state.deltaCount>0?'verified':'unverified',{deltaCount:state.deltaCount});
  record('turn/completed','verified',{terminalStatus:done.params.turn.status,execution:state.execution,verification:state.verification});
  record('liveApproval',c.requestCount?'observed_and_denied':'unverified',{requestCount:c.requestCount});
  result.eventCounts={};
  for(const e of c.events) if(/^[a-zA-Z0-9/_-]+$/.test(e.method)) result.eventCounts[e.method]=(result.eventCounts[e.method]??0)+1;
  result.processExits.push(await c.close());
  c=start(); await c.initialize(); record('restart/initialize','verified');
  const resumed=await c.request('thread/resume',{...policy,threadId,excludeTurns:true});
  record('thread/resume',resumed.thread.id===threadId?'verified':'failed',{sameThread:resumed.thread.id===threadId});
  const after=execFileSync('git',['-C',dir,'status','--porcelain'],{encoding:'utf8',windowsHide:true}); result.gitStatusExit=0;
  record('repositoryIntegrity',before===after?'verified':'failed',{unchanged:before===after});
} catch(e) { record('fatal','failed',failure(e)); process.exitCode=1; }
finally {
  clearTimeout(timer);
  if(c && !c.exit) result.processExits.push(await c.close());
  writeFileSync(output,JSON.stringify(result,null,2)+'\n');
}
