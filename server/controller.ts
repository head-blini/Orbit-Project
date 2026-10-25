import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Snapshot, ProviderStatus, Run, Execution } from '../shared/types.ts';
import { terminal } from '../shared/types.ts';
import { Store } from './store.ts';
import { assertWorkspace } from './workspace.ts';
import { safeText, containsCredential } from './privacy.ts';
import type { RpcPort } from './rpc.ts';
export class AppError extends Error {status:number;constructor(message:string,status=409){super(message);this.status=status;}}
export class Controller {
  store:Store;workspace:string;private factory:()=>RpcPort;private rpc:RpcPort|null=null;
  private provider:ProviderStatus='disconnected';private issue:string|null=null;private connecting:Promise<void>|null=null;
  private generation=0;private output=new Map<string,string>();private deadline:NodeJS.Timeout|null=null;
  constructor(store:Store,workspace:string,factory:()=>RpcPort){this.store=store;this.workspace=workspace;this.factory=factory;}
  snapshot():Snapshot{return {provider:this.provider,issue:this.issue,threadId:this.store.getThread(),workspace:basename(this.workspace),readOnly:true,runs:this.store.runs(),lastSeq:this.store.lastSeq()};}
  private status(status:ProviderStatus,issue:string|null=null){this.provider=status;this.issue=issue;this.store.append('provider.status',null,{status,issue});}
  private active():Run|undefined{return this.store.runs().find(r=>!terminal(r.execution));}
  async connect():Promise<void>{
    if(this.connecting)return this.connecting;if(this.provider==='ready')return;
    this.connecting=this.open().finally(()=>{this.connecting=null;});return this.connecting;
  }
  private async open(){
    this.status('connecting');const generation=++this.generation;
    try{
      assertWorkspace(this.workspace);const rpc=this.factory();this.rpc=rpc;
      rpc.on('closed',()=>{if(generation!==this.generation)return;this.rpc=null;this.loseActive();this.status('disconnected','TRANSPORT_CLOSED');});
      rpc.on('notification',(e:any)=>{if(generation===this.generation)this.onEvent(e);});
      rpc.on('approval',(e:any)=>{if(generation===this.generation)this.store.append('approval.denied',this.active()?.id??null,{kind:e.method,decision:'deny'});});
      await rpc.initialize();const a=await rpc.request('account/read',{refreshToken:false});
      if(a.account?.type!=='chatgpt')throw new AppError('CHATGPT_LOGIN_REQUIRED');
      // Read effective names before loading any thread: a threadless MCP inventory
      // can itself start user MCPs. Never persist or expose this config response.
      let config:{mcp_servers:Record<string,{enabled:false}>};
      try{
        const result=await rpc.request('config/read',{includeLayers:false,cwd:this.workspace});
        if(!result?.config||typeof result.config!=='object'||Array.isArray(result.config))throw new Error();
        const servers=result.config.mcp_servers??{};
        if(typeof servers!=='object'||Array.isArray(servers))throw new Error();
        config={mcp_servers:Object.fromEntries(Object.keys(servers).map(name=>[name,{enabled:false as const}]))};
      }catch{throw new Error('MCP_ISOLATION_REQUIRED');}
      const id=this.store.getThread();
      const params={cwd:this.workspace,config,sandbox:'read-only',approvalPolicy:'untrusted',approvalsReviewer:'user',developerInstructions:'This is a read-only text-only test session. Do not use tools, access files, credentials, network, or other projects. Answer only from user-provided text.'};
      const t=await rpc.request(id?'thread/resume':'thread/start',id?{...params,threadId:id,excludeTurns:true}:params);
      if(typeof t.thread?.id!=='string' || (id && t.thread.id!==id))throw new Error('THREAD_MISMATCH');
      if(t.sandbox?.type!=='readOnly'||t.sandbox.networkAccess!==false||t.approvalPolicy!=='untrusted'||t.approvalsReviewer!=='user')throw new Error('POLICY_MISMATCH');
      if(t.thread.status?.type==='active')throw new Error('THREAD_STILL_ACTIVE');
      // Thread-scoped inventory only: never read raw config or perform threadless discovery.
      // Native 0.164 includes disabled configured servers in this inventory. Empty
      // tools alone are insufficient: only explicitly disabled, known entries pass.
      const inventory=await rpc.request('mcpServerStatus/list',{threadId:t.thread.id,detail:'toolsAndAuthOnly',limit:100});
      if(!Array.isArray(inventory.data)||inventory.nextCursor||inventory.data.some((entry:any)=>
        !entry||!Object.hasOwn(config.mcp_servers,entry.name)||entry.runtimeStatus!=='disabled'||
        !entry.tools||typeof entry.tools!=='object'||Array.isArray(entry.tools)||Object.keys(entry.tools).length!==0
      ))throw new Error('MCP_ISOLATION_REQUIRED');
      if(this.rpc!==rpc)throw new Error('TRANSPORT_CLOSED');
      this.store.setThread(t.thread.id);this.status('ready');this.store.append(id?'session.resumed':'session.created',null,{});
    }catch(e){
      const code=e instanceof Error?e.message:'';
      const issue=['CODEX_NOT_INSTALLED','CHATGPT_LOGIN_REQUIRED','POLICY_MISMATCH','THREAD_STILL_ACTIVE','MCP_ISOLATION_REQUIRED'].includes(code)?code:'CONNECTION_FAILED';
      const rpc=this.rpc;this.rpc=null;++this.generation;if(rpc)await rpc.close();
      this.status(issue==='CODEX_NOT_INSTALLED'?'not_installed':issue==='CHATGPT_LOGIN_REQUIRED'?'auth_required':'error',issue);throw new AppError(issue,503);
    }
  }
  async submit(input:{requestId:string;prompt:string}):Promise<Run>{
    if(typeof input?.requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>4000)throw new AppError('INVALID_PROMPT',400);
    if(containsCredential(input.prompt))throw new AppError('CREDENTIAL_LIKE_INPUT',400);
    const digest=createHash('sha256').update(input.prompt).digest('hex');const prior=this.store.findRequest(input.requestId);
    if(prior){if(prior.digest!==digest)throw new AppError('IDEMPOTENCY_CONFLICT');return prior.run;}
    if(this.provider!=='ready'||!this.rpc)throw new AppError('NOT_CONNECTED');
    if(this.active())throw new AppError('RUN_ACTIVE');assertWorkspace(this.workspace);
    const run=this.store.createRun(input.requestId,digest,safeText(input.prompt));const rpc=this.rpc;
    this.output.clear();this.deadline=setTimeout(()=>{void this.failTransport('RUN_TIMEOUT');},120000);
    try{
      const result=await rpc.request('turn/start',{threadId:this.store.getThread(),input:[{type:'text',text:input.prompt}],sandboxPolicy:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',approvalsReviewer:'user'});
      if(typeof result.turn?.id!=='string')throw new Error('INVALID_TURN');
      this.store.updateRun(run.id,{turnId:result.turn.id,execution:this.store.getRun(run.id)?.execution==='interrupting'?'interrupting':'running'},'run.accepted');
      return this.store.getRun(run.id)!;
    }catch{
      const current=this.store.getRun(run.id)!;
      if(terminal(current.execution)&&current.execution!=='lost')return current;
      if(this.rpc===rpc&&this.active()?.id===run.id)await this.failTransport('SUBMIT_UNCERTAIN');
      throw new AppError('SUBMIT_UNCERTAIN',503);
    }
  }
  async interrupt(id:string){
    const run=this.store.getRun(id);if(!run)throw new AppError('RUN_NOT_FOUND',404);
    if(terminal(run.execution)||run.execution==='interrupting')return;
    if(!run.turnId||!this.rpc)throw new AppError('TURN_NOT_READY');
    this.store.updateRun(id,{execution:'interrupting'},'interrupt.requested');const rpc=this.rpc;
    try{await rpc.request('turn/interrupt',{threadId:this.store.getThread(),turnId:run.turnId});this.store.append('interrupt.accepted',id,{});}
    catch{
      if(terminal(this.store.getRun(id)!.execution))return;
      if(this.rpc===rpc&&this.active()?.id===id)await this.failTransport('INTERRUPT_UNCERTAIN');
      throw new AppError('INTERRUPT_UNCERTAIN',503);
    }
  }
  private onEvent(e:any){
    const p=e.params;if(!p||p.threadId!==this.store.getThread())return;
    const r=this.active();if(!r)return;const turnId=p.turn?.id??p.turnId;
    if(r.turnId&&turnId&&r.turnId!==turnId)return;
    if(e.method==='turn/started' && typeof p.turn?.id==='string')this.store.updateRun(r.id,{turnId:p.turn.id,execution:r.execution==='interrupting'?'interrupting':'running'},'run.started');
    if(e.method==='item/agentMessage/delta' && typeof p.delta==='string'){
      const key=typeof p.itemId==='string'?p.itemId:'message';this.output.set(key,((this.output.get(key)??'')+p.delta).slice(0,64000));
      this.store.updateRun(r.id,{response:safeText([...this.output.values()].join('\n\n'),false)},'message.updated');
    }
    if(e.method==='item/completed' && p.item?.type==='agentMessage' && typeof p.item.text==='string'){
      this.output.set(p.item.id??'message',p.item.text.slice(0,64000));
      this.store.updateRun(r.id,{response:safeText([...this.output.values()].join('\n\n'))},'message.updated');
    }
    if(e.method==='turn/completed'){
      const execution:Execution=['completed','interrupted','failed'].includes(p.turn?.status)?p.turn.status:'failed';
      this.store.updateRun(r.id,{execution,response:safeText([...this.output.values()].join('\n\n'))},'run.'+execution);this.clearDeadline();
    }
    if(e.method==='error')this.store.append('provider.error',r.id,{retrying:p.willRetry===true});
  }
  private clearDeadline(){if(this.deadline)clearTimeout(this.deadline);this.deadline=null;}
  private loseActive(){this.clearDeadline();const r=this.active();if(r)this.store.updateRun(r.id,{execution:'lost'},'run.lost');}
  private async failTransport(issue:string){this.loseActive();const rpc=this.rpc;this.rpc=null;++this.generation;this.status('error',issue);if(rpc)await rpc.close();}
  async close(){this.loseActive();const rpc=this.rpc;this.rpc=null;++this.generation;if(rpc)await rpc.close();this.provider='disconnected';}
}
