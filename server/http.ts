import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Controller } from './controller.ts';
import { AppError } from './controller.ts';
import { Studio,exact,studioError } from './studio.ts';
import { providerConnections,sendMock } from './providers/policy.ts';
import { buildCapabilityRegistry } from './capabilities.ts';
import { createNativeProbeService } from './capability-probe.ts';
import { PlanningHandoffService } from './planning-handoff-service.ts';
import {controlPlaneStatus} from './control-plane.ts';
import {GoalService} from './goal-service.ts';
import {AppPreviewHost} from './app-preview.ts';

function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
async function body(req:IncomingMessage,limit=18000):Promise<Record<string,unknown>>{
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new AppError('JSON_REQUIRED',415);
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw new AppError('BODY_TOO_LARGE',413);chunks.push(chunk);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw new AppError('INVALID_JSON',400);}
}
export function createHttpServer(controller:Controller,assets:string,options:{nativeProbe?:ReturnType<typeof createNativeProbeService>}={}){
  const studio=new Studio(controller.store);
  const goals=new GoalService(controller.store);
  const planningHandoff=new PlanningHandoffService(controller.store,(workspaceId,runId)=>controller.verification.view(workspaceId,runId),id=>controller.workspaceDiff(id));
  const nativeProbe=options.nativeProbe??createNativeProbeService();
  const sessions=new Map<string,{csrf:string;expires:number}>();
  const appPreview=new AppPreviewHost(id=>controller.appPreviewSnapshot(id));
  let previewReady:Promise<void>=Promise.resolve();
  const server=createServer((req,res)=>{void handle(req,res).catch(e=>{
    if(res.headersSent){res.end();return;}
    const error=e instanceof AppError?e:studioError(e);
    json(res,error?error.status:500,{error:error?error.message:'INTERNAL_ERROR'});
  });});
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.once('listening',()=>{const address=server.address();if(address&&typeof address!=='string')previewReady=appPreview.listen('http://127.0.0.1:'+address.port).catch(()=>{});});
  const previewWorkspace=(event:{kind:string})=>{if(event.kind==='workspace.selected')appPreview.clear();};
  controller.store.on('event',previewWorkspace);
  server.once('close',()=>{controller.store.off('event',previewWorkspace);void appPreview.close();});
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
      const soloOperation=url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})\/operation$/);
      if(req.method==='GET'&&soloOperation){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        if(!controller.store.getRun(soloOperation[1]))throw new AppError('RUN_NOT_FOUND',404);
        json(res,200,controller.store.soloOperation(soloOperation[1]));return;
      }
      const studioRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(plans|artifacts|tasks)(?:\/([a-f0-9-]{36})\/(revisions|approve|task-drafts|history|diff|replan))?$/);
      const goalRoute=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/goals(?:\/([a-f0-9-]{36})\/(state|history))?$/);
      const appPreviewRoute=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/app-preview$/);
      const verificationSetupRoute=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/verification-setup$/);
      if(req.method==='POST'){
        const token=req.headers['x-csrf-token'];
        if(req.headers.origin!==origin||typeof token!=='string'||token.length!==64||!timingSafeEqual(Buffer.from(token),Buffer.from(session.csrf)))throw new AppError('CSRF_REJECTED',403);
        const largeStudioInput=studioRoute&&studioRoute[2]!=='tasks'&&(!studioRoute[3]||studioRoute[4]==='revisions');
        const planningSuggestion=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/planning-suggestions\/(preview|start|recover|([a-f0-9-]{36})\/(interrupt|save))$/);
        const data=await body(req,largeStudioInput?6*256*1024+256*1024:planningSuggestion?64000:18000);
        if(verificationSetupRoute){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['requestId','profileId','expectedPreviewDigest','confirmed']);
          json(res,200,controller.configureVerification(verificationSetupRoute[1],data as unknown as Parameters<Controller['configureVerification']>[1]));return;
        }
        if(appPreviewRoute){
          if(url.search)throw new AppError('INVALID_FIELDS',400);exact(data,['entryPath','expectedSourceDigest']);controller.assertAppPreviewAvailable();
          json(res,200,appPreview.create(appPreviewRoute[1],data as unknown as Parameters<AppPreviewHost['create']>[1]));return;
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
            exact(data,['workspaceId']);json(res,200,controller.interruptPlanning(projectId,id,data.workspaceId as string));return;
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
        const taskRun=url.pathname.match(/^\/api\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/tasks\/([a-f0-9-]{36})\/run$/);
        if(taskRun){
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
        if(url.pathname==='/api/projects/create'){
          exact(data,['requestId','name']);
          if(url.search||typeof data.requestId!=='string'||typeof data.name!=='string')throw new AppError('INVALID_FIELDS',400);
          json(res,200,controller.createProject({requestId:data.requestId,name:data.name}));return;
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
      if(req.method==='GET'&&goalRoute){
        if(url.search)throw new AppError('INVALID_FIELDS',400);
        if(!goalRoute[2]){json(res,200,goals.list(goalRoute[1]));return;}
        if(goalRoute[3]==='history'){json(res,200,goals.history(goalRoute[1],goalRoute[2]));return;}
        throw new AppError('NOT_FOUND',404);
      }
      if(req.method==='GET'&&url.pathname==='/api/control-plane'){if(url.search)throw new AppError('INVALID_FIELDS',400);json(res,200,controlPlaneStatus(controller.snapshot().provider));return;}
      if(req.method==='GET'&&url.pathname==='/api/capabilities'){json(res,200,buildCapabilityRegistry(controller.snapshot().provider,nativeProbe.get()));return;}
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
        if([...url.searchParams.keys()].join(',')!=='workspaceId'||!workspaceId||!/^[a-f0-9-]{36}$/.test(workspaceId))throw new AppError('INVALID_FIELDS',400);
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
        json(res,200,reviewView[2]?controller.reviews.preview(reviewView[1],runId):controller.reviews.view(reviewView[1],runId));return;
      }
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
