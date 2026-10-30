import {downloadHeaders} from './deliverables.ts';
import {CapabilityInvocationService} from './capability-invocation.ts';
import type {CapabilityInvocationInput} from '../shared/capability-invocation.ts';
import {enrichCapabilityValidation} from './capability-validation.ts';
import {createClaudeAuthenticationService} from './native-readiness.ts';
import type {NativeReadinessReport} from '../shared/native-readiness.ts';
import {CapabilityRuntimeAdapters} from './capability-runtime-adapters.ts';
import {CapabilityExecutionService} from './capability-execution.ts';
import type {CapabilityPlanInput,CapabilityExecutionApproval} from '../shared/capability-execution.ts';
import {discoverCapabilities} from './capability-adapters.ts';
import {CapabilityRoutingService} from './capability-routing.ts';
import type {CapabilityRouteInput} from '../shared/capability-routing.ts';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Controller,WorkerConfiguration } from './controller.ts';
import { AppError } from './controller.ts';
import { Studio,exact,studioError } from './studio.ts';
import { providerConnections,sendMock } from './providers/policy.ts';
import { buildCapabilityRegistry } from './capabilities.ts';
import { createNativeProbeService } from './capability-probe.ts';
import { PlanningHandoffService } from './planning-handoff-service.ts';
import { HandoffService } from './handoff-service.ts';
import { handoffHistory } from './handoff-history.ts';
import {controlPlaneStatus} from './control-plane.ts';
import {GoalService} from './goal-service.ts';
import {TaskGraphService} from './task-graph.ts';
import {ProjectProgressService} from './project-progress.ts';
import {FailureIntelligenceService} from './failure-intelligence-service.ts';
import {HarnessService} from './harness-service.ts';
import {AppPreviewHost} from './app-preview.ts';
import {approvedReuseDecisions,readReuseEvidence,vendorReuse} from './reuse-vendor.ts';
import type {PlanningVersion} from '../shared/parallel.ts';
import {assertGitProject} from './projects.ts';
import {quotaSignal,type ProgressSignals} from '../shared/project-progress.ts';
import {quotaFromClaudeWindows} from './runtimes/claude-task.ts';
import {claudeQuotaResetsAt} from './claude-task-service.ts';

function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
async function body(req:IncomingMessage,limit=18000):Promise<Record<string,unknown>>{
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new AppError('JSON_REQUIRED',415);
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw new AppError('BODY_TOO_LARGE',413);chunks.push(chunk);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw new AppError('INVALID_JSON',400);}
}
export function createHttpServer(controller:Controller,assets:string,options:{workers?:WorkerConfiguration;nativeProbe?:ReturnType<typeof createNativeProbeService>;runtimeAdapters?:CapabilityRuntimeAdapters;claudeAuthentication?:ReturnType<typeof createClaudeAuthenticationService>}={}){
  const studio=new Studio(controller.store);
  const handoff=new HandoffService(controller.store,studio);

  const taskGraphs=new TaskGraphService(controller.store);
  // Partial controllers (tests, embedded hosts) fall back to a reader without completion policy, i.e. 'wait'.
  const progress=controller.progress??new ProjectProgressService(controller.store,studio,{deliverables:id=>controller.deliverables(id),verification:(workspaceId,runId)=>controller.verification.view(workspaceId,runId)});
  const failureIntel=new FailureIntelligenceService(controller.store);
  // Partial controllers (tests) get a lazily built service; it still wires the HE-4 approval port, so promotion needs a fresh approval.
  let harnessFallback:HarnessService|null=null;
  const harness=()=>controller.harness??(harnessFallback??=new HarnessService(controller.store));
  const goals=new GoalService(controller.store,{
    progress:id=>progress.read(id,{}),deliverables:id=>controller.deliverableVersions?.references(id)??[],
  });
  const planningHandoff=new PlanningHandoffService(controller.store,(workspaceId,runId)=>controller.verification.view(workspaceId,runId),id=>controller.workspaceDiff(id));
  // Share the Controller's caches so registry readiness and the readiness API never diverge.
  const nativeProbe=options.nativeProbe??controller.nativeProbe??createNativeProbeService();
  const claudeAuthentication=options.claudeAuthentication??controller.claudeAuthentication??createClaudeAuthenticationService();
  const nativeReadiness=():NativeReadinessReport=>{
    const installation=nativeProbe.get(),connection=controller.snapshot().provider;
    return {codex:{installation:installation?.codex??{status:'unknown',version:null},authentication:connection==='ready'?'confirmed':'unknown',connection},
      claude:{installation:installation?.claude??{status:'unknown',version:null},authentication:claudeAuthentication.get()},
      actualModel:'unknown',liveValidation:'approval_required',costUsd:null,remainingQuota:null};
  };
  const capabilityRouting=new CapabilityRoutingService(controller.store);
  const runtimeAdapters=options.runtimeAdapters??new CapabilityRuntimeAdapters(controller);
  const capabilityRegistry=()=>{
    const registry=discoverCapabilities({probe:nativeProbe.get(),codexReady:controller.snapshot().provider==='ready',extensions:controller.extensionSnapshot()});
    return {...enrichCapabilityValidation(registry,controller.store),runtimeAdapters:registry.providers.map(provider=>runtimeAdapters.snapshot(provider.runtimeId,provider.version))};
  };
  const capabilityInvocation=new CapabilityInvocationService(controller.store,runtimeAdapters);
  const capabilityExecution=new CapabilityExecutionService(controller.store,controller,capabilityRegistry,runtimeAdapters,()=>nativeProbe.refresh());
  // Hosts that pass worker configuration (server/main.ts) bind and reconcile at startup; others bind on the first worker route,
  // so constructing the server stays inert for partial controllers.
  let workersBound=false;
  const bindWorkers=()=>{if(!workersBound){workersBound=true;controller.initializeWorkers(capabilityExecution,options.workers);}};
  if(options.workers)bindWorkers();
  const sessions=new Map<string,{csrf:string;expires:number}>();
  const appPreview=new AppPreviewHost(id=>controller.appPreviewSnapshot(id));
  // Same guards as the app preview: code project, the selected validated writable workspace; the decision comes only from Studio.
  const reuseWorkspace=(id:string)=>{controller.appPreviewSnapshot(id);return controller.store.workspaces().find(workspace=>workspace.id===id)!;};
  const approvedReuse=(projectId:string)=>approvedReuseDecisions(studio.read(projectId,'plans') as PlanningVersion[],lineage=>controller.store.db.prepare('SELECT version_id FROM planning_heads WHERE lineage_id=?').get(lineage)?.version_id as string|undefined);
  let previewReady:Promise<void>=Promise.resolve();
  const server=createServer((req,res)=>{void handle(req,res).catch(e=>{
    if(res.headersSent){res.end();return;}
    const error=e instanceof AppError?e:studioError(e);
    json(res,error?error.status:500,{error:error?error.message:'INTERNAL_ERROR'});
  });});
  server.requestTimeout=15000;server.headersTimeout=10000;
  // Synchronous work (git) can stall this process for several seconds. With Node's 5 s default the
  // server may close an idle keep-alive socket just as a client reuses it, failing that request
  // with ECONNRESET. Request/header limits above still bound slow or incomplete requests.
  server.keepAliveTimeout=60_000;
  server.once('listening',()=>{const address=server.address();if(address&&typeof address!=='string')previewReady=appPreview.listen('http://127.0.0.1:'+address.port).catch(()=>{});});
  const previewWorkspace=(event:{kind:string})=>{if(event.kind==='workspace.selected')appPreview.clear();};
  controller.store.on('event',previewWorkspace);
  server.once('close',()=>{if(workersBound)void controller.stopWorkers();controller.store.off('event',previewWorkspace);void appPreview.close();});
  async function handle(req:IncomingMessage,res:ServerResponse){
    await previewReady;
    const address=server.address();if(!address||typeof address==='string')throw new AppError('UNAVAILABLE',503);
    const host=`127.0.0.1:${address.port}`,origin=`http://${host}`;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; frame-src "+(appPreview.origin||"'none'"));
    const url=new URL(req.url??'/',origin);const cookieName=`aicc_${address.port}`;
    if(req.headers.host!==host || (req.headers.origin!==undefined&&req.headers.origin!==origin))throw new AppError('ORIGIN_REJECTED',403);
    if(url.pathname.startsWith('/api/') && (req.headers['sec-fetch-site']==='cross-site'||(req.headers.referer&&new URL(req.headers.referer).origin!==origin)))throw new AppError('ORIGIN_REJECTED',403);
    const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const session=cookie?sessions.get(cookie):undefined;
    if(req.method==='GET'&&url.pathname==='/api/session'){
      let csrf=session&&session.expires>Date.now()?session.csrf:null;
      if(!csrf){
        for(const [id,s] of sessions)if(s.expires<=Date.now())sessions.delete(id);
        if(sessions.size>=64)throw new AppError('SESSION_LIMIT',429);
        const id=randomBytes(32).toString('hex');csrf=randomBytes(32).toString('hex');sessions.set(id,{csrf,expires:Date.now()+12*3600000});
        res.setHeader('Set-Cookie',`${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
      }
      json(res,200,{csrfToken:csrf});return;
    }
    if(url.pathname.startsWith('/api/')){
      if(!session||session.expires<=Date.now())throw new AppError('SESSION_REQUIRED',401);
      const workerRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/worker-batches(?:\/([a-f0-9-]{36})(?:\/(submit))?)?$/);
      const integrationRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/integration-queue$/);
      if(workerRoute||integrationRoute)bindWorkers();
      if(req.method==='GET'&&workerRoute&&workerRoute[2]&&!workerRoute[3]){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        json(res,200,controller.workerBatch(workerRoute[1],workerRoute[2]));return;
      }
      if(req.method==='GET'&&integrationRoute){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        json(res,200,controller.workerIntegrationQueue(integrationRoute[1]));return;
      }
      const qualityRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/quality-loops(?:\/(preview|start|([a-f0-9-]{36})\/resume))?$/);
      if(req.method==='GET'&&qualityRoute&&!qualityRoute[2]){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        if(!controller.store.projects().some(p=>p.id===qualityRoute[1]))throw new AppError('PROJECT_NOT_FOUND',404);
        json(res,200,{records:controller.qualityLoops.records(qualityRoute[1])});return;
      }
      const failureIndexRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/failure-index$/);
      if(req.method==='GET'&&failureIndexRoute){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        json(res,200,failureIntel.view(failureIndexRoute[1]));return;
      }
      const harnessRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/harness(?:\/(candidates\/generate|proposals|evaluations|approvals|promotions|rollbacks|suite-cases|suite-cases\/remove))?$/);
      if(req.method==='GET'&&harnessRoute&&!harnessRoute[2]){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        json(res,200,harness().view(harnessRoute[1]));return;
      }
      const failureCaseRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/failure-cases(?:\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\/delete)?$/);
      const handoffLog=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/tasks\/([a-f0-9-]{36})\/handoff-history$/);
      if(req.method==='GET'&&handoffLog){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        if(!(studio.read(handoffLog[1],'tasks') as {id:string}[]).some(task=>task.id===handoffLog[2]))throw new AppError('TASK_NOT_FOUND',404);
        json(res,200,{entries:handoffHistory(controller.store,handoffLog[1],handoffLog[2])});return;
      }
      const taskHandoff=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/tasks\/([a-f0-9-]{36})\/handoff$/);
      if(req.method==='GET'&&taskHandoff){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        json(res,200,handoff.build(taskHandoff[1],taskHandoff[2]));return;
      }
      if(req.method==='GET'&&url.pathname==='/api/capability-orchestration'){
        if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,capabilityRegistry());return;
      }
      if(req.method==='GET'&&url.pathname==='/api/capability-orchestration/readiness'){
        if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,nativeReadiness());return;
      }
      const capabilityEvidence=url.pathname.match(/^\/api\/capability-orchestration\/evidence\/([a-f0-9]{64})$/);
      if(req.method==='GET'&&capabilityEvidence){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,capabilityRouting.discovery(capabilityEvidence[1]));return;}
      const invocationRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/capability-invocations$/);
      if(req.method==='GET'&&invocationRoute){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,{records:capabilityInvocation.records(invocationRoute[1])});return;}
      const executionRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/capability-executions(?:\/([a-f0-9-]{36})(?:\/(start|interrupt|recover|quality-preview|quality-start|quality-resume))?)?$/);
      if(req.method==='GET'&&executionRoute&&!executionRoute[3]){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        json(res,200,executionRoute[2]?capabilityExecution.record(executionRoute[1],executionRoute[2]):{records:capabilityExecution.records(executionRoute[1])});return;
      }
      const capabilityRoutes=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/capability-routes$/);
      if(req.method==='GET'&&capabilityRoutes){
        if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,{records:capabilityRouting.records(capabilityRoutes[1])});return;
      }
      const modelIdentity=url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})\/model-identity$/);
      if(req.method==='GET'&&modelIdentity){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        if(!controller.store.getRun(modelIdentity[1]))throw new AppError('RUN_NOT_FOUND',404);
        json(res,200,{runId:modelIdentity[1],attribution:controller.store.getCodexModelAttribution(modelIdentity[1])});return;
      }
      const soloOperation=url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})\/operation$/);
      if(req.method==='GET'&&soloOperation){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        if(!controller.store.getRun(soloOperation[1]))throw new AppError('RUN_NOT_FOUND',404);
        json(res,200,controller.store.soloOperation(soloOperation[1]));return;
      }
      const studioRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(plans|artifacts|tasks)(?:\/([a-f0-9-]{36})\/(revisions|approve|task-drafts|history|diff|replan))?$/);
      const registryRoute=url.pathname.match(/^\/api\/registry(?:\/entries(?:\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/(update|disable|validate))?)?)?$/);
      const taskGraphRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/task-graphs\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\/(revisions|history|state))?$/);
      const goalRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/goals(?:\/([a-f0-9-]{36})\/(state|history))?$/);
      const appPreviewRoute=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/app-preview$/);
      const reuseVendorRoute=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/reuse-vendor$/);
      const verificationSetupRoute=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/verification-setup$/);
      const aiPreferencesRoute=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/ai-preferences$/);
      if(req.method==='GET'&&aiPreferencesRoute){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        json(res,200,controller.aiPreferences.read(aiPreferencesRoute[1]));return;
      }
      const gitWorkspaceRoute=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})(?:\/|$)/);
      if(req.method==='GET'&&gitWorkspaceRoute)assertGitProject(controller.store,gitWorkspaceRoute[1]);
      if(req.method==='POST'){
        const token=req.headers['x-csrf-token'];
        if(req.headers.origin!==origin||typeof token!=='string'||token.length!==64||!timingSafeEqual(Buffer.from(token),Buffer.from(session.csrf)))throw new AppError('CSRF_REJECTED',403);
        const largeStudioInput=studioRoute&&studioRoute[2]!=='tasks'&&(!studioRoute[3]||studioRoute[4]==='revisions');
        const planningSuggestion=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/planning-suggestions\/(preview|start|recover|([a-f0-9-]{36})\/(interrupt|save))$/);
        const materialsPost=/^\/api\/projects\/[a-f0-9-]{36}\/materials(?:\/replace)?$/.test(url.pathname);
        const data=await body(req,largeStudioInput?6*256*1024+256*1024:materialsPost?10*(128*1024+512):planningSuggestion?64000:taskGraphRoute?1024*1024+4096:18000);
        const observeDeliverables=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/deliverables\/observe$/);
        if(observeDeliverables){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,[]);
          json(res,200,controller.observeDeliverables(observeDeliverables[1]));return;
        }
        if(failureCaseRoute){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          if(failureCaseRoute[2]){exact(data,['confirmed']);json(res,200,failureIntel.deleteCase(failureCaseRoute[1],failureCaseRoute[2],data.confirmed as boolean));return;}
          exact(data,['requestId','failureId','confirmed']);
          json(res,200,failureIntel.createCase(failureCaseRoute[1],data as {requestId:string;failureId:string;confirmed:boolean}));return;
        }
        if(harnessRoute&&harnessRoute[2]){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          const projectId=harnessRoute[1],service=harness();
          switch(harnessRoute[2]){
            case 'candidates/generate':exact(data,[]);json(res,200,service.generate(projectId));return;
            case 'proposals':exact(data,['requestId','target','line','evidence','confirmed']);json(res,200,service.propose(projectId,data as unknown as Parameters<HarnessService['propose']>[1]));return;
            case 'evaluations':exact(data,['requestId','candidateVersionId','liveApproval']);json(res,200,await service.evaluate(projectId,data as unknown as Parameters<HarnessService['evaluate']>[1]));return;
            case 'approvals':exact(data,['requestId','evaluationId','candidateDigest','evaluationDigest','expectedSequence','confirmed']);json(res,200,service.approve(projectId,data as unknown as Parameters<HarnessService['approve']>[1]));return;
            case 'promotions':exact(data,['requestId','target','versionId','fromVersionId','expectedSequence','candidateDigest','evaluationDigest']);json(res,200,service.promote(projectId,data as unknown as Parameters<HarnessService['promote']>[1]));return;
            case 'suite-cases':exact(data,['requestId','runId','taskId','target','protected','confirmed']);json(res,200,service.registerSuiteCase(projectId,data as unknown as Parameters<HarnessService['registerSuiteCase']>[1],id=>progress.read(id,{})));return;
            case 'suite-cases/remove':exact(data,['requestId','caseId','confirmed']);json(res,200,service.removeSuiteCase(projectId,data as unknown as Parameters<HarnessService['removeSuiteCase']>[1]));return;
            case 'rollbacks':exact(data,['requestId','target','versionId','fromVersionId','expectedSequence','confirmed']);json(res,200,service.rollback(projectId,data as unknown as Parameters<HarnessService['rollback']>[1]));return;
          }
        }
        if(qualityRoute){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          const projectId=qualityRoute[1],action=qualityRoute[2];
          if(action==='preview'){
            exact(data,['sourceRunId','reviewers','limits']);
            json(res,200,controller.qualityLoops.preview(projectId,data.sourceRunId as string,data.reviewers as Parameters<typeof controller.qualityLoops.preview>[2],data.limits as Parameters<typeof controller.qualityLoops.preview>[3]));return;
          }
          if(action==='start'){
            exact(data,['requestId','sourceRunId','reviewers','limits','expectedPreviewDigest','confirmed']);
            json(res,200,controller.qualityLoops.start({...data,projectId} as Parameters<typeof controller.qualityLoops.start>[0]));return;
          }
          if(qualityRoute[3]){
            exact(data,[]);
            if(controller.qualityLoops.record(qualityRoute[3]).projectId!==projectId)throw new AppError('QUALITY_LOOP_NOT_FOUND',404);
            json(res,200,await controller.qualityLoops.resume(qualityRoute[3]));return;
          }
          throw new AppError('INVALID_FIELDS',400);
        }
        if(aiPreferencesRoute){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['expectedRevision','planning','execution']);
          json(res,200,controller.aiPreferences.update(aiPreferencesRoute[1],data as unknown as Parameters<Controller['aiPreferences']['update']>[1]));return;
        }
        if(gitWorkspaceRoute)assertGitProject(controller.store,gitWorkspaceRoute[1]);
        if(verificationSetupRoute){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['requestId','profileId','expectedPreviewDigest','confirmed']);
          json(res,200,controller.configureVerification(verificationSetupRoute[1],data as unknown as Parameters<Controller['configureVerification']>[1]));return;
        }
        if(reuseVendorRoute){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['planningVersionId','topic']);
          if(typeof data.planningVersionId!=='string'||typeof data.topic!=='string')throw new AppError('INVALID_FIELDS',400);
          const id=reuseVendorRoute[1],guard=()=>{reuseWorkspace(id);controller.assertAppPreviewAvailable();};guard();const workspace=reuseWorkspace(id);
          json(res,200,await vendorReuse({workspacePath:workspace.path,approved:approvedReuse(workspace.projectId),planningVersionId:data.planningVersionId,topic:data.topic,beforeWrite:()=>{guard();return approvedReuse(workspace.projectId);}}));return;
        }
        if(appPreviewRoute){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['entryPath','expectedSourceDigest']);controller.assertAppPreviewAvailable();
          json(res,200,appPreview.create(appPreviewRoute[1],data as unknown as Parameters<AppPreviewHost['create']>[1]));return;
        }
        if(registryRoute&&url.pathname!=='/api/registry'){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          const [,entryId,action]=registryRoute;
          if(!entryId){json(res,200,controller.modelRegistry.create(data));return;}
          if(action==='update'){json(res,200,controller.modelRegistry.update(entryId,data));return;}
          if(action==='disable'){json(res,200,controller.modelRegistry.disable(entryId,data));return;}
          if(action==='validate'){
            // The browser names a project; only the server maps it to a path, so a client path is never trusted.
            const {projectId,...rest}=data;
            if(rest.kind!=='connection'){if(projectId!==undefined)throw new AppError('INVALID_FIELDS',400);json(res,200,await controller.modelRegistry.validate(entryId,rest));return;}
            const project=typeof projectId==='string'?controller.store.projects().find(item=>item.id===projectId):undefined;
            if(!project)throw new AppError('PROJECT_NOT_FOUND',404);
            json(res,200,await controller.modelRegistry.validate(entryId,{...rest,projectPath:project.path}));return;
          }
          throw new AppError('NOT_FOUND',404);
        }
        if(taskGraphRoute){
          // Graph editing is not planning approval or execution authorization; the path owns the planning version.
          if(url.search||taskGraphRoute[3]!=='revisions')throw new AppError('NOT_FOUND',404);
          if(Object.hasOwn(data,'planningVersionId'))throw new AppError('INVALID_FIELDS',400);
          json(res,200,taskGraphs.save(taskGraphRoute[1],{...data,planningVersionId:taskGraphRoute[2]} as unknown as Parameters<TaskGraphService['save']>[1]));return;
        }
        if(goalRoute){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          if(!goalRoute[2]){json(res,200,goals.create(goalRoute[1],data as unknown as Parameters<GoalService['create']>[1]));return;}
          if(goalRoute[3]==='state'){json(res,200,goals.setState(goalRoute[1],goalRoute[2],data as unknown as Parameters<GoalService['setState']>[2]));return;}
          throw new AppError('NOT_FOUND',404);
        }
        if(planningSuggestion){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          const projectId=planningSuggestion[1],action=planningSuggestion[2],id=planningSuggestion[3];
          // Only general projects may omit the workspace; the controller/service
          // retain project ownership and selected-workspace validation.
          if(controller.store.projects().some(project=>project.id===projectId&&project.kind==='general')&&!Object.hasOwn(data,'workspaceId'))data.workspaceId=null;
          if(action==='preview'){
            exact(data,['workspaceId','text']);json(res,200,controller.previewPlanning(projectId,data as unknown as Parameters<Controller['previewPlanning']>[1]));return;
          }
          if(action==='start'){
            exact(data,['requestId','workspaceId','text','expectedPreviewDigest','confirmed']);json(res,200,controller.startPlanning(projectId,data as unknown as Parameters<Controller['startPlanning']>[1]));return;
          }
          if(action==='recover'){
            exact(data,['workspaceId','suggestionId','confirmedStopped']);json(res,200,controller.recoverPlanning(projectId,data as unknown as Parameters<Controller['recoverPlanning']>[1]));return;
          }
          if(planningSuggestion[4]==='interrupt'){
            exact(data,['workspaceId']);json(res,200,controller.interruptPlanning(projectId,id,data.workspaceId as string|null));return;
          }
          exact(data,['workspaceId','expectedOutputDigest']);json(res,200,controller.savePlanningDraft(projectId,id,data as unknown as Parameters<Controller['savePlanningDraft']>[2]));return;
        }
        const planningFeedback=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/planning-feedback$/);
        if(planningFeedback){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          json(res,200,planningHandoff.create(planningFeedback[1],data));return;
        }
        if(['/api/merges/prepare','/api/merges/apply','/api/merges/recover'].includes(url.pathname)){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          if(url.pathname.endsWith('/prepare')){
            exact(data,['requestId','workspaceId','runId','expectedSourceDigest','expectedCheckSetDigest','expectedApprovalId','expectedTargetBranch','expectedTargetHead']);
            if(typeof data.workspaceId!=='string'||!/^[a-f0-9-]{36}$/.test(data.workspaceId))throw new AppError('INVALID_FIELDS',400);
            json(res,200,controller.prepareMerge(data as unknown as Parameters<Controller['prepareMerge']>[0]));return;
          }
          if(typeof data.recordId!=='string'||!/^[a-f0-9-]{36}$/.test(data.recordId))throw new AppError('INVALID_FIELDS',400);
          if(url.pathname.endsWith('/apply')){
            exact(data,['requestId','recordId','expectedCommitSha','confirmed']);
            json(res,200,controller.applyMerge(data as unknown as Parameters<Controller['applyMerge']>[0]));return;
          }
          exact(data,['recordId','confirmedStopped']);
          json(res,200,controller.recoverMerge(data as unknown as Parameters<Controller['recoverMerge']>[0]));return;
        }
        const workflowSave=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/workflows$/);
        if(workflowSave){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,controller.workflows.save(workflowSave[1],data as unknown as Parameters<typeof controller.workflows.save>[1]));return;}
        if(url.pathname==='/api/workflows/start'){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          exact(data,['requestId','workspaceId','workflowId','expectedVersionId','expectedPreviewDigest','confirmed','retryOfId']);
          json(res,200,controller.startWorkflow(data as unknown as Parameters<Controller['startWorkflow']>[0]));return;
        }
        if(url.pathname==='/api/workflows/recover'){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['runId','confirmedStopped']);
          if(typeof data.runId!=='string'||!/^[a-f0-9-]{36}$/.test(data.runId))throw new AppError('INVALID_FIELDS',400);
          json(res,200,controller.recoverWorkflow(data as unknown as Parameters<Controller['recoverWorkflow']>[0]));return;
        }
        const workflowInterrupt=url.pathname.match(/^\/api\/workflows\/([a-f0-9-]{36})\/interrupt$/);
        if(workflowInterrupt){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['workspaceId']);
          if(typeof data.workspaceId!=='string'||!/^[a-f0-9-]{36}$/.test(data.workspaceId))throw new AppError('INVALID_FIELDS',400);
          json(res,200,controller.interruptWorkflow(data.workspaceId,workflowInterrupt[1]));return;
        }
        if(url.pathname==='/api/capability-orchestration/readiness/refresh'){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,[]);controller.assertExecutionAvailable();
          const installation=await nativeProbe.refresh();
          if(installation.claude.status==='found'&&runtimeAdapters.snapshot('claude-code',installation.claude.version).compatible)await claudeAuthentication.refresh();
          json(res,200,nativeReadiness());return;
        }
        if(url.pathname==='/api/capability-orchestration/refresh'){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,[]);
          controller.assertExecutionAvailable();await nativeProbe.refresh();const registry=capabilityRegistry();capabilityRouting.recordDiscovery(registry);json(res,200,registry);return;
        }
        if(workerRoute){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          if(!workerRoute[2]){json(res,200,controller.createWorkerBatch(workerRoute[1],data));return;}
          if(workerRoute[3]==='submit'){json(res,200,await controller.submitWorkerBatch(workerRoute[1],workerRoute[2],data));return;}
          throw new AppError('INVALID_FIELDS',400);
        }
        const toolRoute=url.pathname.match(/^\/api\/tool-invocations\/(preview|approve|invoke)$/);
        if(toolRoute){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          const service=controller.toolInvocations;
          json(res,200,toolRoute[1]==='preview'?service.previewApproval(data):toolRoute[1]==='approve'?service.approve(data):await service.invoke(data));return;
        }
        if(invocationRoute){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,await capabilityInvocation.invoke(invocationRoute[1],data as unknown as CapabilityInvocationInput));return;}
        if(executionRoute){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          const projectId=executionRoute[1],id=executionRoute[2],action=executionRoute[3];
          if(!id){json(res,200,capabilityExecution.plan(projectId,data as unknown as CapabilityPlanInput));return;}
          if(action==='start'){json(res,200,await capabilityExecution.start(projectId,id,data as unknown as CapabilityExecutionApproval));return;}
          if(action==='interrupt'||action==='recover'){exact(data,[]);json(res,200,await capabilityExecution[action](projectId,id));return;}
          if(action==='quality-resume'){exact(data,[]);json(res,200,await capabilityExecution.resumeQuality(projectId,id));return;}
          if(action==='quality-preview'){exact(data,['reviewers','limits']);json(res,200,capabilityExecution.qualityPreview(projectId,id,data.reviewers as Parameters<typeof capabilityExecution.qualityPreview>[2],data.limits as Parameters<typeof capabilityExecution.qualityPreview>[3]));return;}
          if(action==='quality-start'){exact(data,['requestId','reviewers','limits','expectedPreviewDigest','confirmed']);json(res,200,capabilityExecution.startQuality(projectId,id,data as unknown as Parameters<typeof capabilityExecution.startQuality>[2]));return;}
          throw new AppError('INVALID_FIELDS',400);
        }
        if(capabilityRoutes){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          json(res,200,capabilityRouting.recommend(capabilityRoutes[1],data as unknown as CapabilityRouteInput,capabilityRegistry()));return;
        }
        if(url.pathname==='/api/capabilities/probe'){
          exact(data,[]);
          controller.assertExecutionAvailable();
          const probe=await nativeProbe.refresh();
          json(res,200,buildCapabilityRegistry(controller.snapshot().provider,probe));return;
        }
        if(url.pathname==='/api/usage/refresh'){exact(data,[]);json(res,200,await controller.refreshUsage());return;}
        if(url.pathname==='/api/extensions/refresh'){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['workspaceId']);
          json(res,200,await controller.refreshExtensions(data as {workspaceId:string|null}));return;
        }
        if(url.pathname==='/api/reviews/start'){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['requestId','workspaceId','runId','expectedPreviewDigest','confirmed']);
          json(res,200,controller.startReview(data as unknown as Parameters<Controller['startReview']>[0]));return;
        }
        if(url.pathname==='/api/reviews/recover'){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['reviewId','confirmedStopped']);
          if(typeof data.reviewId!=='string'||!/^[a-f0-9-]{36}$/.test(data.reviewId)||typeof data.confirmedStopped!=='boolean')throw new AppError('INVALID_FIELDS',400);
          json(res,200,controller.recoverReview(data as unknown as Parameters<Controller['recoverReview']>[0]));return;
        }
        const reviewRepair=url.pathname.match(/^\/api\/reviews\/([a-f0-9-]{36})\/repair$/);
        if(reviewRepair){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,await controller.startReviewRepair(reviewRepair[1],data));return;}
        const reviewInterrupt=url.pathname.match(/^\/api\/reviews\/([a-f0-9-]{36})\/interrupt$/);
        if(reviewInterrupt){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['workspaceId']);
          if(typeof data.workspaceId!=='string'||!/^[a-f0-9-]{36}$/.test(data.workspaceId))throw new AppError('INVALID_FIELDS',400);
          json(res,200,controller.interruptReview(data.workspaceId,reviewInterrupt[1]));return;
        }
        const modelCatalog=url.pathname.match(/^\/api\/model-hub\/destinations\/([A-Za-z0-9_-]{1,64})\/models$/);
        if(modelCatalog){
          exact(data,['projectId','expectedConfigDigest','confirmed']);
          if(typeof data.projectId!=='string'||!/^[a-f0-9-]{36}$/.test(data.projectId)||typeof data.expectedConfigDigest!=='string'||!/^[a-f0-9]{64}$/.test(data.expectedConfigDigest)||typeof data.confirmed!=='boolean')throw new AppError('INVALID_FIELDS',400);
          json(res,200,await controller.modelHub.diagnose(modelCatalog[1],data as {projectId:string;expectedConfigDigest:string;confirmed:boolean}));return;
        }
        if(url.pathname==='/api/model-hub/requests'){
          exact(data,['requestId','projectId','destinationId','model','text','expectedConfigDigest','confirmed']);
          if(typeof data.projectId!=='string'||!/^[a-f0-9-]{36}$/.test(data.projectId)||typeof data.destinationId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(data.destinationId)||typeof data.model!=='string'||typeof data.expectedConfigDigest!=='string'||!/^[a-f0-9]{64}$/.test(data.expectedConfigDigest)||typeof data.confirmed!=='boolean')throw new AppError('INVALID_FIELDS',400);
          json(res,200,controller.startModelRequest(data as Parameters<Controller['startModelRequest']>[0]));return;
        }
        const modelInterrupt=url.pathname.match(/^\/api\/model-hub\/requests\/([a-f0-9-]{36})\/interrupt$/);
        if(modelInterrupt){exact(data,['projectId']);if(typeof data.projectId!=='string'||!/^[a-f0-9-]{36}$/.test(data.projectId))throw new AppError('INVALID_FIELDS',400);controller.modelHub.interrupt(data.projectId,modelInterrupt[1]);json(res,200,{ok:true});return;}
        const modelCleanup=url.pathname.match(/^\/api\/model-hub\/requests\/([a-f0-9-]{36})\/cleanup$/);
        if(modelCleanup){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['projectId','confirmedStopped']);
          if(typeof data.projectId!=='string'||!/^[a-f0-9-]{36}$/.test(data.projectId)||typeof data.confirmedStopped!=='boolean')throw new AppError('INVALID_FIELDS',400);
          json(res,200,await controller.modelHub.cleanup(data.projectId,modelCleanup[1],data.confirmedStopped));return;
        }
        const sourceGraph=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/source-graph(\/artifact)?$/);
        if(sourceGraph){
          if(sourceGraph[2]){
            exact(data,['requestId','recordId','expectedSourceDigest']);
            if(typeof data.requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(data.requestId)||typeof data.recordId!=='string'||!/^[a-f0-9-]{36}$/.test(data.recordId)||typeof data.expectedSourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(data.expectedSourceDigest))throw new AppError('INVALID_FIELDS',400);
            json(res,200,controller.sourceGraphArtifact(sourceGraph[1],data as {requestId:string;recordId:string;expectedSourceDigest:string}));
          }else{exact(data,[]);json(res,200,controller.analyzeSourceGraph(sourceGraph[1]));}
          return;
        }
        const verification=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/(checks|review-approval)(?:\/([a-f0-9-]{36})\/(interrupt|acknowledge-stopped))?$/);
        if(verification){
          const workspaceId=verification[1];
          if(verification[2]==='checks'&&!verification[3]){
            exact(data,['requestId','runId','commandId','expectedSourceDigest','expectedConfigDigest']);
            json(res,200,controller.startVerification({...data,workspaceId} as Parameters<Controller['startVerification']>[0]));return;
          }
          if(verification[2]==='review-approval'&&!verification[3]){
            exact(data,['requestId','runId','expectedSourceDigest','expectedCheckSetDigest']);
            json(res,200,controller.approveVerification({...data,workspaceId} as Parameters<Controller['approveVerification']>[0]));return;
          }
          if(verification[2]==='checks'&&verification[3]){
            if(controller.snapshot().selectedWorkspaceId!==workspaceId)throw new AppError('WORKSPACE_MISMATCH',409);
            if(verification[4]==='interrupt'){exact(data,[]);controller.verification.interrupt(workspaceId,verification[3]);}
            else {exact(data,['confirmedStopped']);if(data.confirmedStopped!==true)throw new AppError('INVALID_FIELDS',400);controller.verification.acknowledgeStopped(workspaceId,verification[3]);}
            json(res,200,{ok:true});return;
          }
        }
        if(studioRoute&&studioRoute[2]!=='tasks'){
          if((studioRoute[4]==='replan'||studioRoute[4]==='diff')&&url.search)throw new AppError('INVALID_FIELDS',400);
          json(res,200,studio.mutate(studioRoute[1],studioRoute[2],studioRoute[3],studioRoute[4],data));return;
        }
        const claudeRecover=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/claude-runs\/([a-f0-9-]{36})\/recover$/);
        if(claudeRecover){
          if(url.search)throw new AppError('INVALID_FIELDS',400);
          exact(data,['requestId','confirmedStopped']);
          if(typeof data.requestId!=='string'||typeof data.confirmedStopped!=='boolean')throw new AppError('INVALID_FIELDS',400);
          json(res,200,controller.recoverClaudeRun(claudeRecover[1],claudeRecover[2],{requestId:data.requestId,confirmedStopped:data.confirmedStopped}));return;
        }
        const taskRun=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/tasks\/([a-f0-9-]{36})\/run$/);
        if(taskRun){
          // A workspace-bound request keeps the code-project path, which answers GIT_REQUIRED for general projects.
          if(!Object.hasOwn(data,'workspaceId')&&controller.store.projects().some(project=>project.id===taskRun[1]&&project.kind==='general')){
            exact(data,['requestId']);
            if(typeof data.requestId!=='string')throw new AppError('INVALID_FIELDS',400);
            json(res,200,await controller.submitTask(taskRun[1],taskRun[2],{requestId:data.requestId}));return;
          }
          exact(data,['requestId','workspaceId',...(Object.hasOwn(data,'expectedAcceptanceDigest')?['expectedAcceptanceDigest']:[])]);
          if(Object.hasOwn(data,'expectedAcceptanceDigest')&&(typeof data.expectedAcceptanceDigest!=='string'||!/^[a-f0-9]{64}$/.test(data.expectedAcceptanceDigest)))throw new AppError('INVALID_FIELDS',400);
          if(typeof data.requestId!=='string'||typeof data.workspaceId!=='string'||!/^[a-f0-9-]{36}$/.test(data.workspaceId))throw new AppError('INVALID_FIELDS',400);
          json(res,200,await controller.submitTask(taskRun[1],taskRun[2],data as Parameters<Controller['submitTask']>[2]));return;
        }
        if(url.pathname==='/api/providers/mock/send'){
          exact(data,['providerId','text']);
          const result=await sendMock(data.providerId,data.text);
          controller.store.append(result.ok?'provider.mock_completed':'guardrail.denied',null,{mode:'mock_only',code:result.ok?'MOCK_ONLY':result.code});
          if(!result.ok)throw new AppError(result.code,422);
          json(res,200,{...result,mode:'mock_only',externalApiEnabled:false});return;
        }
        const materialsRoute=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/materials$/);
        if(materialsRoute){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,controller.addMaterials(materialsRoute[1],data));return;}
        const replaceRoute=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/materials\/replace$/);
        if(replaceRoute){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,controller.replaceMaterial(replaceRoute[1],data));return;}
        if(url.pathname==='/api/projects/register-folder'){
          exact(data,['requestId','name','path']);
          if(url.search||typeof data.requestId!=='string'||typeof data.name!=='string'||typeof data.path!=='string')throw new AppError('INVALID_FIELDS',400);
          json(res,200,controller.registerGeneralFolder({requestId:data.requestId,name:data.name,path:data.path}));return;
        }
        if(url.pathname==='/api/projects/create'){
          exact(data,['requestId','name',...(Object.hasOwn(data,'kind')?['kind']:[])]);
          if(url.search||typeof data.requestId!=='string'||typeof data.name!=='string'||(Object.hasOwn(data,'kind')&&data.kind!=='code'&&data.kind!=='general'))throw new AppError('INVALID_FIELDS',400);
          json(res,200,controller.createProject({requestId:data.requestId,name:data.name,...(Object.hasOwn(data,'kind')?{kind:data.kind as 'code'|'general'}:{})}));return;
        }
        if(url.pathname==='/api/projects'){
          if(Object.keys(data).join(',')!=='path'||typeof data.path!=='string')throw new AppError('INVALID_FIELDS',400);
          json(res,200,controller.registerProject(data.path));return;
        }
        if(url.pathname==='/api/workspaces'||url.pathname==='/api/workspaces/select'){
          const key=url.pathname.endsWith('/select')?'workspaceId':'projectId';
          if(Object.keys(data).join(',')!==key||typeof data[key]!=='string'||!/^[a-f0-9-]{36}$/.test(data[key] as string))throw new AppError('INVALID_FIELDS',400);
          if(key==='projectId')json(res,200,controller.createWorktree(data[key] as string));
          else{await controller.selectWorkspace(data[key] as string);json(res,200,controller.snapshot());}return;
        }
        if(url.pathname==='/api/connect'){
          if(Object.keys(data).length)throw new AppError('INVALID_FIELDS',400);await controller.connect();json(res,200,controller.snapshot());return;
        }
        if(url.pathname==='/api/runs'){
          if(Object.keys(data).sort().join(',')!=='prompt,requestId,workspaceId'||(data.workspaceId!==null&&(typeof data.workspaceId!=='string'||!/^[a-f0-9-]{36}$/.test(data.workspaceId))))throw new AppError('INVALID_FIELDS',400);
          const run=await controller.submit(data as {requestId:string;prompt:string;workspaceId:string|null});json(res,200,run);return;
        }
        const match=url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})\/interrupt$/);
        if(match){if(Object.keys(data).length)throw new AppError('INVALID_FIELDS',400);await controller.interrupt(match[1]);json(res,200,controller.snapshot());return;}
      }
      const materialsView=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/materials$/);
      if(req.method==='GET'&&materialsView){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,controller.materials(materialsView[1]));return;}
      const downloadRoute=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/deliverables\/([a-f0-9]{64})\/(download|versions)(?:\/([a-f0-9-]{36})\/download)?$/);
      if(req.method==='GET'&&downloadRoute){
        if(url.search||downloadRoute[3]==='download'&&downloadRoute[4])throw new AppError('INVALID_FIELDS',400);
        const [,projectId,id,action,versionId]=downloadRoute;
        if(action==='versions'&&!versionId){json(res,200,controller.deliverableHistory(projectId,id));return;}
        const file=controller.deliverableDownload(projectId,id,versionId);
        res.writeHead(200,downloadHeaders(file));res.end(file.bytes);return;
      }
      const deliverablesRoute=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/deliverables(\/preview)?$/);
      if(req.method==='GET'&&deliverablesRoute){
        const keys=[...url.searchParams.keys()];
        if(!deliverablesRoute[2]){if(keys.length)throw new AppError('INVALID_FIELDS',400);json(res,200,controller.deliverables(deliverablesRoute[1]));return;}
        const path=url.searchParams.get('path');if(keys.join(',')!=='path'||!path)throw new AppError('INVALID_FIELDS',400);
        json(res,200,controller.deliverablePreview(deliverablesRoute[1],path));return;
      }
      const progressRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/progress$/);
      if(req.method==='GET'&&progressRoute){
        // Read-only: signals come from the current snapshot and cached usage; nothing is refreshed or started.
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        const state=controller.snapshot();
        // Headroom needs a fresh subscription observation; a stale rejection still blocks new runs (conservative).
        const current=(runtimeId:string,quota:NonNullable<ProgressSignals['quota']>)=>quota==='available'&&!(controller.subscriptionUsage?.snapshot()??[]).some(entry=>entry.observation.runtimeId===runtimeId&&entry.observation.freshness==='fresh')?'unknown':quota;
        // Signals follow the project's runtime: general projects run on Claude Code, code projects on Codex.
        const general=controller.store.projects().some(project=>project.id===progressRoute[1]&&project.kind==='general');
        if(!general){json(res,200,progress.read(progressRoute[1],{provider:state.provider,recoveryRequired:!!state.soloRecoveryRequired,quota:current('codex',quotaSignal(controller.usageSnapshot()))}));return;}
        const claudeQuota=controller.claudeQuota();
        json(res,200,{...progress.read(progressRoute[1],{recoveryRequired:!!state.soloRecoveryRequired,quota:current('claude-code',quotaFromClaudeWindows(claudeQuota)),quotaResetsAt:claudeQuotaResetsAt(claudeQuota)}),
          claudeRecovery:controller.claudeRecoveries(progressRoute[1])});return;
      }
      if(req.method==='GET'&&registryRoute&&!registryRoute[2]){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        if(url.pathname==='/api/registry'){json(res,200,controller.modelRegistry.list());return;}
        if(!registryRoute[1])throw new AppError('NOT_FOUND',404);
        json(res,200,{entry:controller.modelRegistry.get(registryRoute[1]),validations:controller.modelRegistry.validations(registryRoute[1])});return;
      }
      if(req.method==='GET'&&taskGraphRoute){
        const [,projectId,versionId,action]=taskGraphRoute,keys=[...url.searchParams.keys()],raw=url.searchParams.get('revision');
        if(action==='revisions'||action==='history'&&keys.length||keys.some(key=>key!=='revision')||keys.length>1||raw!==null&&!/^[1-9][0-9]{0,8}$/.test(raw))throw new AppError('INVALID_FIELDS',400);
        const revision=raw===null?undefined:Number(raw);
        if(action==='history'){json(res,200,taskGraphs.history(projectId,versionId));return;}
        if(!action){json(res,200,taskGraphs.read(projectId,versionId,revision));return;}
        json(res,200,progress.graph(projectId,versionId,revision).state);return;
      }
      if(req.method==='GET'&&goalRoute){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        if(!goalRoute[2]){json(res,200,goals.list(goalRoute[1]));return;}
        if(goalRoute[3]==='history'){json(res,200,goals.history(goalRoute[1],goalRoute[2]));return;}
        throw new AppError('NOT_FOUND',404);
      }
      if(req.method==='GET'&&url.pathname==='/api/control-plane'){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,controlPlaneStatus(controller.snapshot().provider));return;}
      if(req.method==='GET'&&url.pathname==='/api/capabilities'){json(res,200,buildCapabilityRegistry(controller.snapshot().provider,nativeProbe.get()));return;}
      if(req.method==='GET'&&url.pathname==='/api/usage/subscriptions'){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,controller.subscriptionUsage?.snapshot()??[]);return;}
      if(req.method==='GET'&&url.pathname==='/api/usage'){json(res,200,controller.usageSnapshot());return;}
      const analyticsRoute=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/analytics$/);
      if(req.method==='GET'&&analyticsRoute){
        const keys=[...url.searchParams.keys()],limit=url.searchParams.get('limit'),cursor=url.searchParams.get('cursor');
        if(new Set(keys).size!==keys.length||keys.some(key=>!['limit','cursor'].includes(key))||limit!==null&&!/^[1-9][0-9]?$/.test(limit)||cursor!==null&&!cursor)throw new AppError('INVALID_FIELDS',400);
        json(res,200,controller.projectAnalytics(analyticsRoute[1],{...(limit===null?{}:{limit:Number(limit)}),...(cursor===null?{}:{cursor})}));return;
      }
      if(req.method==='GET'&&url.pathname==='/api/extensions'){
        if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,controller.extensionSnapshot());return;
      }
      if(req.method==='GET'&&url.pathname==='/api/model-hub'){
        const projectId=url.searchParams.get('projectId');
        if(url.search&&([...url.searchParams.keys()].join(',')!=='projectId'||!projectId||!/^[a-f0-9-]{36}$/.test(projectId)))throw new AppError('INVALID_FIELDS',400);
        json(res,200,controller.modelHub.view(projectId));return;
      }
      const sourceGraphView=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/source-graph(?:\/files\/([A-Za-z0-9_-]{1,100}))?$/);
      if(req.method==='GET'&&sourceGraphView){
        if(sourceGraphView[2]){
          const recordId=url.searchParams.get('recordId');
          if([...url.searchParams.keys()].join(',')!=='recordId'||!recordId||!/^[a-f0-9-]{36}$/.test(recordId))throw new AppError('INVALID_FIELDS',400);
          json(res,200,controller.sourceGraphs.file(sourceGraphView[1],recordId,sourceGraphView[2]));
        }else{if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,controller.sourceGraphs.view(sourceGraphView[1]));}
        return;
      }
      const planningSuggestionsView=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/planning-suggestions$/);
      if(req.method==='GET'&&planningSuggestionsView){
        const workspaceId=url.searchParams.get('workspaceId');
        const general=controller.store.projects().some(project=>project.id===planningSuggestionsView[1]&&project.kind==='general');
        if(!(general&&!url.search)&&([...url.searchParams.keys()].join(',')!=='workspaceId'||!workspaceId||!/^[a-f0-9-]{36}$/.test(workspaceId)))throw new AppError('INVALID_FIELDS',400);
        json(res,200,controller.planningSuggestions.view(planningSuggestionsView[1],workspaceId));return;
      }
      const verificationView=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/verification$/);
      if(req.method==='GET'&&verificationSetupRoute){
        if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,controller.verificationSetupView(verificationSetupRoute[1]));return;
      }
      const taskVerificationPreview=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/tasks\/([a-f0-9-]{36})\/verification-preview$/);
      if(req.method==='GET'&&taskVerificationPreview){
        const workspaceId=url.searchParams.get('workspaceId');
        if([...url.searchParams.keys()].join(',')!=='workspaceId'||!workspaceId||!/^[a-f0-9-]{36}$/.test(workspaceId))throw new AppError('INVALID_FIELDS',400);
        json(res,200,{preview:controller.taskVerificationPreview(taskVerificationPreview[1],taskVerificationPreview[2],workspaceId)});return;
      }
      const reviewView=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/reviews(\/preview)?$/);
      if(req.method==='GET'&&reviewView){
        const keys=[...url.searchParams.keys()],runId=url.searchParams.get('runId');
        if(keys.length>1||keys.length===1&&(keys[0]!=='runId'||!runId||!/^[a-f0-9-]{36}$/.test(runId)))throw new AppError('INVALID_FIELDS',400);
        json(res,200,reviewView[2]?controller.reviews.preview(reviewView[1],runId):controller.reviewView(reviewView[1],runId));return;
      }
      const reviewRepairPreview=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/reviews\/([a-f0-9-]{36})\/repair-preview$/);
      if(req.method==='GET'&&reviewRepairPreview){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,controller.previewReviewRepair(reviewRepairPreview[1],reviewRepairPreview[2]));return;}
      if(req.method==='GET'&&verificationView){
        const keys=[...url.searchParams.keys()];
        const runId=url.searchParams.get('runId');
        if(keys.length>1||(keys.length===1&&(keys[0]!=='runId'||!runId||!/^[a-f0-9-]{36}$/.test(runId))))throw new AppError('INVALID_FIELDS',400);
        json(res,200,controller.verification.view(verificationView[1],runId));return;
      }
      if(req.method==='GET'&&url.pathname==='/api/providers'){json(res,200,{externalApiEnabled:false,connections:providerConnections});return;}
      const mergeView=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/merge$/);
      const workflowView=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/workflows$/);
      if(req.method==='GET'&&workflowView){
        const keys=[...url.searchParams.keys()],workspaceId=url.searchParams.get('workspaceId');
        if(keys.length>1||keys.length===1&&(keys[0]!=='workspaceId'||!workspaceId||!/^[a-f0-9-]{36}$/.test(workspaceId)))throw new AppError('INVALID_FIELDS',400);
        json(res,200,controller.workflows.view(workflowView[1],workspaceId));return;
      }
      const workflowPreview=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/workflows\/preview$/);
      if(req.method==='GET'&&workflowPreview){
        const workflowId=url.searchParams.get('workflowId');if([...url.searchParams.keys()].join(',')!=='workflowId'||!workflowId||!/^[a-f0-9-]{36}$/.test(workflowId))throw new AppError('INVALID_FIELDS',400);
        json(res,200,controller.workflows.preview(workflowPreview[1],workflowId));return;
      }
      if(req.method==='GET'&&mergeView){
        const keys=[...url.searchParams.keys()],runId=url.searchParams.get('runId');
        if(keys.length>1||(keys.length===1&&(keys[0]!=='runId'||!runId||!/^[a-f0-9-]{36}$/.test(runId))))throw new AppError('INVALID_FIELDS',400);
        json(res,200,controller.merges.view(mergeView[1],runId));return;
      }
      const sourceArtifact=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/artifacts\/([a-f0-9-]{36})\/source-status$/);
      if(req.method==='GET'&&sourceArtifact){
        const revision=url.searchParams.get('revision')??'',hash=url.searchParams.get('hash')??'';
        if([...url.searchParams.keys()].sort().join(',')!=='hash,revision'||!/^\d+$/.test(revision)||!Number.isSafeInteger(Number(revision))||Number(revision)<1||!/^[a-f0-9]{64}$/.test(hash))throw new AppError('INVALID_FIELDS',400);
        json(res,200,controller.sourceGraphs.artifactStatus(sourceArtifact[1],sourceArtifact[2],Number(revision),hash));return;
      }
      const exportPlanning=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/plans\/([a-f0-9-]{36})\/export$/);
      if(req.method==='GET'&&exportPlanning){
        const fields=[...url.searchParams.keys()].sort().join(',');
        const revision=url.searchParams.get('revision')??'',hash=url.searchParams.get('hash')??'',format=url.searchParams.get('format');
        if(fields!=='format,hash,revision'||!/^\d+$/.test(revision)||!Number.isSafeInteger(Number(revision))||Number(revision)<1||!/^[a-f0-9]{64}$/.test(hash)||(format!=='json'&&format!=='markdown'))throw new AppError('INVALID_FIELDS',400);
        const exported=studio.exportPlanning(exportPlanning[1],exportPlanning[2],Number(revision),hash,format);
        res.writeHead(200,{'Content-Type':exported.mime,'Content-Disposition':`attachment; filename="${exported.filename}"`,'Content-Length':exported.bytes.length});res.end(exported.bytes);return;
      }
      const exportArtifact=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/artifacts\/([a-f0-9-]{36})\/export$/);
      if(req.method==='GET'&&exportArtifact){
        const fields=[...url.searchParams.keys()].sort().join(',');
        const revision=url.searchParams.get('revision')??'',hash=url.searchParams.get('hash')??'',format=url.searchParams.get('format');
        if(fields!=='format,hash,revision'||!/^\d+$/.test(revision)||!Number.isSafeInteger(Number(revision))||Number(revision)<1||!/^[a-f0-9]{64}$/.test(hash)||(format!=='pptx'&&format!=='markdown'))throw new AppError('INVALID_FIELDS',400);
        const exported=studio.exportArtifact(exportArtifact[1],exportArtifact[2],Number(revision),hash,format);
        res.writeHead(200,{'Content-Type':exported.mime,'Content-Disposition':`attachment; filename="${exported.filename}"`,'Content-Length':exported.bytes.length});res.end(exported.bytes);return;
      }
      if(req.method==='GET'&&studioRoute?.[2]==='plans'&&studioRoute[4]==='diff'){
        const baseId=url.searchParams.get('baseVersionId')??'';
        if([...url.searchParams.keys()].join(',')!=='baseVersionId'||!/^[a-f0-9-]{36}$/.test(baseId))throw new AppError('INVALID_FIELDS',400);
        json(res,200,studio.comparePlanning(studioRoute[1],studioRoute[3],baseId));return;
      }
      if(req.method==='GET'&&studioRoute&&(!studioRoute[3]||(studioRoute[2]==='artifacts'&&studioRoute[4]==='history'))){
        json(res,200,studio.read(studioRoute[1],studioRoute[2],studioRoute[3]));return;
      }
      if(req.method==='GET'&&reuseVendorRoute){if(url.search)throw new AppError('INVALID_FIELDS',400);const workspace=reuseWorkspace(reuseVendorRoute[1]);json(res,200,{evidence:readReuseEvidence(workspace.path),decisions:approvedReuse(workspace.projectId)});return;}
      if(req.method==='GET'&&appPreviewRoute){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,appPreview.catalog(appPreviewRoute[1]));return;}
      const resultRoute=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/result$/);
      if(req.method==='GET'&&resultRoute){const keys=[...url.searchParams.keys()],runId=url.searchParams.get('runId');if(keys.some(key=>key!=='runId')||keys.length>1||(keys.length===1&&(!runId||!(/^[a-f0-9-]{36}$/).test(runId))))throw new AppError('INVALID_FIELDS',400);json(res,200,controller.developmentResult(resultRoute[1],runId));return;}
      if(req.method==='GET'&&url.pathname==='/api/state'){json(res,200,controller.snapshot());return;}
      const diff=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/diff$/);
      if(req.method==='GET'&&diff){json(res,200,controller.workspaceDiff(diff[1]));return;}
      if(req.method==='GET'&&url.pathname==='/api/events'){
        const value=req.headers['last-event-id']??url.searchParams.get('after')??'0';const after=Number(value);
        if(!Number.isSafeInteger(after)||after<0||after>controller.store.lastSeq())throw new AppError('INVALID_CURSOR',400);
        res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});
        let cursor=after,waiting=false,closed=false,scheduled:NodeJS.Immediate|undefined;
        const pump=()=>{
          if(waiting||closed||res.destroyed||res.writableEnded)return;
          const page=controller.store.eventsAfter(cursor,100);
          for(const e of page){cursor=e.seq;if(!res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)){waiting=true;return;}}
          if(page.length===100&&!scheduled)scheduled=setImmediate(()=>{scheduled=undefined;pump();});
        };
        const drain=()=>{waiting=false;pump();};
        controller.store.on('event',pump);res.on('drain',drain);
        pump();if(!waiting)res.write(': connected\n\n');
        const heartbeat=setInterval(()=>{if(!waiting&&!closed&&!res.writableEnded&&!res.destroyed)waiting=!res.write(': heartbeat\n\n');},15000);
        const expired=setTimeout(()=>res.end(),Math.max(1,session.expires-Date.now()));
        const cleanup=()=>{closed=true;clearInterval(heartbeat);clearTimeout(expired);if(scheduled)clearImmediate(scheduled);controller.store.off('event',pump);res.off('drain',drain);};
        res.on('close',cleanup);res.on('error',cleanup);return;
      }
      throw new AppError('NOT_FOUND',404);
    }
    const files:Record<string,[string,string]>={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/app.css':['app.css','text/css']};
    const file=files[url.pathname];if(req.method!=='GET'||!file)throw new AppError('NOT_FOUND',404);
    try{const bytes=await readFile(resolve(assets,file[0]));res.writeHead(200,{'Content-Type':file[1]+'; charset=utf-8'});res.end(url.pathname==='/'?bytes.toString('utf8').replace(/<\/head\s*>/i,`<meta name="orbit-preview-origin" content="${appPreview.origin}"></head>`):bytes);}
    catch{throw new AppError('BUILD_REQUIRED',503);}
  }
  return server;
}
