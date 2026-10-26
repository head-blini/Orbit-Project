import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Snapshot, ProviderStatus, Run, Execution } from '../shared/types.ts';
import { terminal } from '../shared/types.ts';
import { Store } from './store.ts';
import { assertWorkspace } from './workspace.ts';
import { safeText, safeTextItems, containsCredential } from './privacy.ts';
import type { RpcPort } from './rpc.ts';
import { AppError } from './errors.ts';
import { Projects } from './projects.ts';
import { evaluateLaunch,outboundDenial,providerConnections } from './providers/policy.ts';
import { Studio } from './studio.ts';
import { VerificationService,type VerificationConfiguration } from './verification-service.ts';
import { collectCodexUsage,unknownUsage } from './usage.ts';
import type { CodexUsage } from '../shared/usage.ts';
import { SourceGraphService } from './source-graph-service.ts';
import { ModelHubService } from './model-hub-service.ts';
import type { ModelHubConfiguration } from './providers/model-hub-configuration.ts';
import { MergeService } from './merge-service.ts';
import { WorkflowService } from './workflow-service.ts';
import { ReviewService } from './review-service.ts';
import { PlanningAgentService } from './planning-agent-service.ts';
import { collectExtensions,unknownExtensions } from './extensions.ts';
import type { ExtensionInventory } from '../shared/extensions.ts';
import {projectAnalytics} from './project-analytics.ts';
import {RunTelemetry} from './run-telemetry.ts';
export { AppError } from './errors.ts';
export class Controller {
  store:Store;workspace:string;private factory:(workspace:string,write:boolean)=>RpcPort;private rpc:RpcPort|null=null;
  private projects?:Projects;private workspaceId?:string;private switching=false;
  private provider:ProviderStatus='disconnected';private issue:string|null=null;private connecting:Promise<void>|null=null;
  private generation=0;private output=new Map<string,string>();private deadline:NodeJS.Timeout|null=null;private launchValidated=false;
  readonly verification:VerificationService;
  readonly sourceGraphs:SourceGraphService;
  readonly modelHub:ModelHubService;
  readonly merges:MergeService;
  readonly workflows:WorkflowService;
  readonly reviews:ReviewService;
  readonly planningSuggestions:PlanningAgentService;
  private usage:CodexUsage=unknownUsage();private usagePending:Promise<CodexUsage>|null=null;
  private extensionCache:ExtensionInventory|null=null;private extensionPending:Promise<ExtensionInventory>|null=null;
  private knownMcpNames:readonly string[]|null=null;
  private telemetry:RunTelemetry;
  constructor(store:Store,workspace:string,factory:(workspace:string,write:boolean)=>RpcPort,projects?:Projects,verificationConfig:VerificationConfiguration[]=[],modelHubConfig:readonly ModelHubConfiguration[]=[]){
    this.store=store;this.workspace=workspace;this.factory=factory;this.projects=projects;
    this.telemetry=new RunTelemetry(metrics=>this.store.saveRunMetrics(metrics));
    const selected=projects?.workspaces().find(w=>w.id===store.getMeta('selectedWorkspace'));if(selected){this.workspaceId=selected.id;this.workspace=selected.path;}
    this.modelHub=new ModelHubService(store,modelHubConfig);
    this.verification=new VerificationService(store,projects,verificationConfig,()=>!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||!!this.workflows?.active||!!this.reviews?.active||!!this.planningSuggestions?.active);
    this.sourceGraphs=new SourceGraphService(store,projects);
    this.merges=new MergeService(store,projects,this.verification,()=>!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||!!this.workflows?.active||!!this.reviews?.active||!!this.planningSuggestions?.active);
    this.workflows=new WorkflowService(store,projects,verificationConfig,()=>!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||this.verification.active||this.merges.active||!!this.reviews?.active||!!this.planningSuggestions?.active,id=>{this.merges.ensureAvailable(id);this.verification.ensureAvailable(id);this.planningSuggestions.ensureAvailable(id);this.reviews.ensureAvailable(id);});
    this.reviews=new ReviewService(store,projects,factory,()=>!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||this.verification.active||this.merges.active||this.workflows.active||!!this.planningSuggestions?.active,id=>{this.planningSuggestions.ensureAvailable(id);this.merges.ensureAvailable(id);this.verification.ensureAvailable(id);this.workflows.ensureAvailable(id);});
    this.planningSuggestions=new PlanningAgentService(store,projects,factory,()=>!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||this.verification.active||this.merges.active||this.workflows.active||this.reviews.active,id=>{this.merges.ensureAvailable(id);this.verification.ensureAvailable(id);this.workflows.ensureAvailable(id);this.reviews.ensureAvailable(id);});
  }
  snapshot():Snapshot{return {provider:this.provider,issue:this.issue,threadId:this.thread(),workspace:basename(this.workspace),readOnly:!this.workspaceId,runs:this.store.runs().filter(r=>r.workspaceId===this.workspaceId),lastSeq:this.store.lastSeq(),connections:providerConnections,externalApiEnabled:this.modelHub.externalEnabled,modelHubConfigured:this.modelHub.configured,modelHubBusy:this.modelHub.active,extensionBusy:!!this.extensionPending,verificationBusy:this.verification.active,mergeBusy:this.merges.active,workflowBusy:this.workflows.active,reviewBusy:this.reviews.active,planningBusy:this.planningSuggestions.active,...(this.projects?{selectedWorkspaceId:this.workspaceId??null,projects:this.projects.list(),workspaces:this.projects.workspaces()}:{})};}
  private thread(){return this.store.getThread(this.workspaceId);}
  private validate(){this.planningSuggestions.ensureAvailable(this.workspaceId);this.workflows.ensureAvailable(this.workspaceId);this.merges.ensureAvailable(this.workspaceId);this.verification.ensureAvailable(this.workspaceId);if(this.workspaceId)this.projects!.writable(this.workspaceId);else assertWorkspace(this.workspace);}
  private idle(){this.extensionIdle();this.planningSuggestions.ensureAvailable(this.workspaceId);this.reviews.ensureAvailable(this.workspaceId);this.workflows.ensureAvailable();this.merges.ensureAvailable();this.verification.ensureAvailable();if(this.modelHub.active)throw new AppError('MODEL_REQUEST_ACTIVE');if(this.active())throw new AppError('RUN_ACTIVE');if(this.connecting||this.switching)throw new AppError('SESSION_BUSY');}
  startModelRequest(input:Parameters<ModelHubService['start']>[0]){this.extensionIdle();this.planningSuggestions.ensureAvailable(this.workspaceId);this.reviews.ensureAvailable(this.workspaceId);this.workflows.ensureAvailable();this.merges.ensureAvailable();this.verification.ensureAvailable();if(this.active())throw new AppError('RUN_ACTIVE');if(this.connecting||this.switching)throw new AppError('SESSION_BUSY');return this.modelHub.start(input);}
  registerProject(path:string){this.idle();if(!this.projects)throw new AppError('UNSUPPORTED',404);return this.projects.register(path);}
  createWorktree(projectId:string){this.idle();this.merges.ensureProjectAvailable(projectId);if(!this.projects)throw new AppError('UNSUPPORTED',404);return this.projects.create(projectId);}
  workspaceDiff(id:string){if(!this.projects)throw new AppError('UNSUPPORTED',404);return this.projects.diff(id);}
  analyzeSourceGraph(id:string){this.idle();if(id!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.sourceGraphs.analyze(id);}
  sourceGraphArtifact(id:string,input:Parameters<SourceGraphService['artifact']>[1]){this.idle();if(id!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.sourceGraphs.artifact(id,input);}
  startVerification(input:Parameters<VerificationService['start']>[0]){this.extensionIdle();
    this.planningSuggestions.ensureAvailable(input.workspaceId);this.reviews.ensureAvailable(input.workspaceId);
    this.workflows.ensureAvailable(input.workspaceId);
    this.merges.ensureAvailable(input.workspaceId);
    if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
    return this.verification.start(input);
  }
  approveVerification(input:Parameters<VerificationService['approve']>[0]){this.extensionIdle();
    this.planningSuggestions.ensureAvailable(input.workspaceId);this.reviews.ensureAvailable(input.workspaceId);
    this.workflows.ensureAvailable(input.workspaceId);
    this.merges.ensureAvailable(input.workspaceId);
    if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
    return this.verification.approve(input);
  }
  prepareMerge(input:Parameters<MergeService['prepare']>[0]){this.extensionIdle();
    this.planningSuggestions.ensureAvailable(input.workspaceId);this.reviews.ensureAvailable(input.workspaceId);
    this.workflows.ensureAvailable(input.workspaceId);
    if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
    return this.merges.prepare(input);
  }
  applyMerge(input:Parameters<MergeService['apply']>[0]){this.extensionIdle();
    this.planningSuggestions.ensureAvailable(this.merges.record(input.recordId).workspaceId);this.reviews.ensureAvailable(this.merges.record(input.recordId).workspaceId);
    this.workflows.ensureAvailable(this.merges.record(input.recordId).workspaceId);
    if(this.merges.record(input.recordId).workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
    return this.merges.apply(input);
  }
  recoverMerge(input:Parameters<MergeService['recover']>[0]){this.extensionIdle();this.planningSuggestions.ensureAvailable(this.workspaceId);
    this.workflows.ensureAvailable();
    if(this.merges.record(input.recordId).workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
    return this.merges.recover(input);
  }
  usageSnapshot():CodexUsage{return structuredClone(this.provider==='ready'?this.usage:unknownUsage());}
  projectAnalytics(projectId:string,options:{limit?:number;cursor?:string}={}){return projectAnalytics(this.store,projectId,options,id=>this.planningSuggestions.analyticsOverlay(id));}
  extensionSnapshot():ExtensionInventory {
    return structuredClone(this.provider==='ready'&&this.extensionCache?.workspaceId===(this.workspaceId??null)?this.extensionCache:unknownExtensions(this.workspaceId??null));
  }
  private extensionIdle(){if(this.extensionPending)throw new AppError('EXTENSION_QUERY_ACTIVE',409);}
  private clearExtensions(){
    const pending=this.extensionPending;this.extensionCache=null;this.knownMcpNames=null;this.extensionPending=null;
    if(pending)this.store.append('extensions.updated',null,{workspaceId:this.workspaceId??null,busy:false});
  }
  refreshExtensions(input:{workspaceId:string|null}):Promise<ExtensionInventory>{
    if(!input||Object.keys(input).join(',')!=='workspaceId'||(input.workspaceId!==null&&(typeof input.workspaceId!=='string'||!/^[a-f0-9-]{36}$/.test(input.workspaceId))))throw new AppError('INVALID_FIELDS',400);
    if(input.workspaceId!==(this.workspaceId??null))throw new AppError('WORKSPACE_MISMATCH',409);
    if(this.provider!=='ready'||!this.rpc||!this.launchValidated||!this.thread()||this.knownMcpNames===null)throw new AppError('NOT_CONNECTED',409);
    if(this.extensionPending)return this.extensionPending;
    this.idle();
    const checked=this.extensionCache?.checkedAt;
    if(checked&&Date.now()-Date.parse(checked)>=0&&Date.now()-Date.parse(checked)<60000)return Promise.resolve(this.extensionSnapshot());
    const rpc=this.rpc,generation=this.generation,workspaceId=this.workspaceId??null;
    const current=()=>generation===this.generation&&rpc===this.rpc&&this.provider==='ready';
    const pending=collectExtensions((method,params)=>{if(!current())return Promise.reject(new Error('STALE_SESSION'));return rpc.request(method,params);},
      {workspaceId,workspacePath:this.workspace,threadId:this.thread()!,knownMcpNames:this.knownMcpNames}).then(report=>{
      if(!current())return unknownExtensions(workspaceId);
      this.extensionCache=report;return this.extensionSnapshot();
    }).catch(async()=>{
      if(!current())return unknownExtensions(workspaceId);
      await this.failTransport('MCP_ISOLATION_REQUIRED');throw new AppError('MCP_ISOLATION_REQUIRED',503);
    }).finally(()=>{
      if(this.extensionPending===pending){this.extensionPending=null;this.store.append('extensions.updated',null,{workspaceId,busy:false});}
    });
    this.extensionPending=pending;this.store.append('extensions.updated',null,{workspaceId,busy:true});return pending;
  }
  startWorkflow(input:Parameters<WorkflowService['start']>[0]){this.extensionIdle();if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.workflows.start(input);}
  interruptWorkflow(workspaceId:string,runId:string){if(workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.workflows.interrupt(workspaceId,runId);}
  recoverWorkflow(input:Parameters<WorkflowService['recover']>[0]){this.extensionIdle();this.planningSuggestions.ensureAvailable(this.workspaceId);if(this.workflows.record(input.runId).workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.workflows.recover(input);}
  startReview(input:Parameters<ReviewService['start']>[0]){this.extensionIdle();if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.reviews.start(input);}
  interruptReview(workspaceId:string,reviewId:string){if(workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.reviews.interrupt(workspaceId,reviewId);}
  recoverReview(input:Parameters<ReviewService['recover']>[0]){this.extensionIdle();this.planningSuggestions.ensureAvailable(this.workspaceId);if(this.reviews.record(input.reviewId).workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.reviews.recover(input);}
  previewPlanning(projectId:string,input:Parameters<PlanningAgentService['preview']>[1]){this.extensionIdle();if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.planningSuggestions.preview(projectId,input);}
  startPlanning(projectId:string,input:Parameters<PlanningAgentService['start']>[1]){this.extensionIdle();if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.planningSuggestions.start(projectId,input);}
  interruptPlanning(projectId:string,id:string,workspaceId:string){if(workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.planningSuggestions.interrupt(projectId,id,workspaceId);}
  recoverPlanning(projectId:string,input:Parameters<PlanningAgentService['recover']>[1]){if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.planningSuggestions.recover(projectId,input);}
  savePlanningDraft(projectId:string,id:string,input:Parameters<PlanningAgentService['saveDraft']>[2]){if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.planningSuggestions.saveDraft(projectId,id,input);}
  refreshUsage():Promise<CodexUsage>{
    if(this.provider!=='ready'||!this.rpc)throw new AppError('NOT_CONNECTED',409);
    if(this.usagePending)return this.usagePending;
    if(this.usage.checkedAt&&Date.now()-Date.parse(this.usage.checkedAt)>=0&&Date.now()-Date.parse(this.usage.checkedAt)<60000)return Promise.resolve(this.usageSnapshot());
    const rpc=this.rpc,generation=this.generation;
    this.usagePending=collectCodexUsage((method,params)=>rpc.request(method,params)).then(report=>{
      if(generation!==this.generation||rpc!==this.rpc||this.provider!=='ready')return unknownUsage();
      this.usage=report;return this.usageSnapshot();
    }).finally(()=>{this.usagePending=null;});
    return this.usagePending;
  }
  async selectWorkspace(id:string){
    this.idle();if(!this.projects)throw new AppError('UNSUPPORTED',404);const w=this.projects.validate(id);this.switching=true;
    try{await this.close();this.workspaceId=id;this.workspace=w.path;this.store.setMeta('selectedWorkspace',id);this.status('disconnected');this.store.append('workspace.selected',null,{workspaceId:id});}
    finally{this.switching=false;}
  }
  private approvalPolicy(){return this.workspaceId?'on-request':'untrusted';}
  private sandbox(){return this.workspaceId?{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false};}
  private status(status:ProviderStatus,issue:string|null=null){this.provider=status;this.issue=issue;if(status!=='ready'){this.clearExtensions();this.launchValidated=false;this.usage=unknownUsage();}this.store.append('provider.status',null,{status,issue});}
  private active():Run|undefined{return this.store.runs().find(r=>!terminal(r.execution));}
  async connect():Promise<void>{
    this.extensionIdle();
    this.planningSuggestions.ensureAvailable(this.workspaceId);this.reviews.ensureAvailable(this.workspaceId);
    if(this.modelHub.active)throw new AppError('MODEL_REQUEST_ACTIVE');
    this.verification.ensureAvailable(this.workspaceId);
    if(this.switching)throw new AppError('SESSION_BUSY');
    if(this.connecting)return this.connecting;if(this.provider==='ready')return;
    this.connecting=this.open().finally(()=>{this.connecting=null;});return this.connecting;
  }
  private async open(){
    this.status('connecting');const generation=++this.generation;
    try{
      this.validate();const rpc=this.factory(this.workspace,!!this.workspaceId);this.rpc=rpc;
      rpc.on('closed',()=>{if(generation!==this.generation)return;this.rpc=null;this.loseActive();this.telemetry.disconnect();this.status('disconnected','TRANSPORT_CLOSED');});
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
        const configured=result.config.mcp_servers,servers=configured===undefined?{}:configured;
        if(!servers||typeof servers!=='object'||Array.isArray(servers))throw new Error();
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
      this.telemetry.connect(t.thread.id,t.model,t.modelProvider);
      this.knownMcpNames=Object.freeze(Object.keys(config.mcp_servers));this.launchValidated=true;this.store.setThread(t.thread.id,this.workspaceId);this.status('ready');this.store.append(id?'session.resumed':'session.created',null,{threadId:t.thread.id,workspaceId:this.workspaceId??null});
    }catch(e){
      const code=e instanceof Error?e.message:'';
      const issue=['CODEX_NOT_INSTALLED','CHATGPT_LOGIN_REQUIRED','POLICY_MISMATCH','THREAD_STILL_ACTIVE','MCP_ISOLATION_REQUIRED','WRITES_DISABLED','WORKSPACE_CHANGED','LINK_REJECTED'].includes(code)?code:'CONNECTION_FAILED';
      const rpc=this.rpc;this.rpc=null;++this.generation;if(rpc)await rpc.close();
      this.status(issue==='CODEX_NOT_INSTALLED'?'not_installed':issue==='CHATGPT_LOGIN_REQUIRED'?'auth_required':'error',issue);throw new AppError(issue,503);
    }
  }
  async submitTask(projectId:string,taskId:string,input:{requestId:string;workspaceId:string}):Promise<Run>{
    if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId))throw new AppError('INVALID_REQUEST_ID',400);
    const workspace=this.projects?.workspaces().find(workspace=>workspace.id===input.workspaceId);
    if(!workspace||workspace.id!==this.workspaceId||workspace.projectId!==projectId)throw new AppError('WORKSPACE_MISMATCH');
    const prior=this.store.findRequest(input.requestId);
    if(prior){if(prior.run.taskId!==taskId||prior.run.workspaceId!==workspace.id)throw new AppError('IDEMPOTENCY_CONFLICT');return prior.run;}
    const {prompt,...task}=new Studio(this.store).execution(projectId,taskId);
    return this.start({...input,prompt},task);
  }
  async submit(input:{requestId:string;prompt:string;workspaceId?:string|null}):Promise<Run>{return this.start(input);}
  private async start(input:{requestId:string;prompt:string;workspaceId?:string|null},task?:Pick<Run,'taskId'|'planningVersionId'|'requirementLabels'>):Promise<Run>{
    if(typeof input?.requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>4000)throw new AppError('INVALID_PROMPT',400);
    if(containsCredential(input.prompt))throw new AppError('CREDENTIAL_LIKE_INPUT',400);
    const denial=outboundDenial(input.prompt);
    if(denial){this.store.append('guardrail.denied',null,{providerId:'codex',code:denial});throw new AppError(denial,400);}
    if(this.projects&&(input.workspaceId===undefined||input.workspaceId!==(this.workspaceId??null)))throw new AppError('WORKSPACE_MISMATCH');
    const digest=createHash('sha256').update(input.prompt).digest('hex');const prior=this.store.findRequest(input.requestId);
    if(prior){if(prior.digest!==digest||prior.run.workspaceId!==this.workspaceId||prior.run.taskId!==task?.taskId)throw new AppError('IDEMPOTENCY_CONFLICT');return prior.run;}
    this.extensionIdle();if(this.provider!=='ready'||!this.rpc)throw new AppError('NOT_CONNECTED');
    this.planningSuggestions.ensureAvailable(this.workspaceId);this.reviews.ensureAvailable(this.workspaceId);
    if(this.modelHub.active)throw new AppError('MODEL_REQUEST_ACTIVE');
    if(this.switching)throw new AppError('SESSION_BUSY');if(this.active())throw new AppError('RUN_ACTIVE');this.validate();
    const launch=evaluateLaunch({provider:{id:'codex',status:'ready',capabilities:{patch:!!this.workspaceId,shell:false,approvals:'deny',mcp:'disabled'}},
      expectedWorkspaceId:input.workspaceId??null,selectedWorkspaceId:this.workspaceId??null,workspaceValidated:true,writeEnabled:!!this.workspaceId,
      policyValidated:this.launchValidated,mcpIsolated:this.launchValidated});
    if(!launch.allowed)throw new AppError(launch.code);
    const run=this.store.createRun(input.requestId,digest,safeText(input.prompt),this.workspaceId,task);const rpc=this.rpc;
    this.telemetry.begin(run.id);
    this.output.clear();this.deadline=setTimeout(()=>{void this.failTransport('RUN_TIMEOUT');},120000);
    try{
      const result=await rpc.request('turn/start',{threadId:this.thread(),cwd:this.workspace,input:[{type:'text',text:input.prompt}],sandboxPolicy:this.sandbox(),approvalPolicy:this.approvalPolicy(),approvalsReviewer:'user'});
      if(typeof result.turn?.id!=='string')throw new Error('INVALID_TURN');
      this.telemetry.acknowledge(run.id,result.turn.id);
      this.store.updateRun(run.id,{turnId:result.turn.id,execution:this.store.getRun(run.id)?.execution==='interrupting'?'interrupting':'running'},'run.accepted');
      const accepted=this.store.getRun(run.id)!;
      if(terminal(accepted.execution))this.telemetry.finish(run.id,accepted.execution==='lost'||accepted.turnId!==result.turn.id);
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
    this.telemetry.event(e);
    const p=e.params;if(!p||p.threadId!==this.thread())return;
    const r=this.active();if(!r)return;const turnId=p.turn?.id??p.turnId;
    if(r.turnId&&turnId&&r.turnId!==turnId)return;
    if(e.method==='turn/started' && typeof p.turn?.id==='string')this.store.updateRun(r.id,{turnId:p.turn.id,execution:r.execution==='interrupting'?'interrupting':'running'},'run.started');
    if(e.method==='item/agentMessage/delta' && typeof p.delta==='string'){
      const key=typeof p.itemId==='string'?p.itemId:'message';this.output.set(key,((this.output.get(key)??'')+p.delta).slice(0,64000));
      this.store.updateRun(r.id,{response:this.safeOutput(false)},'message.updated');
    }
    if(e.method==='item/completed' && p.item?.type==='agentMessage' && typeof p.item.text==='string'){
      this.output.set(p.item.id??'message',p.item.text.slice(0,64000));
      this.store.updateRun(r.id,{response:this.safeOutput(false)},'message.updated');
    }
    if(e.method==='turn/completed'){
      const execution:Execution=['completed','interrupted','failed'].includes(p.turn?.status)?p.turn.status:'failed';
      this.store.updateRun(r.id,{execution,response:this.safeOutput(true),...(typeof turnId==='string'?{turnId}:{})},'run.'+execution);this.clearDeadline();
      this.telemetry.finish(r.id);
    }
    if(e.method==='item/completed'&&p.item?.type==='fileChange')this.store.append('workspace.changed',r.id,{workspaceId:this.workspaceId??null,status:['completed','failed','declined'].includes(p.item.status)?p.item.status:'unknown'});
    if(e.method==='error')this.store.append('provider.error',r.id,{retrying:p.willRetry===true});
  }
  private safeOutput(final:boolean){
    // Every interleaved item can have an unfinished credential. Withhold each
    // item's tail until the turn ends; completing another item must not flush it.
    return safeTextItems([...this.output.values()],final);
  }
  private clearDeadline(){if(this.deadline)clearTimeout(this.deadline);this.deadline=null;}
  private loseActive(){this.clearDeadline();const r=this.active();if(r){this.store.updateRun(r.id,{execution:'lost'},'run.lost');this.telemetry.finish(r.id,true);}}
  private async failTransport(issue:string){this.loseActive();this.telemetry.disconnect();const rpc=this.rpc;this.rpc=null;++this.generation;this.status('error',issue);if(rpc)await rpc.close();}
  async close(){await this.planningSuggestions.close();await this.reviews.close();await this.workflows.close();await this.modelHub.close();await this.verification.close();this.loseActive();this.telemetry.disconnect();const rpc=this.rpc;this.rpc=null;++this.generation;if(rpc)await rpc.close();this.provider='disconnected';this.launchValidated=false;this.clearExtensions();}
}
