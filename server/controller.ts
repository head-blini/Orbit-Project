import { createHash,randomUUID } from 'node:crypto';
import {NativeLaunchNotStarted} from './native-launch-error.ts';
import { basename } from 'node:path';
import type { Snapshot, ProviderStatus, Run, Execution } from '../shared/types.ts';
import { terminal } from '../shared/types.ts';
import { Store } from './store.ts';
import { assertWorkspace } from './workspace.ts';
import { safeText, safeTextItems, containsCredential } from './privacy.ts';
import type { RpcPort } from './rpc.ts';
import { AppError } from './errors.ts';
import { Projects,assertGitProject } from './projects.ts';
import { evaluateLaunch,outboundDenial,providerConnections } from './providers/policy.ts';
import { Studio } from './studio.ts';
import type { SavedTask } from '../shared/parallel.ts';
import { VerificationService,type VerificationConfiguration } from './verification-service.ts';
import {VerificationSetupService} from './verification-setup.ts';
import type {TaskVerificationPreview} from '../shared/acceptance.ts';
import { collectCodexUsage,unknownUsage } from './usage.ts';
import type { CodexUsage } from '../shared/usage.ts';
import { SourceGraphService } from './source-graph-service.ts';
import { ModelHubService } from './model-hub-service.ts';
import type { ModelHubConfiguration } from './providers/model-hub-configuration.ts';
import { MergeService } from './merge-service.ts';
import { WorkflowService } from './workflow-service.ts';
import { ReviewService } from './review-service.ts';
import { PlanningAgentService } from './planning-agent-service.ts';
import {ProjectAiPreferencesService} from './project-ai-preferences.ts';
import type {ClaudePlanningOptions} from './claude-planning.ts';
import { collectExtensions,unknownExtensions } from './extensions.ts';
import type { ExtensionInventory } from '../shared/extensions.ts';
import {projectAnalytics} from './project-analytics.ts';
import {RunTelemetry} from './run-telemetry.ts';
import {CodexModelTracker} from './codex-model-attribution.ts';
import {getDevelopmentResult} from './development-results.ts';
import {staticAppPreviewCapability} from './app-preview-policy.ts';
import {listDeliverables,previewDeliverable} from './deliverables.ts';
import {addMaterials,listMaterials} from './materials.ts';
import {ClaudeTaskService,type ClaudeTaskServiceOptions} from './claude-task-service.ts';
import {QualityLoopService} from './quality-loop-service.ts';
import {createQualityNativePorts,qualityRunEvidence,qualityVerifyGeneral,type QualityNativeOptions} from './quality-loop-native.ts';
import type {QualityServicePorts,QualityStepContext,QualityVerificationResult} from '../shared/quality-loop-record.ts';
export { AppError } from './errors.ts';
export class Controller {
  store:Store;workspace:string;private factory:(workspace:string,write:boolean)=>RpcPort;private rpc:RpcPort|null=null;
  private projects?:Projects;private workspaceId?:string;private switching=false;
  private provider:ProviderStatus='disconnected';private issue:string|null=null;private connecting:Promise<void>|null=null;
  private generation=0;private output=new Map<string,string>();private deadline:NodeJS.Timeout|null=null;private launchValidated=false;
  readonly qualityLoops:QualityLoopService;
  private qualityScope=false;
  private qualityPorts:QualityServicePorts;
  readonly verification:VerificationService;
  readonly sourceGraphs:SourceGraphService;
  readonly modelHub:ModelHubService;
  readonly merges:MergeService;
  readonly workflows:WorkflowService;
  private readonly verificationSetup:VerificationSetupService;
  readonly reviews:ReviewService;
  readonly planningSuggestions:PlanningAgentService;
  readonly aiPreferences:ProjectAiPreferencesService;
  private usage:CodexUsage=unknownUsage();private usagePending:Promise<CodexUsage>|null=null;
  private extensionCache:ExtensionInventory|null=null;private extensionPending:Promise<ExtensionInventory>|null=null;
  private knownMcpNames:readonly string[]|null=null;
  private telemetry:RunTelemetry;
  private modelTracker:CodexModelTracker;
  private soloLost=false;
  private claudeTasks:ClaudeTaskService;
  private readonly ownerIncarnation=randomUUID();
  private soloRecoveryRequired(){return this.soloLost||this.store.runs().some(run=>run.runtime!=='claude-code'&&run.execution==='lost');}
  private qualityBusy(){return !this.qualityScope&&!!this.qualityLoops&&(this.qualityLoops.active||this.qualityLoops.records().some(record=>record.recoveryRequired));}
  private qualityAvailable(){if(!this.qualityScope)this.qualityLoops?.ensureAvailable();}
  private ownQualityStep<T>(work:()=>T):T{const before=this.qualityScope;this.qualityScope=true;try{return work();}finally{this.qualityScope=before;}}
  assertExecutionAvailable(){this.qualityAvailable();if(this.soloRecoveryRequired())throw new AppError('SOLO_RECOVERY_REQUIRED',409);}
  constructor(store:Store,workspace:string,factory:(workspace:string,write:boolean)=>RpcPort,projects?:Projects,verificationConfig:VerificationConfiguration[]=[],modelHubConfig:readonly ModelHubConfiguration[]=[],claudeOptions:ClaudeTaskServiceOptions={},claudePlanningOptions:ClaudePlanningOptions={},qualityOptions:Pick<QualityNativeOptions,'findExecutable'|'claudeFactory'|'codexReview'>={}){
    this.store=store;this.workspace=workspace;this.factory=factory;this.projects=projects;
    this.claudeTasks=new ClaudeTaskService(store,projects,claudeOptions);
    this.aiPreferences=new ProjectAiPreferencesService(store);
    this.soloLost=store.unresolvedNativeConnections();
    this.telemetry=new RunTelemetry(metrics=>this.store.saveRunMetrics(metrics));
    this.modelTracker=new CodexModelTracker((runId,value)=>this.store.saveCodexModelAttribution(runId,value));
    const selected=projects?.workspaces().find(w=>w.id===store.getMeta('selectedWorkspace'));if(selected){this.workspaceId=selected.id;this.workspace=selected.path;}
    this.modelHub=new ModelHubService(store,modelHubConfig,undefined,undefined,()=>this.assertExecutionAvailable());
    this.verificationSetup=new VerificationSetupService(store,projects,verificationConfig);
    const commandResolver=(path:string)=>this.verificationSetup.commands(path);
    this.verification=new VerificationService(store,projects,commandResolver,()=>this.qualityBusy()||this.soloRecoveryRequired()||!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||!!this.workflows?.active||!!this.reviews?.active||!!this.planningSuggestions?.active);
    this.sourceGraphs=new SourceGraphService(store,projects);
    this.merges=new MergeService(store,projects,this.verification,()=>this.qualityBusy()||this.soloRecoveryRequired()||!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||!!this.workflows?.active||!!this.reviews?.active||!!this.planningSuggestions?.active);
    this.workflows=new WorkflowService(store,projects,commandResolver,()=>this.qualityBusy()||this.soloRecoveryRequired()||!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||this.verification.active||this.merges.active||!!this.reviews?.active||!!this.planningSuggestions?.active,id=>{this.merges.ensureAvailable(id);this.verification.ensureAvailable(id);this.planningSuggestions.ensureAvailable(id);this.reviews.ensureAvailable(id);});
    this.reviews=new ReviewService(store,projects,factory,()=>this.qualityBusy()||this.soloRecoveryRequired()||!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||this.verification.active||this.merges.active||this.workflows.active||!!this.planningSuggestions?.active,id=>{this.planningSuggestions.ensureAvailable(id);this.merges.ensureAvailable(id);this.verification.ensureAvailable(id);this.workflows.ensureAvailable(id);});
    this.planningSuggestions=new PlanningAgentService(store,projects,factory,projectId=>this.qualityBusy()||this.soloRecoveryRequired()||store.runs().some(run=>run.runtime==='claude-code'&&(!terminal(run.execution)||run.execution==='lost'&&run.projectId===projectId))||!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||this.verification.active||this.merges.active||this.workflows.active||this.reviews.active,id=>{this.merges.ensureAvailable(id);this.verification.ensureAvailable(id);this.workflows.ensureAvailable(id);this.reviews.ensureAvailable(id);},undefined,claudePlanningOptions);
    const unavailable=()=>{throw new AppError('QUALITY_PROJECT_REQUIRED',409);};
    this.qualityPorts=projects?createQualityNativePorts({store,projects,factory,...qualityOptions,guard:run=>this.guardQuality(run),repair:async(request,context)=>{try{const result=await this.repairQuality(request,context);this.saveQualityReceipt(context,{result,evidence:result.evidence});return result;}catch(error){if(context.sourceRun.runtime==='claude-code'&&!store.findRequest(context.stepId)){const failureIssue=error instanceof Error&&/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)?error.message:'QUALITY_REPAIR_NOT_STARTED';this.saveQualityReceipt(context,{failureIssue,processStopped:true});}throw error;}},verify:async context=>{const result=await this.verifyQuality(context);this.saveQualityReceipt(context,{result,evidence:null});return result;},recover:(step,context)=>this.recoverQuality(step,context)}):{guard:unavailable,snapshot:unavailable,review:unavailable,repair:unavailable,verify:unavailable};
    store.db.exec('CREATE TABLE IF NOT EXISTS quality_controller_receipts(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
    this.qualityLoops=new QualityLoopService(store,this.qualityPorts);
  }
  snapshot():Snapshot{return {soloRecoveryRequired:this.soloRecoveryRequired(),provider:this.provider,issue:this.issue,threadId:this.thread(),workspace:basename(this.workspace),readOnly:!this.workspaceId,runs:this.store.runs().filter(r=>r.workspaceId===this.workspaceId),lastSeq:this.store.lastSeq(),connections:providerConnections,externalApiEnabled:this.modelHub.externalEnabled,modelHubConfigured:this.modelHub.configured,modelHubBusy:this.modelHub.active,extensionBusy:!!this.extensionPending,verificationBusy:this.verification.active,mergeBusy:this.merges.active,workflowBusy:this.workflows.active,reviewBusy:this.reviews.active,planningBusy:this.planningSuggestions.active,...(this.projects?{projectCreationAvailable:this.projects.creationAvailable,selectedWorkspaceId:this.workspaceId??null,projects:this.projects.list(),workspaces:this.projects.workspaces()}:{})};}
  private thread(){return this.store.getThread(this.workspaceId);}
  private validate(){assertGitProject(this.store,this.workspaceId);this.assertExecutionAvailable();this.planningSuggestions.ensureAvailable(this.workspaceId);this.workflows.ensureAvailable(this.workspaceId);this.merges.ensureAvailable(this.workspaceId);this.verification.ensureAvailable(this.workspaceId);if(this.workspaceId)this.projects!.writable(this.workspaceId);else assertWorkspace(this.workspace);}
  private idle(){this.assertExecutionAvailable();this.extensionIdle();this.planningSuggestions.ensureAvailable(this.workspaceId);this.reviews.ensureAvailable(this.workspaceId);this.workflows.ensureAvailable();this.merges.ensureAvailable();this.verification.ensureAvailable();if(this.modelHub.active)throw new AppError('MODEL_REQUEST_ACTIVE');if(this.active())throw new AppError('RUN_ACTIVE');if(this.connecting||this.switching)throw new AppError('SESSION_BUSY');}
  startModelRequest(input:Parameters<ModelHubService['start']>[0]){this.extensionIdle();this.planningSuggestions.ensureAvailable(this.workspaceId);this.reviews.ensureAvailable(this.workspaceId);this.workflows.ensureAvailable();this.merges.ensureAvailable();this.verification.ensureAvailable();if(this.active())throw new AppError('RUN_ACTIVE');if(this.connecting||this.switching)throw new AppError('SESSION_BUSY');return this.modelHub.start(input);}
  registerProject(path:string){this.idle();if(!this.projects)throw new AppError('UNSUPPORTED',404);return this.projects.register(path);}
  createProject(input:Parameters<Projects['createProject']>[0]){this.idle();if(!this.projects)throw new AppError('PROJECT_CREATION_UNAVAILABLE',503);return this.projects.createProject(input);}
  createWorktree(projectId:string){this.idle();this.merges.ensureProjectAvailable(projectId);if(!this.projects)throw new AppError('UNSUPPORTED',404);return this.projects.create(projectId);}
  workspaceDiff(id:string){if(!this.projects)throw new AppError('UNSUPPORTED',404);return this.projects.diff(id);}
  appPreviewSnapshot(id:string){assertGitProject(this.store,id);if(!this.projects)throw new AppError('UNSUPPORTED',404);if(id!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.projects.snapshot(id);}
  assertAppPreviewAvailable(){this.idle();}
  developmentResult(workspaceId:string,runId:string|null){assertGitProject(this.store,workspaceId);if(!this.projects)throw new AppError('UNSUPPORTED',404);if(workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return getDevelopmentResult(this.store,this.projects,this.verification,workspaceId,runId);}
  analyzeSourceGraph(id:string){assertGitProject(this.store,id);this.idle();if(id!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.sourceGraphs.analyze(id);}
  sourceGraphArtifact(id:string,input:Parameters<SourceGraphService['artifact']>[1]){assertGitProject(this.store,id);this.idle();if(id!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.sourceGraphs.artifact(id,input);}
  verificationSetupView(id:string){assertGitProject(this.store,id);if(id!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.verificationSetup.view(id);}
  configureVerification(id:string,input:Parameters<VerificationSetupService['configure']>[1]){
    assertGitProject(this.store,id);
    this.idle();if(id!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
    if(!this.projects)throw new AppError('VERIFICATION_SETUP_UNAVAILABLE',404);
    const workspace=this.projects.writable(id);
    // Settings apply to every worktree in this project, including inactive ones.
    for(const related of this.projects.workspaces().filter(item=>item.projectId===workspace.projectId)){
      this.verification.ensureAvailable(related.id);this.workflows.ensureAvailable(related.id);this.merges.ensureAvailable(related.id);
      this.planningSuggestions.ensureAvailable(related.id);this.reviews.ensureAvailable(related.id);
    }
    return this.verificationSetup.configure(id,input);
  }
  startVerification(input:Parameters<VerificationService['start']>[0]){this.extensionIdle();
    assertGitProject(this.store,input.workspaceId);
    this.planningSuggestions.ensureAvailable(input.workspaceId);this.reviews.ensureAvailable(input.workspaceId);
    this.workflows.ensureAvailable(input.workspaceId);
    this.merges.ensureAvailable(input.workspaceId);
    if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
    return this.verification.start(input);
  }
  approveVerification(input:Parameters<VerificationService['approve']>[0]){this.extensionIdle();
    assertGitProject(this.store,input.workspaceId);
    this.planningSuggestions.ensureAvailable(input.workspaceId);this.reviews.ensureAvailable(input.workspaceId);
    this.workflows.ensureAvailable(input.workspaceId);
    this.merges.ensureAvailable(input.workspaceId);
    if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
    return this.verification.approve(input);
  }
  prepareMerge(input:Parameters<MergeService['prepare']>[0]){this.extensionIdle();
    assertGitProject(this.store,input.workspaceId);
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
  private extensionIdle(){this.qualityAvailable();if(this.extensionPending)throw new AppError('EXTENSION_QUERY_ACTIVE',409);}
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
  startWorkflow(input:Parameters<WorkflowService['start']>[0]){this.extensionIdle();assertGitProject(this.store,input.workspaceId);if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.workflows.start(input);}
  interruptWorkflow(workspaceId:string,runId:string){if(workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.workflows.interrupt(workspaceId,runId);}
  recoverWorkflow(input:Parameters<WorkflowService['recover']>[0]){this.extensionIdle();this.planningSuggestions.ensureAvailable(this.workspaceId);if(this.workflows.record(input.runId).workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.workflows.recover(input);}
  startReview(input:Parameters<ReviewService['start']>[0]){this.extensionIdle();assertGitProject(this.store,input.workspaceId);if(input.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.reviews.start(input);}
  interruptReview(workspaceId:string,reviewId:string){if(workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.reviews.interrupt(workspaceId,reviewId);}
  recoverReview(input:Parameters<ReviewService['recover']>[0]){this.extensionIdle();this.planningSuggestions.ensureAvailable(this.workspaceId);if(this.reviews.record(input.reviewId).workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);return this.reviews.recover(input);}
  private planningWorkspace(projectId:string,workspaceId?:string|null){
    if(this.store.projects().some(project=>project.id===projectId&&project.kind==='general')){
      if(workspaceId!==null&&workspaceId!==undefined)throw new AppError('GIT_REQUIRED',409);return;
    }
    assertGitProject(this.store,workspaceId);if(workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
  }
  previewPlanning(projectId:string,input:Parameters<PlanningAgentService['preview']>[1]){this.extensionIdle();this.planningWorkspace(projectId,input?.workspaceId);return this.planningSuggestions.preview(projectId,input);}
  startPlanning(projectId:string,input:Parameters<PlanningAgentService['start']>[1]){this.extensionIdle();this.planningWorkspace(projectId,input?.workspaceId);return this.planningSuggestions.start(projectId,input);}
  interruptPlanning(projectId:string,id:string,workspaceId?:string|null){this.planningWorkspace(projectId,workspaceId);return this.planningSuggestions.interrupt(projectId,id,workspaceId);}
  recoverPlanning(projectId:string,input:Parameters<PlanningAgentService['recover']>[1]){this.planningWorkspace(projectId,input?.workspaceId);return this.planningSuggestions.recover(projectId,input);}
  savePlanningDraft(projectId:string,id:string,input:Parameters<PlanningAgentService['saveDraft']>[2]){this.planningWorkspace(projectId,input?.workspaceId);return this.planningSuggestions.saveDraft(projectId,id,input);}
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
  private active():Run|undefined{return this.store.runs().find(r=>r.runtime!=='claude-code'&&!terminal(r.execution));}
  async connect():Promise<void>{
    assertGitProject(this.store,this.workspaceId);
    this.assertExecutionAvailable();this.extensionIdle();
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
      this.validate();
      this.store.beginNativeConnection(this.ownerIncarnation,generation);
      let rpc:RpcPort;
      try{rpc=this.factory(this.workspace,!!this.workspaceId);}catch(error){
        if(error instanceof NativeLaunchNotStarted){
          try{this.store.finishNativeConnectionJournal(this.ownerIncarnation,generation,error.reason);}catch{this.soloLost=true;throw new Error('STATE_PERSISTENCE_FAILED');}
        }else this.soloLost=true;
        throw error;
      }
      this.rpc=rpc;let observationFailed=false;
      const finishJournal=()=>{
        const record=this.store.nativeConnection(this.ownerIncarnation,generation);
        if(!observationFailed&&record?.transportClosedAt&&(!record.process||['closed','spawn_failed'].includes(record.process.state)))this.store.finishNativeConnectionJournal(this.ownerIncarnation,generation);
      };
      const recordProcess=()=>{const observed=rpc.processObservation?.();if(observed)this.store.observeNativeProcess(this.ownerIncarnation,generation,observed);finishJournal();};
      const observe=(record:()=>void)=>{
        try{record();}catch{observationFailed=true;this.soloLost=true;void this.failTransport('STATE_PERSISTENCE_FAILED');}
      };
      // Facts belong to this exact connection even after its UI/event generation is fenced.
      // An old child's late close must never be attributed to the current connection.
      rpc.on('process.observed',()=>observe(recordProcess));
      rpc.on('closed',()=>observe(()=>{this.store.closeNativeTransport(this.ownerIncarnation,generation);finishJournal();}));
      const receive=(handle:()=>void)=>{
        if(generation!==this.generation)return;
        try{handle();}catch{
          // EventEmitter callbacks must not escape into the native stdout listener.
          // A failed durable transition leaves execution uncertain, even if loss cannot be saved.
          this.soloLost=true;void this.failTransport('STATE_PERSISTENCE_FAILED');
        }
      };
      rpc.on('closed',()=>receive(()=>{++this.generation;this.rpc=null;this.loseActive();this.telemetry.disconnect();this.modelTracker.disconnect();this.status('disconnected','TRANSPORT_CLOSED');}));
      rpc.on('notification',(e:any)=>receive(()=>this.onEvent(e)));
      rpc.on('approval',(e:any)=>receive(()=>{this.store.append('approval.denied',this.active()?.id??null,{kind:e.method,decision:'deny'});}));
      try{recordProcess();}catch{observationFailed=true;this.soloLost=true;throw new Error('STATE_PERSISTENCE_FAILED');}
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
      const params={cwd:this.workspace,config,sandbox:this.workspaceId?'workspace-write':'read-only',approvalPolicy:this.approvalPolicy(),approvalsReviewer:'user',developerInstructions:this.workspaceId?'Orbit isolated coding workspace. Edit ordinary source files only within the current worktree using apply_patch. Do not access other projects, credentials, user settings, network, .git, .codex, .agents, or links. Do not run shell commands, install software, commit, checkout, merge, or delete the workspace. Approval requests are denied. Report inability honestly; completion is not verification.\n'+staticAppPreviewCapability:'This is a read-only text-only test session. Do not use tools, access files, credentials, network, or other projects. Answer only from user-provided text.'};
      const t=await rpc.request(id?'thread/resume':'thread/start',id?{...params,threadId:id,excludeTurns:true}:params);
      if(typeof t.thread?.id!=='string' || (id && t.thread.id!==id))throw new Error('THREAD_MISMATCH');
      try{this.store.bindNativeSession(this.ownerIncarnation,generation,t.thread.id);}catch{observationFailed=true;this.soloLost=true;throw new Error('STATE_PERSISTENCE_FAILED');}
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
      this.modelTracker.connect(id?'thread/resume':'thread/start',t,null,null);
      this.knownMcpNames=Object.freeze(Object.keys(config.mcp_servers));this.launchValidated=true;this.store.setThread(t.thread.id,this.workspaceId);this.status('ready');this.store.append(id?'session.resumed':'session.created',null,{threadId:t.thread.id,workspaceId:this.workspaceId??null});
    }catch(e){
      const code=e instanceof Error?e.message:'';
      const issue=['CODEX_NOT_INSTALLED','CHATGPT_LOGIN_REQUIRED','POLICY_MISMATCH','THREAD_STILL_ACTIVE','MCP_ISOLATION_REQUIRED','WRITES_DISABLED','WORKSPACE_CHANGED','LINK_REJECTED','STATE_PERSISTENCE_FAILED'].includes(code)?code:'CONNECTION_FAILED';
      const rpc=this.rpc;this.rpc=null;++this.generation;if(rpc)await rpc.close();
      this.status(issue==='CODEX_NOT_INSTALLED'?'not_installed':issue==='CHATGPT_LOGIN_REQUIRED'?'auth_required':'error',issue);throw new AppError(issue,503);
    }
  }
  taskVerificationPreview(projectId:string,taskId:string,workspaceId:string){
    assertGitProject(this.store,projectId);assertGitProject(this.store,workspaceId);
    if(workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
    return this.verification.acceptance.preview(projectId,workspaceId,taskId);
  }
  claudeQuota(){return this.claudeTasks.quota();}
  private saveQualityReceipt(context:QualityStepContext,value:NonNullable<Awaited<ReturnType<NonNullable<QualityServicePorts['recover']>>>>){
    this.store.db.prepare('INSERT INTO quality_controller_receipts VALUES(?,?)').run(context.stepId,JSON.stringify({loopId:context.loopId,sourceRunId:context.sourceRun.id,baselineDigest:context.version.contentHash,artifactDigest:context.artifact.digest,value}));
  }
  private async recoverQuality(step:Parameters<NonNullable<QualityServicePorts['recover']>>[0],context:QualityStepContext){
    const row=this.store.db.prepare('SELECT body FROM quality_controller_receipts WHERE id=?').get(step.id);
    if(row){
      const saved=JSON.parse(String(row.body));
      if(saved.loopId!==context.loopId||saved.sourceRunId!==context.sourceRun.id||saved.baselineDigest!==context.version.contentHash||saved.artifactDigest!==context.artifact.digest)throw new AppError('QUALITY_RECEIPT_MISMATCH',409);
      return saved.value;
    }
    if(step.kind==='repair'){
      const prior=this.store.findRequest(step.id)?.run;
      if(!prior||!['completed','failed','interrupted'].includes(prior.execution))return null;
      const source=context.sourceRun;
      const linked=this.store.db.prepare("SELECT data FROM events WHERE run_id=? AND kind='run.repair_source' ORDER BY seq DESC LIMIT 1").get(prior.id);
      if(prior.taskId!==source.taskId||prior.projectId!==source.projectId||prior.workspaceId!==source.workspaceId||prior.planningVersionId!==source.planningVersionId||prior.planningContentHash!==source.planningContentHash||!linked||JSON.parse(String(linked.data)).sourceRunId!==source.id)throw new AppError('QUALITY_RECEIPT_MISMATCH',409);
      if(prior.runtime!=='claude-code'){
        const native=this.store.soloOperation(prior.id);
        if(native.record?.execution!==prior.execution||native.record.nativeTurnId!==prior.turnId||!native.connection||native.connection.journalState!=='closed')return null;
      }
      return {failureIssue:prior.execution==='completed'?'QUALITY_ARTIFACT_SNAPSHOT_MISSING':'QUALITY_REPAIR_FAILED',processStopped:true as const};
    }
    // An unreceipted completed writer has no durable artifact snapshot; never infer it from today's files.
    return null;
  }
  private guardQuality(run:Run){
    this.ownQualityStep(()=>this.idle());
    if(this.store.runs().some(item=>item.runtime==='claude-code'&&(!terminal(item.execution)||item.execution==='lost')))throw new AppError('SOLO_RECOVERY_REQUIRED',409);
    if(run.workspaceId&&run.workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
  }
  private waitQualityRun(id:string,signal:AbortSignal):Promise<Run>{
    return new Promise((resolve,reject)=>{
      let timer:NodeJS.Timeout|undefined,settled=false;
      const cleanup=()=>{settled=true;this.store.removeListener('event',observe);signal.removeEventListener('abort',abort);if(timer)clearTimeout(timer);};
      const observe=()=>{const run=this.store.getRun(id);if(run&&terminal(run.execution)){cleanup();resolve(run);}};
      const abort=()=>{
        if(settled||timer)return;
        void this.interrupt(id).catch(()=>{});
        timer=setTimeout(()=>{cleanup();reject(new AppError('QUALITY_PROCESS_STOP_UNCONFIRMED',409));},6000);
      };
      this.store.on('event',observe);signal.addEventListener('abort',abort,{once:true});observe();if(signal.aborted)abort();
    });
  }
  private async repairQuality(request:Parameters<QualityServicePorts['repair']>[0],context:QualityStepContext){
    this.guardQuality(context.sourceRun);
    const current=this.qualityPorts.snapshot(context.sourceRun);
    if(current.artifact.digest!==request.artifact.digest)throw new AppError('QUALITY_ARTIFACT_CHANGED',409);
    if(request.signal.aborted)throw new AppError('QUALITY_PROCESS_STOP_UNCONFIRMED',409);
    const prompt=JSON.stringify({baseline:request.baseline,failures:request.failures});
    let run:Run;
    if(context.sourceRun.runtime==='claude-code'){
      run=this.ownQualityStep(()=>this.claudeTasks.repair(context.sourceRun.id,context.stepId,prompt));
    }else{
      const source=context.sourceRun,projectId=context.task.projectId,workspaceId=source.workspaceId!;
      const brief=new Studio(this.store).execution(projectId,context.task.id);
      if(brief.planningVersionId!==source.planningVersionId||brief.planningContentHash!==source.planningContentHash)throw new AppError('QUALITY_BASELINE_CHANGED',409);
      const acceptance=this.verification.acceptance.status(workspaceId,source.id);
      if(acceptance.state!=='current'||!acceptance.baseline)throw new AppError('ACCEPTANCE_BASELINE_CHANGED',409);
      // Native review-model attribution is unknown today; never spend another call under an unproven repair identity.
      if(qualityRunEvidence(this.store,source).source!=='native_observed')throw new AppError('QUALITY_REPAIR_MODEL_UNKNOWN',409);
      const rpc=this.rpc;this.rpc=null;++this.generation;if(rpc)await rpc.close();this.telemetry.disconnect();this.modelTracker.disconnect();this.status('disconnected');
      this.store.setThread('',workspaceId);
      await this.ownQualityStep(()=>this.connect());
      if(request.signal.aborted)throw new AppError('QUALITY_PROCESS_STOP_UNCONFIRMED',409);
      const repairPrompt=brief.prompt+'\n실패 항목만 수정하고 승인 기준과 통과 항목을 보존하세요.\n'+prompt;
      run=await this.ownQualityStep(()=>this.start({requestId:context.stepId,workspaceId,prompt:repairPrompt},{taskId:source.taskId,planningVersionId:source.planningVersionId,planningContentHash:source.planningContentHash,requirementLabels:source.requirementLabels},acceptance.baseline!));
      this.store.append('run.repair_source',run.id,{sourceRunId:source.id});
    }
    const completed=await this.waitQualityRun(run.id,request.signal);
    if(completed.execution!=='completed')throw new AppError(completed.execution==='lost'?'QUALITY_PROCESS_STOP_UNCONFIRMED':'QUALITY_REPAIR_FAILED',409);
    return {artifact:this.qualityPorts.snapshot(completed).artifact,evidence:qualityRunEvidence(this.store,completed)};
  }
  private async verifyQuality(context:QualityStepContext):Promise<QualityVerificationResult>{
    this.guardQuality(context.sourceRun);
    if(!context.sourceRun.workspaceId)return qualityVerifyGeneral(this.store,this.projects!,context);
    const workspaceId=context.sourceRun.workspaceId,runId=context.sourceRun.id;
    const initial=this.verification.view(workspaceId,runId),checkIds:string[]=[];
    if(!initial.commands.length)return {status:'unknown',checkIds,issue:'VERIFICATION_COMMAND_NOT_FOUND'};
    for(const command of initial.commands){
      if(context.signal.aborted)throw new AppError('QUALITY_PROCESS_STOP_UNCONFIRMED',409);
      const view=this.verification.view(workspaceId,runId);
      if(!view.sourceDigest||view.sourceDigest!==context.artifact.digest)throw new AppError('QUALITY_ARTIFACT_CHANGED',409);
      const check=this.ownQualityStep(()=>this.verification.start({requestId:context.stepId+'-'+command.id,runId,workspaceId,commandId:command.id,expectedSourceDigest:view.sourceDigest!,expectedConfigDigest:command.configDigest}));
      const abort=()=>this.verification.interrupt(workspaceId,check.id);
      context.signal.addEventListener('abort',abort,{once:true});
      try{await this.verification.settle();}finally{context.signal.removeEventListener('abort',abort);}
      checkIds.push(check.id);
    }
    const view=this.verification.view(workspaceId,runId),passed=checkIds.every(id=>view.checks.some(check=>check.id===id&&check.execution==='completed'&&check.verdict==='passed'&&check.finishedDigest===context.artifact.digest));
    const failures=view.checks.filter(check=>checkIds.includes(check.id)&&check.verdict!=='passed').map(check=>({reviewerId:'verification',criterion:null,status:'not_met' as const,evidence:`${check.commandId}: ${check.verdict} (${check.id})`}));
    return {status:passed?'passed':'failed',checkIds,issue:passed?null:'QUALITY_REGRESSION_FAILED',failures};
  }
  /** Read-only view of a general project's server-owned folder. */
  deliverables(projectId:string){
    if(!this.projects)throw new AppError('PROJECT_CREATION_UNAVAILABLE',409);
    const project=this.projects.generalProject(projectId),tasks=(new Studio(this.store).read(projectId,'tasks') as SavedTask[]).map(task=>({id:task.id,title:task.title}));
    return listDeliverables(project.path,tasks);
  }
  /** User materials of a general project (inputs/). Adding never overwrites. */
  materials(projectId:string){if(!this.projects)throw new AppError('PROJECT_CREATION_UNAVAILABLE',409);return listMaterials(this.projects.generalProject(projectId).path);}
  addMaterials(projectId:string,input:unknown){
    this.qualityAvailable();
    if(!this.projects)throw new AppError('PROJECT_CREATION_UNAVAILABLE',409);
    // AI runtimes read this folder; do not change it under an active run of this project.
    if(this.store.runs().some(run=>run.projectId===projectId&&!terminal(run.execution)))throw new AppError('RUN_ACTIVE',409);
    const items=addMaterials(this.projects.generalProject(projectId).path,input);
    this.store.append('project.materials',null,{projectId,paths:items.map(item=>item.path)});return items;
  }
  deliverablePreview(projectId:string,path:string){if(!this.projects)throw new AppError('PROJECT_CREATION_UNAVAILABLE',409);return previewDeliverable(this.projects.generalProject(projectId).path,path);}
  async submitTask(projectId:string,taskId:string,input:{requestId:string;workspaceId?:string;expectedAcceptanceDigest?:string}):Promise<Run>{
    this.qualityAvailable();
    if(this.store.projects().some(project=>project.id===projectId&&project.kind==='general')&&!Object.hasOwn(input,'workspaceId')){
      if(Object.keys(input).length!==1||!Object.hasOwn(input,'requestId'))throw new AppError('INVALID_FIELDS',400);
      this.planningSuggestions.ensureAvailable(projectId);
      // Dispatch must match the stored execution choice; never swap runtimes silently.
      if(this.aiPreferences.read(projectId).execution!=='claude-code')throw new AppError('RUNTIME_NOT_SUPPORTED',409);
      return this.claudeTasks.submit(projectId,taskId,input.requestId);
    }
    if(this.store.projects().some(project=>project.id===projectId&&project.kind==='code')&&this.aiPreferences.read(projectId).execution!=='codex')throw new AppError('RUNTIME_NOT_SUPPORTED',409);
    assertGitProject(this.store,projectId);assertGitProject(this.store,input.workspaceId);
    if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId))throw new AppError('INVALID_REQUEST_ID',400);
    const workspace=this.projects?.workspaces().find(workspace=>workspace.id===input.workspaceId);
    if(!workspace||workspace.id!==this.workspaceId||workspace.projectId!==projectId)throw new AppError('WORKSPACE_MISMATCH');
    const prior=this.store.findRequest(input.requestId);
    if(prior){if(prior.run.taskId!==taskId||prior.run.workspaceId!==workspace.id||prior.run.acceptanceDigest!==input.expectedAcceptanceDigest)throw new AppError('IDEMPOTENCY_CONFLICT');return prior.run;}
    const {prompt,...task}=new Studio(this.store).execution(projectId,taskId);
    const acceptance=this.taskVerificationPreview(projectId,taskId,workspace.id);
    if(acceptance?.digest!==input.expectedAcceptanceDigest)throw new AppError('ACCEPTANCE_PREVIEW_STALE',409);
    return this.start({...input,prompt},task,acceptance??undefined);
  }
  async submit(input:{requestId:string;prompt:string;workspaceId?:string|null}):Promise<Run>{return this.start(input);}
  private async start(input:{requestId:string;prompt:string;workspaceId?:string|null},task?:Pick<Run,'taskId'|'planningVersionId'|'planningContentHash'|'requirementLabels'>,acceptance?:TaskVerificationPreview):Promise<Run>{
    assertGitProject(this.store,input?.workspaceId);assertGitProject(this.store,this.workspaceId);
    if(typeof input?.requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>4000)throw new AppError('INVALID_PROMPT',400);
    if(containsCredential(input.prompt))throw new AppError('CREDENTIAL_LIKE_INPUT',400);
    const denial=outboundDenial(input.prompt);
    if(denial){this.store.append('guardrail.denied',null,{providerId:'codex',code:denial});throw new AppError(denial,400);}
    if(this.projects&&(input.workspaceId===undefined||input.workspaceId!==(this.workspaceId??null)))throw new AppError('WORKSPACE_MISMATCH');
    const digest=createHash('sha256').update(input.prompt).digest('hex');const prior=this.store.findRequest(input.requestId);
    if(prior){if(prior.digest!==digest||prior.run.workspaceId!==this.workspaceId||prior.run.taskId!==task?.taskId)throw new AppError('IDEMPOTENCY_CONFLICT');return prior.run;}
    this.assertExecutionAvailable();this.extensionIdle();if(this.provider!=='ready'||!this.rpc)throw new AppError('NOT_CONNECTED');
    this.planningSuggestions.ensureAvailable(this.workspaceId);this.reviews.ensureAvailable(this.workspaceId);
    if(this.modelHub.active)throw new AppError('MODEL_REQUEST_ACTIVE');
    if(this.switching)throw new AppError('SESSION_BUSY');if(this.active())throw new AppError('RUN_ACTIVE');this.validate();
    const launch=evaluateLaunch({provider:{id:'codex',status:'ready',capabilities:{patch:!!this.workspaceId,shell:false,approvals:'deny',mcp:'disabled'}},
      expectedWorkspaceId:input.workspaceId??null,selectedWorkspaceId:this.workspaceId??null,workspaceValidated:true,writeEnabled:!!this.workspaceId,
      policyValidated:this.launchValidated,mcpIsolated:this.launchValidated});
    if(!launch.allowed)throw new AppError(launch.code);
    const sessionId=this.thread();if(!sessionId)throw new AppError('NOT_CONNECTED');
    const run=this.store.createRun(input.requestId,digest,safeText(input.prompt),this.workspaceId,task,{runtimeId:'codex',ownerIncarnation:this.ownerIncarnation,generation:this.generation,nativeSessionId:sessionId},acceptance);const rpc=this.rpc;
    this.telemetry.begin(run.id);
    this.modelTracker.begin(run.id,{selectedModelId:null,requestedModelId:null});
    this.output.clear();this.deadline=setTimeout(()=>{void this.failTransport('RUN_TIMEOUT');},120000);
    try{
      const result=await rpc.request('turn/start',{threadId:this.thread(),cwd:this.workspace,input:[{type:'text',text:input.prompt}],sandboxPolicy:this.sandbox(),approvalPolicy:this.approvalPolicy(),approvalsReviewer:'user'});
      if(typeof result.turn?.id!=='string')throw new Error('INVALID_TURN');
      this.telemetry.acknowledge(run.id,result.turn.id);
      this.modelTracker.acknowledge(run.id,result);
      this.store.updateRun(run.id,{turnId:result.turn.id,execution:this.store.getRun(run.id)?.execution==='interrupting'?'interrupting':'running'},'run.accepted');
      const accepted=this.store.getRun(run.id)!;
      if(terminal(accepted.execution)){
        this.telemetry.finish(run.id,accepted.execution==='lost'||accepted.turnId!==result.turn.id);
        this.modelTracker.finish(run.id,accepted.execution==='completed'?'completed':accepted.execution==='interrupted'?'interrupted':accepted.execution==='failed'?'failed':'lost');
      }
      return this.store.getRun(run.id)!;
    }catch{
      const current=this.store.getRun(run.id)!;
      if(terminal(current.execution)&&current.execution!=='lost')return current;
      if(this.rpc===rpc&&this.active()?.id===run.id)await this.failTransport('SUBMIT_UNCERTAIN');
      throw new AppError('SUBMIT_UNCERTAIN',503);
    }
  }
  async interrupt(id:string){
    if(this.store.getRun(id)?.runtime==='claude-code')return this.claudeTasks.interrupt(id);
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
    this.telemetry.event(e);this.modelTracker.event(e);
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
      this.modelTracker.finish(r.id,execution==='completed'?'completed':execution==='interrupted'?'interrupted':'failed');
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
  private loseActive(){
    this.clearDeadline();const r=this.active();if(!r)return;
    this.soloLost=true;
    try{this.store.updateRun(r.id,{execution:'lost'},'run.lost');}
    catch{/* Keep the volatile denial; the durable nonterminal Run is quarantined on restart. */}
    this.telemetry.finish(r.id,true);this.modelTracker.finish(r.id,'lost');
  }
  private async failTransport(issue:string){
    const rpc=this.rpc;this.rpc=null;++this.generation;
    try{this.loseActive();}catch{this.soloLost=true;}
    this.telemetry.disconnect();this.modelTracker.disconnect();
    try{this.status('error',issue);}catch{this.launchValidated=false;this.usage=unknownUsage();}
    // Closing the connection is best effort, never evidence permitting a new dispatch.
    try{if(rpc)await rpc.close();}catch{/* The generation remains fenced and recovery stays required. */}
  }
  async close(){await this.qualityLoops.close();await this.claudeTasks.close();await this.planningSuggestions.close();await this.reviews.close();await this.workflows.close();await this.modelHub.close();await this.verification.close();this.loseActive();this.telemetry.disconnect();this.modelTracker.disconnect();const rpc=this.rpc;this.rpc=null;++this.generation;if(rpc)await rpc.close();this.provider='disconnected';this.launchValidated=false;this.clearExtensions();}
}
