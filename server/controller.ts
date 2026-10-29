import {ProjectProgressService,type CompletionReaders} from './project-progress.ts';
import type {CandidateCompletionContext,IntegrationItem,IntegrationCompletionReader} from './integration-queue.ts';
import {lstatSync,readdirSync} from 'node:fs';
import {fingerprintWorkspace} from './workspace-fingerprint.ts';
import type {CapabilityExecutionService} from './capability-execution.ts';
import type {CapabilityExecutionRecord} from '../shared/capability-execution.ts';
import {ParallelWorkerService} from './parallel-workers.ts';
import {WorkerSpaces,generalAttemptPath,resolveWorkerPath,type WorkerSpace} from './worker-spaces.ts';
import {IntegrationQueue,readCandidateCompletion} from './integration-queue.ts';
import {TaskGraphService} from './task-graph.ts';
import {WORKER_LIMITS,type ApprovedExecutionBatch,type WorkerResourceClaim,type WorkerReservation} from '../shared/parallel-workers.ts';
import {WorkerScheduler,approvedWorkerBase,assertWorkerOwnership,type WorkerDispatchContext} from './worker-scheduler.ts';
import { createHash,randomUUID } from 'node:crypto';
import {NativeLaunchNotStarted} from './native-launch-error.ts';
import { basename,join,isAbsolute } from 'node:path';
import type { Snapshot, ProviderStatus, Run, Execution } from '../shared/types.ts';
import { terminal } from '../shared/types.ts';
import { Store } from './store.ts';
import { assertWorkspace } from './workspace.ts';
import { safeText, safeTextItems, containsCredential } from './privacy.ts';
import type { RpcPort } from './rpc.ts';
import { AppError } from './errors.ts';
import { Projects,assertGitProject } from './projects.ts';
import { evaluateLaunch,outboundDenial,providerConnections } from './providers/policy.ts';
import { Studio,exact } from './studio.ts';
import type { SavedTask } from '../shared/parallel.ts';
import { VerificationService,type VerificationConfiguration } from './verification-service.ts';
import {VerificationSetupService} from './verification-setup.ts';
import type {TaskVerificationPreview} from '../shared/acceptance.ts';
import {SubscriptionUsageStore} from './subscription-usage.ts';
import { collectCodexUsage,unknownUsage,normalizeCodexSubscriptionUsage } from './usage.ts';
import type { CodexUsage } from '../shared/usage.ts';
import { SourceGraphService } from './source-graph-service.ts';
import { ModelHubService,registryHubConfigurations,type ModelHubTransports } from './model-hub-service.ts';
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
import {ModelRegistryService,type RegistryConnectionContext} from './model-registry-service.ts';
import {createNativeProbeService} from './capability-probe.ts';
import {createClaudeAuthenticationService} from './native-readiness.ts';
import {compatibleRuntimeVersion} from './capability-runtime-adapters.ts';
import type {NativeReadinessReport} from '../shared/native-readiness.ts';
export interface WorkerConfiguration {targetBranch?:string;projects?:{projectPath:string;defaultBranch:string;requiredChecks:string[]}[]}
/** Server-owned project policy, deliberately separate from HTTP approval bodies. */
export function readWorkerConfiguration(targetBranch:string|undefined,rawProjects:string|undefined):WorkerConfiguration {
  try{
    const branch=(v:unknown):v is string=>typeof v==='string'&&v.length<=200&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(v)&&!v.includes('..')&&!v.includes('//')&&!v.endsWith('/')&&!v.endsWith('.lock')&&!v.startsWith('refs/');
    if(targetBranch!==undefined&&!branch(targetBranch))throw new Error();
    if(rawProjects!==undefined&&rawProjects.length>64000)throw new Error();
    const values:unknown=JSON.parse(rawProjects??'[]');if(!Array.isArray(values)||values.length>100)throw new Error();
    const projects=values.map(value=>{
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();exact(value,['projectPath','defaultBranch','requiredChecks']);
      if(typeof value.projectPath!=='string'||!isAbsolute(value.projectPath)||/[\x00-\x1f]/.test(value.projectPath)||!branch(value.defaultBranch)||!Array.isArray(value.requiredChecks)||!value.requiredChecks.length||!value.requiredChecks.every((id:unknown)=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(id))||new Set(value.requiredChecks).size!==value.requiredChecks.length)throw new Error();
      return {projectPath:value.projectPath as string,defaultBranch:value.defaultBranch,requiredChecks:value.requiredChecks as string[]};
    });
    if(new Set(projects.map(p=>p.projectPath)).size!==projects.length)throw new Error();return {targetBranch,projects};
  }catch{throw new AppError('INVALID_WORKER_CONFIGURATION',503);}
}
interface StoredWorkerBatch {batch:ApprovedExecutionBatch;executions:{executionId:string;expectedPlanDigest:string}[];claims:{executionId:string;claims:WorkerResourceClaim[]}[]}
interface WorkerSubmitResult {state:'intent'|'recorded';reasons:{taskId:string|null;code:string}[]}
export interface ControllerRegistryOptions {
  nativeProbe?:ReturnType<typeof createNativeProbeService>;
  claudeAuthentication?:ReturnType<typeof createClaudeAuthenticationService>;
  configuredCredentialRefs?:readonly string[];
  transports?:ModelHubTransports;
  completion?:CompletionReaders;
  candidateCompletion?:IntegrationCompletionReader;
}
export { AppError } from './errors.ts';
export class Controller {
  private candidateCompletion:IntegrationCompletionReader;
  private completionPolicy?:CompletionReaders['policy'];
  private workerScheduler?:WorkerScheduler;
  private integrationQueue?:IntegrationQueue;
  private workerExecution?:CapabilityExecutionService;
  private workerConfiguration:WorkerConfiguration={};
  private workerRecovery=new Set<string>();
  private workerProcessing:Promise<void>|null=null;private workerAgain=false;
  private workerScheduled=false;private workersStopped=false;private workerIssue:string|null=null;
  store:Store;workspace:string;private factory:(workspace:string,write:boolean)=>RpcPort;private rpc:RpcPort|null=null;
  private projects?:Projects;private workspaceId?:string;private switching=false;
  private provider:ProviderStatus='disconnected';private issue:string|null=null;private connecting:Promise<void>|null=null;
  private generation=0;private output=new Map<string,string>();private deadline:NodeJS.Timeout|null=null;private launchValidated=false;
  readonly progress:ProjectProgressService;
  readonly qualityLoops:QualityLoopService;
  private qualityScope=false;
  private qualityPorts:QualityServicePorts;
  readonly verification:VerificationService;
  readonly sourceGraphs:SourceGraphService;
  readonly modelHub:ModelHubService;
  readonly modelRegistry:ModelRegistryService;
  readonly nativeProbe:ReturnType<typeof createNativeProbeService>;
  readonly claudeAuthentication:ReturnType<typeof createClaudeAuthenticationService>;
  readonly merges:MergeService;
  readonly workflows:WorkflowService;
  private readonly verificationSetup:VerificationSetupService;
  readonly reviews:ReviewService;
  readonly planningSuggestions:PlanningAgentService;
  readonly aiPreferences:ProjectAiPreferencesService;
  readonly subscriptionUsage:SubscriptionUsageStore;
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
  constructor(store:Store,workspace:string,factory:(workspace:string,write:boolean)=>RpcPort,projects?:Projects,verificationConfig:VerificationConfiguration[]=[],modelHubConfig:readonly ModelHubConfiguration[]=[],claudeOptions:ClaudeTaskServiceOptions={},claudePlanningOptions:ClaudePlanningOptions={},qualityOptions:Pick<QualityNativeOptions,'findExecutable'|'claudeFactory'|'codexReview'>={},registryOptions:ControllerRegistryOptions={}){
    this.candidateCompletion=registryOptions.candidateCompletion??(item=>this.readIntegrationCandidate(item));this.completionPolicy=registryOptions.completion?.policy;
    this.store=store;this.workspace=workspace;this.factory=factory;this.projects=projects;
    this.subscriptionUsage=new SubscriptionUsageStore(store);
    this.claudeTasks=new ClaudeTaskService(store,projects,claudeOptions,this.subscriptionUsage);
    this.aiPreferences=new ProjectAiPreferencesService(store);
    this.soloLost=store.unresolvedNativeConnections();
    this.telemetry=new RunTelemetry(metrics=>this.store.saveRunMetrics(metrics));
    this.modelTracker=new CodexModelTracker((runId,value)=>this.store.saveCodexModelAttribution(runId,value));
    const selected=projects?.workspaces().find(w=>w.id===store.getMeta('selectedWorkspace'));if(selected){this.workspaceId=selected.id;this.workspace=selected.path;}
    this.nativeProbe=registryOptions.nativeProbe??createNativeProbeService();
    this.claudeAuthentication=registryOptions.claudeAuthentication??createClaudeAuthenticationService();
    const owner=this;
    const nativeReadiness:NativeReadinessReport={get codex(){return owner.registryNativeReadiness().codex;},get claude(){return owner.registryNativeReadiness().claude;},
      actualModel:'unknown',liveValidation:'approval_required',costUsd:null,remainingQuota:null};
    // Only enumerate configured reference names; credential values remain transport-owned.
    const configuredCredentialRefs=registryOptions.configuredCredentialRefs??Object.keys(process.env).filter(name=>
      /^ORBIT_MODEL_KEY_[A-Z0-9_]{1,50}$/.test(name)||/^ORBIT_BEDROCK_[A-Z0-9_]{1,50}$/.test(name));
    this.modelRegistry=new ModelRegistryService(store,{configurations:modelHubConfig,configuredCredentialRefs,nativeReadiness,
      connection:context=>this.validateRegistryConnection(context)});
    this.modelHub=new ModelHubService(store,modelHubConfig,undefined,undefined,()=>this.assertExecutionAvailable(),()=>registryHubConfigurations(this.modelRegistry),registryOptions.transports);
    this.verificationSetup=new VerificationSetupService(store,projects,verificationConfig);
    const commandResolver=(path:string)=>this.verificationSetup.commands(path);
    this.verification=new VerificationService(store,projects,commandResolver,()=>this.workerIntegrationBusy());
    this.progress=new ProjectProgressService(store,new Studio(store),{deliverables:id=>this.deliverables(id),verification:(workspaceId,runId)=>this.verification.view(workspaceId,runId),...registryOptions.completion,policy:id=>this.completionPolicy?.(id)});
    this.sourceGraphs=new SourceGraphService(store,projects);
    this.merges=new MergeService(store,projects,this.verification,()=>this.qualityBusy()||this.soloRecoveryRequired()||!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||!!this.workflows?.active||!!this.reviews?.active||!!this.planningSuggestions?.active);
    this.workflows=new WorkflowService(store,projects,commandResolver,()=>this.qualityBusy()||this.soloRecoveryRequired()||!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||this.verification.active||this.merges.active||!!this.reviews?.active||!!this.planningSuggestions?.active,id=>{this.merges.ensureAvailable(id);this.verification.ensureAvailable(id);this.planningSuggestions.ensureAvailable(id);this.reviews.ensureAvailable(id);});
    this.reviews=new ReviewService(store,projects,factory,()=>this.qualityBusy()||this.soloRecoveryRequired()||!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||this.verification.active||this.merges.active||this.workflows.active||!!this.planningSuggestions?.active,id=>{this.planningSuggestions.ensureAvailable(id);this.merges.ensureAvailable(id);this.verification.ensureAvailable(id);this.workflows.ensureAvailable(id);});
    this.planningSuggestions=new PlanningAgentService(store,projects,factory,projectId=>this.qualityBusy()||this.soloRecoveryRequired()||store.runs().some(run=>run.runtime==='claude-code'&&(!terminal(run.execution)||run.execution==='lost'&&run.projectId===projectId))||!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||this.verification.active||this.merges.active||this.workflows.active||this.reviews.active,id=>{this.merges.ensureAvailable(id);this.verification.ensureAvailable(id);this.workflows.ensureAvailable(id);this.reviews.ensureAvailable(id);},undefined,claudePlanningOptions);
    const unavailable=()=>{throw new AppError('QUALITY_PROJECT_REQUIRED',409);};
    this.qualityPorts=projects?createQualityNativePorts({store,projects,factory,...qualityOptions,guard:run=>this.guardQuality(run),repair:async(request,context)=>{try{const result=await this.repairQuality(request,context);this.saveQualityReceipt(context,{result,evidence:result.evidence});return result;}catch(error){if(context.sourceRun.runtime==='claude-code'&&!store.findRequest(context.stepId)){const failureIssue=error instanceof Error&&/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)?error.message:'QUALITY_REPAIR_NOT_STARTED';this.saveQualityReceipt(context,{failureIssue,processStopped:true});}throw error;}},verify:async context=>{const result=await this.verifyQuality(context);this.saveQualityReceipt(context,{result,evidence:null});return result;},recover:(step,context)=>this.recoverQuality(step,context)}):{guard:unavailable,snapshot:unavailable,review:unavailable,repair:unavailable,verify:unavailable};
    const review=this.qualityPorts.review,verify=this.qualityPorts.verify;
    this.qualityPorts.review=(request,context,selection)=>this.captureQualityCompletion(context,()=>review(request,context,selection));
    this.qualityPorts.verify=context=>this.captureQualityCompletion(context,()=>verify(context));
    store.db.exec('CREATE TABLE IF NOT EXISTS quality_controller_receipts(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
    this.qualityLoops=new QualityLoopService(store,this.qualityPorts);
  }
  private readIntegrationSource(item:Readonly<IntegrationItem>){
    const row=this.store.db.prepare('SELECT body FROM worker_reservations WHERE id=?').get(item.fence.reservationId);
    if(!row)return null;
    const reservation=JSON.parse(String(row.body)) as WorkerReservation;
    const run=this.store.findRequest(reservation.attempt.dispatchRequestId)?.run;
    if(!run||run.taskId!==reservation.attempt.taskId||run.projectId!==item.projectId
      ||(run.workspaceId??null)!==item.space.workspaceId)return null;
    const task=this.progress.read(item.projectId,{}).tasks.find(t=>t.id===reservation.attempt.taskId&&t.latestRunId===run.id);
    return task?.completion??null;
  }
  private readIntegrationCandidate(item:Readonly<IntegrationItem>){
    // Deterministic code merges have local command evidence, never an AI producer.
    if(item.space.kind!=='code')return readCandidateCompletion(this.store,item);
    const source=this.readIntegrationSource(item);
    if(!source||!item.candidateDigest||!item.target||!item.space.workspaceId)return null;
    const binding={...source.binding,artifactId:item.id,artifactDigest:item.candidateDigest,
      baseSha:item.target.head,configDigest:item.configDigest,policyDigest:item.completionPolicyDigest??null};
    const dimension={status:'not_run' as const,evidenceIds:[],blockers:[],nextAction:null};
    const context:CandidateCompletionContext={subject:{integrationId:item.id,candidateDigest:item.candidateDigest,targetDigest:item.target.head},binding,
      producer:undefined,quality:{execution:{...dimension,status:'completed',evidenceSource:'local'},format:dimension,codeVerification:dimension,
        semantic:dimension,independentReview:dimension,repair:dimension,revalidation:dimension,userApproval:dimension,evidence:[]},
      commands:this.verification.view(item.space.workspaceId,source.binding.runId).commands,bindings:{},loops:[],gateResults:[]};
    return readCandidateCompletion(this.store,item,context);
  }
  initializeWorkers(execution:CapabilityExecutionService,configuration:WorkerConfiguration={},completion?:{policy:NonNullable<CompletionReaders['policy']>;candidate:IntegrationCompletionReader}){
    if(this.workerScheduler)return;
    if(!this.projects)return;
    if(completion){this.completionPolicy=completion.policy;this.candidateCompletion=completion.candidate;}
    this.workerConfiguration=readWorkerConfiguration(configuration.targetBranch,JSON.stringify(configuration.projects??[]));this.workerExecution=execution;
    const workers=new ParallelWorkerService(this.store),spaces=new WorkerSpaces(this.store,this.projects,workers);
    this.integrationQueue=new IntegrationQueue(this.store,this.projects,workers,spaces,this.verification,this.merges,projectId=>{
      const config=this.workerProjectConfiguration(projectId);
      const held=workers.list().find(r=>r.batch.projectId===projectId&&r.state==='terminal_confirmed');
      if(!held)throw new AppError('INTEGRATION_BASELINE_CHANGED',409);
      const graph=new TaskGraphService(this.store).view(projectId,held.batch.planningVersionId,{verifiedDoneIds:[],blocked:[]},held.batch.graphRevision);
      if(graph.stale||new TaskGraphService(this.store).read(projectId,held.batch.planningVersionId).revision!==held.batch.graphRevision)throw new AppError('INTEGRATION_BASELINE_CHANGED',409);
      return {approvedBaseline:held.batch.planningHash,defaultBranch:config?.defaultBranch??'',requiredChecks:config?.requiredChecks??[],completionPolicy:this.completionPolicy?.(projectId)};
    },item=>this.candidateCompletion(item),item=>this.readIntegrationSource(item));
    this.store.db.exec('CREATE TABLE IF NOT EXISTS worker_integration_refusals(reservation_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,reason TEXT NOT NULL);');
    for(const row of this.store.db.prepare('SELECT reservation_id FROM worker_integration_refusals').all()){
      const reservation=workers.read(String(row.reservation_id));
      try{workers.release(reservation);}catch{this.workerRecovery.add(reservation.reservationId);}
    }
    // Recovery precedes Scheduler ownership transfer. A stopped server does not prove its child commands stopped.
    for(const item of this.integrationQueue.list()){
      const finished=item.status==='applied'||item.status==='refused';
      try{this.integrationQueue.reconcile(item.id,finished);}catch{this.workerRecovery.add(item.fence.reservationId);}
      if(!finished)this.workerRecovery.add(item.fence.reservationId);
    }
    this.workerScheduler=new WorkerScheduler(this.store,this.projects,execution,runtime=>{
      const entries=this.subscriptionUsage.snapshot().filter(e=>e.observation.runtimeId===runtime);
      return entries.some(e=>e.observation.providerStatus==='rejected'||e.observation.buckets?.some(b=>[b.primary,b.secondary].some(w=>w?.providerStatus==='rejected'||w?.remainingPercent===0)))?'exhausted':'unknown';
    },this.progress);
    for(const r of this.workerScheduler.list())if(r.state!=='released')this.workerRecovery.add(r.reservationId);
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS worker_http_batches(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,input_digest TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_http_submissions(request_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,body TEXT NOT NULL);`);
    this.store.on('event',this.workerEvent);
  }
  async stopWorkers(){this.store.off('event',this.workerEvent);this.workersStopped=true;await this.workerProcessing?.catch(()=>{});}
  private workerEvent=(event:{kind:string})=>{
    if(this.workersStopped||this.workerScheduled||!(/^(?:workflow|verification|merge)\./.test(event.kind)||['run.completed','run.failed','run.interrupted','run.lost','worker.terminal_confirmed','provider.status','workspace.selected','extensions.updated','review.updated','planning_suggestion.updated','quality.updated','model.request_updated'].includes(event.kind)))return;
    this.workerScheduled=true;
    setImmediate(()=>{this.workerScheduled=false;if(!this.workersStopped)void this.processWorkers().catch(()=>{this.workerIssue='WORKER_INTEGRATION_UNCERTAIN';});});
  };
  private workerIntegrationBusy(){return this.qualityBusy()||this.soloRecoveryRequired()||!!this.extensionPending||!!this.active()||!!this.connecting||this.switching||this.modelHub.active||!!this.workflows?.active||!!this.reviews?.active||!!this.planningSuggestions?.active;}
  private processWorkers():Promise<void>{
    if(this.workersStopped)return Promise.resolve();
    this.workerAgain=true;if(this.workerProcessing)return this.workerProcessing;
    this.workerProcessing=(async()=>{
      do{this.workerAgain=false;await this.processWorkerPass();}while(this.workerAgain&&!this.workersStopped);
    })().finally(()=>{this.workerProcessing=null;});return this.workerProcessing;
  }
  private async processWorkerPass(){
    const scheduler=this.workerScheduler,queue=this.integrationQueue;if(!scheduler||!queue)return;
    scheduler.reconcile();
    for(const reservation of scheduler.list()){
      if(reservation.state!=='terminal_confirmed'||this.workerRecovery.has(reservation.reservationId)||queue.list().some(i=>i.fence.reservationId===reservation.reservationId))continue;
      try{queue.enqueue({requestId:reservation.reservationId,fence:{reservationId:reservation.reservationId,ownerIncarnation:reservation.ownerIncarnation,fencingGeneration:reservation.fencingGeneration},targetBranch:this.store.projects().find(p=>p.id===reservation.batch.projectId)?.kind==='code'?(this.workerConfiguration.targetBranch??null):null});}
      catch(error){
        if(error instanceof AppError&&error.message==='INTEGRATION_BASELINE_CHANGED'){
          // Record definitive refusal before release; startup can retry release without dispatch or apply.
          this.store.db.prepare('INSERT OR IGNORE INTO worker_integration_refusals VALUES(?,?,?)').run(reservation.reservationId,reservation.batch.projectId,error.message);
          scheduler.release(reservation.reservationId);
        }else this.workerIssue='WORKER_INTEGRATION_ENQUEUE_BLOCKED';
      }
    }
    // Never drain a queue containing an unresolved pre-restart item, even when a new worker finishes.
    if(!this.workerIntegrationBusy()&&this.workerConfiguration.targetBranch&&!this.workerRecovery.size&&queue.list().filter(i=>i.status==='queued').every(i=>!this.workerIntegrationReason(i.projectId)))await queue.drain();
  }
  private workerProjectConfiguration(projectId:string){
    const project=this.store.projects().find(p=>p.id===projectId);if(!project)throw new AppError('PROJECT_NOT_FOUND',404);
    return this.workerConfiguration.projects?.find(p=>p.projectPath===project.path);
  }
  private workerIntegrationReason(projectId:string):string|null {
    const config=this.workerProjectConfiguration(projectId),branch=this.workerConfiguration.targetBranch;
    if(!branch)return 'INTEGRATION_DISABLED';
    if(['main','master',config?.defaultBranch].includes(branch))return 'INTEGRATION_TARGET_PROTECTED';
    if(!config?.defaultBranch)return 'INTEGRATION_PROJECT_CONFIGURATION_REQUIRED';
    return null;
  }
  workerIntegrationQueue(projectId:string){
    const reason=this.workerIntegrationReason(projectId);
    const refusals=this.workerScheduler?this.store.db.prepare('SELECT reservation_id,reason FROM worker_integration_refusals WHERE project_id=?').all(projectId).map(row=>({reservationId:String(row.reservation_id),reason:String(row.reason),status:'refused' as const,released:this.workerScheduler!.read(String(row.reservation_id)).state==='released'})):[];
    return {enabled:!reason,reason,refusals,items:(this.integrationQueue?.list()??[]).filter(i=>i.projectId===projectId).map(i=>this.workerRecovery.has(i.fence.reservationId)?{...i,status:'blocked' as const,reason:'INTEGRATION_RESTART_RECOVERY_REQUIRED'}:i)};
  }
  private storedWorkerBatch(projectId:string,id:string):StoredWorkerBatch {
    if(!this.workerScheduler)throw new AppError('WORKERS_UNAVAILABLE',503);
    const row=this.store.db.prepare('SELECT body FROM worker_http_batches WHERE id=?').get(id);
    if(!row)throw new AppError('WORKER_BATCH_NOT_FOUND',404);
    const record=JSON.parse(String(row.body)) as StoredWorkerBatch;
    if(record.batch.projectId!==projectId)throw new AppError('WORKER_BATCH_NOT_FOUND',404);return record;
  }
  createWorkerBatch(projectId:string,input:Record<string,unknown>){
    if(!this.workerExecution||!this.workerScheduler)throw new AppError('WORKERS_UNAVAILABLE',503);
    exact(input,['requestId','planningVersionId','graphRevision','planningHash','confirmed','executions']);
    const validId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(v);
    if(!validId(input.requestId)||!validId(input.planningVersionId)||!Number.isSafeInteger(input.graphRevision)||Number(input.graphRevision)<1||typeof input.planningHash!=='string'||!/^[a-f0-9]{64}$/.test(input.planningHash)||!Array.isArray(input.executions)||!input.executions.length||input.executions.length>1000)throw new AppError('INVALID_FIELDS',400);
    if(input.confirmed!==true)throw new AppError('WORKER_APPROVAL_REQUIRED',409);
    const executions=input.executions.map(value=>{
      if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('INVALID_FIELDS',400);
      exact(value,['executionId','expectedPlanDigest']);
      if(!validId(value.executionId)||typeof value.expectedPlanDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.expectedPlanDigest))throw new AppError('INVALID_FIELDS',400);
      return {executionId:value.executionId,expectedPlanDigest:value.expectedPlanDigest as string};
    });
    const integrationReason=this.workerIntegrationReason(projectId);
    if(integrationReason&&integrationReason!=='INTEGRATION_DISABLED')throw new AppError(integrationReason,409);
    const digest=createHash('sha256').update(JSON.stringify({projectId,planningVersionId:input.planningVersionId,graphRevision:input.graphRevision,planningHash:input.planningHash,executions})).digest('hex');
    const prior=this.store.db.prepare('SELECT id,input_digest FROM worker_http_batches WHERE request_id=?').get(input.requestId);
    if(prior){if(prior.input_digest!==digest)throw new AppError('IDEMPOTENCY_CONFLICT',409);return this.workerBatch(projectId,String(prior.id));}
    const graphs=new TaskGraphService(this.store),graph=graphs.read(projectId,input.planningVersionId);
    if(graph.revision!==input.graphRevision||graph.contentHash!==input.planningHash||graphs.view(projectId,input.planningVersionId,{verifiedDoneIds:[],blocked:[]}).stale)throw new AppError('WORKER_BASELINE_CHANGED',409);
    const plans=executions.map(e=>{
      const plan=this.workerExecution!.record(projectId,e.executionId);
      if(plan.status!=='awaiting_approval'||plan.planDigest!==e.expectedPlanDigest)throw new AppError('WORKER_APPROVAL_REQUIRED',409);
      this.workerExecution!.assertWorkerPlan(projectId,plan.id,{confirmed:true,expectedPlanDigest:e.expectedPlanDigest});
      if(plan.baseline.planningVersionId!==graph.planningVersionId||plan.baseline.planningContentHash!==graph.contentHash||!graph.nodes.some(n=>n.taskId===plan.taskId))throw new AppError('WORKER_BASELINE_CHANGED',409);
      if(!Object.hasOwn(WORKER_LIMITS.perRuntime,plan.runtimeId))throw new AppError('WORKER_RUNTIME_UNSUPPORTED',409);return plan;
    });
    if(new Set(plans.map(p=>p.taskId)).size!==plans.length)throw new AppError('INVALID_FIELDS',400);
    const contracts=new Map<string,string>();for(const c of [...graph.nodes,...graph.edges].flatMap(n=>n.contracts??[])){
      if(contracts.has(c.id)&&contracts.get(c.id)!==c.digest)throw new AppError('WORKER_CONTRACT_CHANGED',409);contracts.set(c.id,c.digest);
    }
    const batch:ApprovedExecutionBatch={id:randomUUID(),projectId,planningVersionId:graph.planningVersionId,graphRevision:graph.revision,planningHash:graph.contentHash,taskIds:plans.map(p=>p.taskId),contractDigests:[...contracts].map(([id,digest])=>({id,digest})),inputArtifactHashes:this.workerInputHashes(projectId),runtimeChoices:plans.map(p=>({taskId:p.taskId,runtimeId:p.runtimeId})),parallelLimit:WORKER_LIMITS.total};
    const claims=plans.map(plan=>({executionId:plan.id,claims:this.workerClaims(batch,plan)}));
    this.store.db.prepare('INSERT INTO worker_http_batches VALUES(?,?,?,?)').run(batch.id,input.requestId,digest,JSON.stringify({batch,executions,claims} satisfies StoredWorkerBatch));
    return this.workerBatch(projectId,batch.id);
  }
  private workerInputHashes(projectId:string,root?:string):ApprovedExecutionBatch['inputArtifactHashes'] {
    const project=this.store.projects().find(p=>p.id===projectId)!;if(project.kind==='code')return [];
    const path=root??project.path,files:{path:string;mode:string}[]=[];let count=0;
    const walk=(logical:string)=>{
      if(++count>2000)throw new AppError('WORKER_INPUTS_UNAVAILABLE',409);
      resolveWorkerPath(path,logical);
      const stat=lstatSync(join(path,logical),{throwIfNoEntry:false});if(!stat)return;
      if(stat.isDirectory())for(const name of readdirSync(join(path,logical)).sort())walk(logical+'/'+name);
      else files.push({path:logical,mode:stat.mode&0o111?'100755':'100644'});
    };
    walk('inputs');return [{id:'inputs',hash:fingerprintWorkspace(path,'0'.repeat(40),files)}];
  }
  private assertWorkerInputs(batch:ApprovedExecutionBatch,root?:string){
    if(JSON.stringify(this.workerInputHashes(batch.projectId,root))!==JSON.stringify(batch.inputArtifactHashes))throw new AppError('WORKER_INPUTS_CHANGED',409);
  }
  private workerClaims(batch:ApprovedExecutionBatch,plan:CapabilityExecutionRecord):WorkerResourceClaim[]{
    const project=this.store.projects().find(p=>p.id===batch.projectId)!;
    const graph=new TaskGraphService(this.store).read(batch.projectId,batch.planningVersionId,batch.graphRevision);
    const scopes=[graph.nodes.find(n=>n.taskId===plan.taskId)?.impactScope,...graph.edges.filter(e=>e.taskId===plan.taskId).map(e=>e.impactScope)].filter(s=>!!s);
    if(scopes.some(s=>s.resources.length))throw new AppError('WORKER_RESOURCE_ADAPTER_REQUIRED',409);
    if(project.kind==='general')return [{kind:'isolated_folder',host:'local',path:resolveWorkerPath(project.path,join(generalAttemptPath(project.path,plan.id),'output'),true)}];
    const base=approvedWorkerBase(this.store,this.projects!,batch,plan)!;
    const workspace=this.store.workspaces().find(w=>w.id===plan.workspaceId)!;
    const files=[...new Set(scopes.flatMap(s=>s.files))];if(!files.length)throw new AppError('WORKER_IMPACT_SCOPE_REQUIRED',409);
    return files.map(path=>({kind:'repository_file',repositoryId:base.repositoryId,path:resolveWorkerPath(workspace.path,path),mode:'write'}));
  }
  workerBatch(projectId:string,id:string){
    const {batch}=this.storedWorkerBatch(projectId,id),reservations=this.workerScheduler!.list().filter(r=>r.batch.id===id);
    const spaces=this.store.db.prepare('SELECT body FROM worker_spaces').all().map(r=>JSON.parse(String(r.body)) as WorkerSpace).filter(s=>reservations.some(r=>r.reservationId===s.reservationId));
    const submissions=this.store.db.prepare('SELECT body FROM worker_http_submissions WHERE batch_id=?').all(id).map(r=>JSON.parse(String(r.body)) as WorkerSubmitResult);
    const reasons=submissions.flatMap(s=>s.reasons);
    if(submissions.some(s=>s.state==='intent'))reasons.push({taskId:null,code:'WORKER_SUBMISSION_RECOVERY_REQUIRED'});
    for(const r of reservations)if(this.workerRecovery.has(r.reservationId)||r.state==='lost_unknown')reasons.push({taskId:r.attempt.taskId,code:'WORKER_RESTART_RECOVERY_REQUIRED'});
    if(this.workerIssue)reasons.push({taskId:null,code:this.workerIssue});
    const integration=this.workerIntegrationQueue(projectId);
    integration.items=integration.items.filter(i=>reservations.some(r=>r.reservationId===i.fence.reservationId));
    integration.refusals=integration.refusals.filter(i=>reservations.some(r=>r.reservationId===i.reservationId));
    return {id:batch.id,batch,limits:WORKER_LIMITS,attempts:reservations.map(r=>r.attempt),reservations,spaces,integration,reasons};
  }
  async submitWorkerBatch(projectId:string,id:string,input:Record<string,unknown>){
    exact(input,['requestId']);if(typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(input.requestId))throw new AppError('INVALID_FIELDS',400);
    const record=this.storedWorkerBatch(projectId,id),prior=this.store.db.prepare('SELECT batch_id,body FROM worker_http_submissions WHERE request_id=?').get(input.requestId);
    if(prior){if(prior.batch_id!==id)throw new AppError('IDEMPOTENCY_CONFLICT',409);return this.workerBatch(projectId,id);}
    const result:WorkerSubmitResult={state:'intent',reasons:[]};
    // HTTP intent is durable before admission; a replay never continues a partially submitted batch.
    this.store.db.prepare('INSERT INTO worker_http_submissions VALUES(?,?,?)').run(input.requestId,id,JSON.stringify(result));
    for(const e of record.executions){
      const taskId=this.workerExecution!.record(projectId,e.executionId).taskId;
      try{
        this.assertWorkerInputs(record.batch);
        await this.workerScheduler!.submit({batch:record.batch,executionId:e.executionId,approval:{confirmed:true,expectedPlanDigest:e.expectedPlanDigest},claims:record.claims.find(c=>c.executionId===e.executionId)!.claims});
      }catch(error){result.reasons.push({taskId,code:error instanceof AppError?error.message:'WORKER_SUBMISSION_UNCERTAIN'});}
    }
    result.state='recorded';this.store.db.prepare('UPDATE worker_http_submissions SET body=? WHERE request_id=?').run(JSON.stringify(result),input.requestId);
    await this.processWorkers();return this.workerBatch(projectId,id);
  }
  registryNativeReadiness():NativeReadinessReport {
    const installation=this.nativeProbe.get(),connection=this.provider;
    return {codex:{installation:installation?.codex??{status:'unknown',version:null},authentication:connection==='ready'?'confirmed':'unknown',connection},
      claude:{installation:installation?.claude??{status:'unknown',version:null},authentication:this.claudeAuthentication.get()},
      actualModel:'unknown',liveValidation:'approval_required',costUsd:null,remainingQuota:null};
  }
  private async validateRegistryConnection(context:RegistryConnectionContext){
    const guard=()=>{
      this.assertExecutionAvailable();
      if(context.confirmed!==true)throw new AppError('REGISTRY_CONFIRMATION_REQUIRED',403);
      const entry=this.modelRegistry.get(context.entry.id),provider=this.modelRegistry.get(context.provider.id);
      const intent=this.modelRegistry.validations(entry.id).find(value=>value.id===context.validation.id);
      if(!entry.enabled||!provider.enabled||entry.revision!==context.validation.revision||entry.configDigest!==context.validation.configDigest
        ||provider.revision!==context.provider.revision||intent?.state!=='intent')throw new AppError('REGISTRY_DISPATCH_DENIED',409);
    };
    guard();
    const adapter=context.provider.connection.adapterId;
    if(adapter==='codex'||adapter==='claude-code'){
      const installation=await this.nativeProbe.refresh();
      guard();
      const probe=adapter==='codex'?installation.codex:installation.claude;
      if(probe.status!=='found'||!probe.version)return {state:'unknown' as const};
      if(!compatibleRuntimeVersion(adapter,probe.version))return {state:'unsupported' as const};
      if(adapter==='claude-code'){
        const auth=await this.claudeAuthentication.refresh();
        guard();
        return {state:auth.authentication==='subscription'?'passed' as const:auth.authentication==='unknown'?'unknown' as const:'failed' as const};
      }
      return {state:this.provider==='ready'?'passed' as const:'unknown' as const};
    }
    const project=this.store.projects().find(project=>project.path===context.projectPath);
    if(!project)throw new AppError('PROJECT_NOT_FOUND',404);
    const destination=this.modelHub.view(project.id).destinations.find(entry=>entry.id===context.provider.id);
    if(!destination)return {state:'unsupported' as const};
    const catalog=await this.modelHub.diagnose(destination.id,{projectId:project.id,expectedConfigDigest:destination.configDigest,confirmed:true},guard);
    guard();
    return {state:catalog.status==='available'||catalog.status==='empty'?'passed' as const:'failed' as const};
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
    return this.startBoundVerification(input);
  }
  private async captureQualityCompletion<T>(context:QualityStepContext,work:()=>Promise<T>):Promise<T>{
    const projectId=context.sourceRun.projectId??this.store.workspaces().find(w=>w.id===context.sourceRun.workspaceId)?.projectId;
    const completion=projectId&&this.completionPolicy?.(projectId)&&this.progress.read(projectId,{}).tasks.find(t=>t.latestRunId===context.sourceRun.id)?.completion;
    const tables=['quality_native_receipts','quality_artifact_checks'];
    const existing=new Set(tables.filter(table=>this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)&&this.store.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(context.stepId)));
    const producer=completion?{binding:structuredClone(completion.binding),model:qualityRunEvidence(this.store,context.sourceRun)}:undefined;
    const result=await work();
    if(completion&&producer&&completion.binding.artifactId===context.artifact.id&&completion.binding.artifactDigest===context.artifact.digest){
      this.store.transaction(()=>{
        const records=tables.flatMap(table=>{
          if(existing.has(table)||!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))return [];
          const row=this.store.db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(context.stepId);
          if(!row)return [];
          const body=JSON.parse(String(row.body));
          if(body.sourceRunId!==context.sourceRun.id||body.artifactDigest!==context.artifact.digest)return [];
          return [{table,id:context.stepId,evidenceId:table==='quality_native_receipts'?context.loopId:context.stepId,digest:createHash('sha256').update(String(row.body)).digest('hex')}];
        });
        // Original native/artifact receipts have exact replay contracts; preserve their bytes.
        if(records.length)this.store.db.prepare('INSERT INTO quality_controller_receipts VALUES(?,?) ON CONFLICT(id) DO NOTHING').run('completion:'+context.stepId,JSON.stringify({completionCapture:{sourceRunId:context.sourceRun.id,binding:completion.binding,producer,records}}));
      });
    }
    return result;
  }
  private startBoundVerification(input:Parameters<VerificationService['start']>[0]){
    const prior=this.store.db.prepare('SELECT id FROM verification_checks WHERE request_id=?').get(input.requestId);
    if(prior)return this.verification.start(input);
    const run=this.store.runs().find(r=>r.id===input.runId);
    const projectId=this.store.workspaces().find(w=>w.id===input.workspaceId)?.projectId;
    const completion=projectId&&this.progress.read(projectId,{}).tasks.find(t=>t.latestRunId===input.runId)?.completion;
    const check=this.verification.start(input);
    if(run&&completion&&this.completionPolicy?.(check.projectId)){
      // Capture before the async command starts; its final save retains this object.
      check.completionBinding=structuredClone(completion.binding);
      Object.assign(check,{completionProducer:{binding:structuredClone(completion.binding),model:qualityRunEvidence(this.store,run)}});
      this.store.db.prepare('UPDATE verification_checks SET body=? WHERE id=?').run(JSON.stringify(check),check.id);
    }
    return check;
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
    const rpc=this.rpc,generation=this.generation,connectionRef=this.ownerIncarnation+':'+generation,at=new Date().toISOString();
    const pending=collectCodexUsage((method,params)=>rpc.request(method,params)).then(report=>{
      if(generation!==this.generation||rpc!==this.rpc||this.provider!=='ready')return unknownUsage();
      if(report.buckets?.length)this.subscriptionUsage.record(normalizeCodexSubscriptionUsage(report,{providerId:'codex',runtimeId:'codex',connectionRef,evidence:rpc.evidenceSource??'unknown',observedAt:report.checkedAt,lastAttemptAt:at,now:new Date().toISOString(),connected:true}));
      else this.subscriptionUsage.attempt('codex',connectionRef,at);
      this.usage=report;return this.usageSnapshot();
    }).finally(()=>{if(this.usagePending===pending)this.usagePending=null;});
    this.usagePending=pending;return pending;
  }
  async selectWorkspace(id:string){
    this.idle();if(!this.projects)throw new AppError('UNSUPPORTED',404);const w=this.projects.validate(id);this.switching=true;
    try{await this.close();this.workspaceId=id;this.workspace=w.path;this.store.setMeta('selectedWorkspace',id);this.status('disconnected');this.store.append('workspace.selected',null,{workspaceId:id});}
    finally{this.switching=false;}
  }
  private approvalPolicy(){return this.workspaceId?'on-request':'untrusted';}
  private sandbox(){return this.workspaceId?{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false};}
  private status(status:ProviderStatus,issue:string|null=null){this.provider=status;this.issue=issue;if(status!=='ready'){this.subscriptionUsage.disconnect('codex');this.usagePending=null;this.clearExtensions();this.launchValidated=false;this.usage=unknownUsage();}this.store.append('provider.status',null,{status,issue});}
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
  taskVerificationPreview(projectId:string,taskId:string,workspaceId:string,worker=false){
    assertGitProject(this.store,projectId);assertGitProject(this.store,workspaceId);
    if(!worker&&workspaceId!==this.workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
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
      const check=this.ownQualityStep(()=>this.startBoundVerification({requestId:context.stepId+'-'+command.id,runId,workspaceId,commandId:command.id,expectedSourceDigest:view.sourceDigest!,expectedConfigDigest:command.configDigest}));
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
  /** Switch only the existing Codex channel. Claude attempts keep their own runners. */
  async prepareWorkerWorkspace(worker:WorkerDispatchContext){
    worker.beforeDispatch();this.idle();
    const id=worker.space.workspaceId;
    if(!id||!this.projects)throw new AppError('WORKSPACE_MISMATCH',409);
    if(id!==this.workspaceId){
      const w=this.projects.validate(id);this.switching=true;
      try{
        this.telemetry.disconnect();this.modelTracker.disconnect();
        const rpc=this.rpc;this.rpc=null;++this.generation;if(rpc)await rpc.close();
        worker.beforeDispatch();this.workspaceId=id;this.workspace=w.path;this.status('disconnected');
      }finally{this.switching=false;}
    }
    await this.connect();worker.beforeDispatch();
  }
  async submitTask(projectId:string,taskId:string,input:{requestId:string;workspaceId?:string;expectedAcceptanceDigest?:string},worker?:WorkerDispatchContext):Promise<Run>{
    if(worker&&this.workerScheduler){
      const reservation=this.workerScheduler.read(worker.fence.reservationId);
      const row=this.store.db.prepare('SELECT id FROM worker_http_batches WHERE id=?').get(reservation.batch.id);
      if(row){const original=worker;worker={...original,beforeDispatch:()=>{original.beforeDispatch();this.assertWorkerInputs(reservation.batch);this.assertWorkerInputs(reservation.batch,original.space.path);}};}
    }
    this.qualityAvailable();assertWorkerOwnership(this.store,projectId,taskId,worker);
    if(this.store.projects().some(project=>project.id===projectId&&project.kind==='general')&&!Object.hasOwn(input,'workspaceId')){
      if(Object.keys(input).length!==1||!Object.hasOwn(input,'requestId'))throw new AppError('INVALID_FIELDS',400);
      this.planningSuggestions.ensureAvailable(projectId);
      // Dispatch must match the stored execution choice; never swap runtimes silently.
      if(this.aiPreferences.read(projectId).execution!=='claude-code')throw new AppError('RUNTIME_NOT_SUPPORTED',409);
      return this.claudeTasks.submit(projectId,taskId,input.requestId,worker);
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
    return this.start({...input,prompt},task,acceptance??undefined,worker);
  }
  async submit(input:{requestId:string;prompt:string;workspaceId?:string|null}):Promise<Run>{return this.start(input);}
  private async start(input:{requestId:string;prompt:string;workspaceId?:string|null},task?:Pick<Run,'taskId'|'planningVersionId'|'planningContentHash'|'requirementLabels'>,acceptance?:TaskVerificationPreview,worker?:WorkerDispatchContext):Promise<Run>{
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
      this.store.append('run.runtime_source',run.id,{source:rpc.evidenceSource==='native'?'native':rpc.evidenceSource==='mock'?'mock':'unknown',interface:'codex.app_server'});
      worker?.beforeDispatch();
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
  async close(){await this.qualityLoops.close();await this.claudeTasks.close();await this.planningSuggestions.close();await this.reviews.close();await this.workflows.close();await this.modelHub.close();await this.verification.close();this.loseActive();this.telemetry.disconnect();this.modelTracker.disconnect();const rpc=this.rpc;this.rpc=null;++this.generation;if(rpc)await rpc.close();this.provider='disconnected';this.subscriptionUsage.disconnect('codex');this.usagePending=null;this.launchValidated=false;this.clearExtensions();}
}
