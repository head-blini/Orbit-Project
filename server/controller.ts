import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Snapshot, ProviderStatus, Run, Execution } from '../shared/types.ts';
import { terminal } from '../shared/types.ts';
import { Store } from './store.ts';
import { assertWorkspace } from './workspace.ts';
import { safeText, containsCredential } from './privacy.ts';
import type { RpcPort } from './rpc.ts';
import { AppError } from './errors.ts';
import { Projects } from './projects.ts';
export { AppError } from './errors.ts';
export class Controller {
  store:Store;workspace:string;private factory:(workspace:string,write:boolean)=>RpcPort;private rpc:RpcPort|null=null;
  private projects?:Projects;private workspaceId?:string;private switching=false;
  private provider:ProviderStatus='disconnected';private issue:string|null=null;private connecting:Promise<void>|null=null;
  private generation=0;private output=new Map<string,string>();private deadline:NodeJS.Timeout|null=null;
  constructor(store:Store,workspace:string,factory:(workspace:string,write:boolean)=>RpcPort,projects?:Projects){this.store=store;this.workspace=workspace;this.factory=factory;this.projects=projects;const selected=projects?.workspaces().find(w=>w.id===store.getMeta('selectedWorkspace'));if(selected){this.workspaceId=selected.id;this.workspace=selected.path;}}
  snapshot():Snapshot{return {provider:this.provider,issue:this.issue,threadId:this.thread(),workspace:basename(this.workspace),readOnly:!this.workspaceId,runs:this.store.runs().filter(r=>r.workspaceId===this.workspaceId),lastSeq:this.store.lastSeq(),...(this.projects?{selectedWorkspaceId:this.workspaceId??null,projects:this.projects.list(),workspaces:this.projects.workspaces()}:{})};}
  private thread(){return this.store.getThread(this.workspaceId);}
  private validate(){if(this.workspaceId)this.projects!.writable(this.workspaceId);else assertWorkspace(this.workspace);}
  private idle(){if(this.active())throw new AppError('RUN_ACTIVE');if(this.connecting||this.switching)throw new AppError('SESSION_BUSY');}
  registerProject(path:string){this.idle();if(!this.projects)throw new AppError('UNSUPPORTED',404);return this.projects.register(path);}
  createWorktree(projectId:string){this.idle();if(!this.projects)throw new AppError('UNSUPPORTED',404);return this.projects.create(projectId);}
  workspaceDiff(id:string){if(!this.projects)throw new AppError('UNSUPPORTED',404);return this.projects.diff(id);}
  async selectWorkspace(id:string){
    this.idle();if(!this.projects)throw new AppError('UNSUPPORTED',404);const w=this.projects.validate(id);this.switching=true;
    try{await this.close();this.workspaceId=id;this.workspace=w.path;this.store.setMeta('selectedWorkspace',id);this.status('disconnected');this.store.append('workspace.selected',null,{workspaceId:id});}
    finally{this.switching=false;}
  }
  private approvalPolicy(){return this.workspaceId?'on-request':'untrusted';}
  private sandbox(){return this.workspaceId?{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false};}
  private status(status:ProviderStatus,issue:string|null=null){this.provider=status;this.issue=issue;this.store.append('provider.status',null,{status,issue});}
  private active():Run|undefined{return this.store.runs().find(r=>!terminal(r.execution));}
  async connect():Promise<void>{
    if(this.switching)throw new AppError('SESSION_BUSY');
    if(this.connecting)return this.connecting;if(this.provider==='ready')return;
    this.connecting=this.open().finally(()=>{this.connecting=null;});return this.connecting;
  }
  private async open(){
    this.status('connecting');const generation=++this.generation;
    try{
      this.validate();const rpc=this.factory(this.workspace,!!this.workspaceId);this.rpc=rpc;
      rpc.on('closed',()=>{if(generation!==this.generation)return;this.rpc=null;this.loseActive();this.status('disconnected','TRANSPORT_CLOSED');});
      rpc.on('notification',(e:any)=>{if(generation===this.generation)this.onEvent(e);});
      rpc.on('approval',(e:any)=>{if(generation===this.generation)this.store.append('approval.denied',this.active()?.id??null,{kind:e.method,decision:'deny'});});
      await rpc.initialize();const a=await rpc.request('account/read',{refreshToken:false});
      if(a.account?.type!=='chatgpt')throw new AppError('CHATGPT_LOGIN_REQUIRED');
      // Read effective names before loading any thread: a threadless MCP inventory
      // can itself start user MCPs. Never persist or expose this config response.
      let config:{mcp_servers:Record<string,{enabled:false}>;sandbox_workspace_write?:Record<string,unknown>};
      try{
        const result=await rpc.request('config/read',{includeLayers:false,cwd:this.workspace});
        if(!result?.config||typeof result.config!=='object'||Array.isArray(result.config))throw new Error();
        const servers=result.config.mcp_servers??{};
        if(typeof servers!=='object'||Array.isArray(servers))throw new Error();
        config={mcp_servers:Object.fromEntries(Object.keys(servers).map(name=>[name,{enabled:false as const}]))};
      }catch{throw new Error('MCP_ISOLATION_REQUIRED');}
      if(this.workspaceId)config.sandbox_workspace_write={writable_roots:[],network_access:false,exclude_tmpdir_env_var:true,exclude_slash_tmp:true};
      const id=this.thread();
      const params={cwd:this.workspace,config,sandbox:this.workspaceId?'workspace-write':'read-only',approvalPolicy:this.approvalPolicy(),approvalsReviewer:'user',developerInstructions:this.workspaceId?'Orbit isolated coding workspace. Edit ordinary source files only within the current worktree using apply_patch. Do not access other projects, credentials, user settings, network, .git, .codex, .agents, or links. Do not run shell commands, install software, commit, checkout, merge, or delete the workspace. Approval requests are denied. Report inability honestly; completion is not verification.':'This is a read-only text-only test session. Do not use tools, access files, credentials, network, or other projects. Answer only from user-provided text.'};
      const t=await rpc.request(id?'thread/resume':'thread/start',id?{...params,threadId:id,excludeTurns:true}:params);
      if(typeof t.thread?.id!=='string' || (id && t.thread.id!==id))throw new Error('THREAD_MISMATCH');
      if(t.sandbox?.type!==this.sandbox().type||t.sandbox.networkAccess!==false||t.approvalPolicy!==this.approvalPolicy()||t.approvalsReviewer!=='user')throw new Error('POLICY_MISMATCH');
      if(this.workspaceId&&(!Array.isArray(t.sandbox.writableRoots)||t.sandbox.writableRoots.length!==0||t.sandbox.excludeTmpdirEnvVar!==true||t.sandbox.excludeSlashTmp!==true))throw new Error('POLICY_MISMATCH');
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
      this.store.setThread(t.thread.id,this.workspaceId);this.status('ready');this.store.append(id?'session.resumed':'session.created',null,{threadId:t.thread.id,workspaceId:this.workspaceId??null});
    }catch(e){
      const code=e instanceof Error?e.message:'';
      const issue=['CODEX_NOT_INSTALLED','CHATGPT_LOGIN_REQUIRED','POLICY_MISMATCH','THREAD_STILL_ACTIVE','MCP_ISOLATION_REQUIRED','WRITES_DISABLED','WORKSPACE_CHANGED','LINK_REJECTED'].includes(code)?code:'CONNECTION_FAILED';
      const rpc=this.rpc;this.rpc=null;++this.generation;if(rpc)await rpc.close();
      this.status(issue==='CODEX_NOT_INSTALLED'?'not_installed':issue==='CHATGPT_LOGIN_REQUIRED'?'auth_required':'error',issue);throw new AppError(issue,503);
    }
  }
  async submit(input:{requestId:string;prompt:string;workspaceId?:string|null}):Promise<Run>{
    if(typeof input?.requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>4000)throw new AppError('INVALID_PROMPT',400);
    if(containsCredential(input.prompt))throw new AppError('CREDENTIAL_LIKE_INPUT',400);
    if(this.projects&&(input.workspaceId===undefined||input.workspaceId!==(this.workspaceId??null)))throw new AppError('WORKSPACE_MISMATCH');
    const digest=createHash('sha256').update(input.prompt).digest('hex');const prior=this.store.findRequest(input.requestId);
    if(prior){if(prior.digest!==digest||prior.run.workspaceId!==this.workspaceId)throw new AppError('IDEMPOTENCY_CONFLICT');return prior.run;}
    if(this.provider!=='ready'||!this.rpc)throw new AppError('NOT_CONNECTED');
    if(this.switching)throw new AppError('SESSION_BUSY');if(this.active())throw new AppError('RUN_ACTIVE');this.validate();
    const run=this.store.createRun(input.requestId,digest,safeText(input.prompt),this.workspaceId);const rpc=this.rpc;
    this.output.clear();this.deadline=setTimeout(()=>{void this.failTransport('RUN_TIMEOUT');},120000);
    try{
      const result=await rpc.request('turn/start',{threadId:this.thread(),cwd:this.workspace,input:[{type:'text',text:input.prompt}],sandboxPolicy:this.sandbox(),approvalPolicy:this.approvalPolicy(),approvalsReviewer:'user'});
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
    const run=this.store.getRun(id);if(!run||run.workspaceId!==this.workspaceId)throw new AppError('RUN_NOT_FOUND',404);
    if(terminal(run.execution)||run.execution==='interrupting')return;
    if(!run.turnId||!this.rpc)throw new AppError('TURN_NOT_READY');
    this.store.updateRun(id,{execution:'interrupting'},'interrupt.requested');const rpc=this.rpc;
    try{await rpc.request('turn/interrupt',{threadId:this.thread(),turnId:run.turnId});this.store.append('interrupt.accepted',id,{});}
    catch{
      if(terminal(this.store.getRun(id)!.execution))return;
      if(this.rpc===rpc&&this.active()?.id===id)await this.failTransport('INTERRUPT_UNCERTAIN');
      throw new AppError('INTERRUPT_UNCERTAIN',503);
    }
  }
  private onEvent(e:any){
    const p=e.params;if(!p||p.threadId!==this.thread())return;
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
    if(e.method==='item/completed'&&p.item?.type==='fileChange')this.store.append('workspace.changed',r.id,{workspaceId:this.workspaceId??null,status:['completed','failed','declined'].includes(p.item.status)?p.item.status:'unknown'});
    if(e.method==='error')this.store.append('provider.error',r.id,{retrying:p.willRetry===true});
  }
  private clearDeadline(){if(this.deadline)clearTimeout(this.deadline);this.deadline=null;}
  private loseActive(){this.clearDeadline();const r=this.active();if(r)this.store.updateRun(r.id,{execution:'lost'},'run.lost');}
  private async failTransport(issue:string){this.loseActive();const rpc=this.rpc;this.rpc=null;++this.generation;this.status('error',issue);if(rpc)await rpc.close();}
  async close(){this.loseActive();const rpc=this.rpc;this.rpc=null;++this.generation;if(rpc)await rpc.close();this.provider='disconnected';}
}
