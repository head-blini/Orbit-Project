// Manual live proof only. Never imported by tests; each invocation needs explicit approval.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {codexFactory} from '../server/codex.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';
import {readCapabilityExecution} from '../server/capability-execution.ts';
if(process.argv[2]!=='--approved-live')throw Error('EXPLICIT_LIVE_APPROVAL_REQUIRED');
const dir=mkdtempSync('/private/tmp/orbit-phase4-'),root=join(dir,'source'),db=join(dir,'orbit.sqlite');mkdirSync(root);
const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
git('init','-q','-b','main');writeFileSync(join(root,'README.md'),'Disposable Orbit Phase 4 provider validation.\n');git('add','README.md');git('-c','user.name=Orbit Validation','-c','user.email=orbit@example.invalid','commit','-qm','isolated validation baseline');
const evidence:any={kind:'live_provider_validation',startedAt:new Date().toISOString(),directory:dir,provider:'codex',actualModel:'unknown',costUsd:null,remainingQuota:null,stage:'setup',success:false};
const save=()=>writeFileSync(join(dir,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');save();console.log(JSON.stringify({evidenceDirectory:dir}));
const store=new Store(db),projects=new Projects(store,join(dir,'managed'),[root]);
const project=projects.register(root),workspace=projects.create(project.id);
const controller=new Controller(store,createWorkspace(dir),(path,write)=>codexFactory(path,write)(),projects);
const server=createHttpServer(controller,resolve('dist'));
let runId:string|undefined,executionId:string|undefined;
const started=performance.now();
try{
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as any;
 const headers={cookie,origin,'content-type':'application/json','x-csrf-token':csrfToken};
 const request=async(path:string,data?:object)=>{const response=await fetch(origin+path,{headers,method:data?'POST':'GET',...(data?{body:JSON.stringify(data)}:{})});const body:any=await response.json();if(!response.ok)throw Error('HTTP_'+response.status+'_'+String(body.error??body.code??'FAILED'));return body;};
 const base='/api/projects/'+project.id;
 await request('/api/workspaces/select',{workspaceId:workspace.id});
 evidence.stage='readiness';save();evidence.readiness=await request('/api/capability-orchestration/readiness/refresh',{});save();
 await request('/api/connect',{});evidence.readiness=await request('/api/capability-orchestration/readiness');assert.equal(evidence.readiness.codex.connection,'ready');
 const plan=await request(base+'/plans',{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Orbit native smoke',goal:'Create one harmless local file',requirements:[{id:'R1',description:'Create result.txt in the current worktree containing exactly ORBIT_NATIVE_SMOKE followed by a newline. Use apply_patch only. Do not modify any other file.',acceptance_criteria:['result.txt contains exactly ORBIT_NATIVE_SMOKE followed by a newline.']}],constraints:['Only current worktree. No shell, network, installation, credentials, MCP, skill or hook calls. Do not commit.'],open_questions:[]})}});
 await request(base+'/plans/'+plan.id+'/approve',{expectedRevision:1});const [task]=await request(base+'/plans/'+plan.id+'/task-drafts',{});
 const route=await request(base+'/capability-routes',{requestId:randomUUID(),taskId:task.id,text:'코드 구현'});assert.equal(route.status,'recommended');
 const execution=await request(base+'/capability-executions',{requestId:randomUUID(),routeId:route.id});executionId=execution.id;
 const path=base+'/capability-executions/'+execution.id,approval={confirmed:true,expectedPlanDigest:execution.planDigest};
 evidence.ids={projectId:project.id,workspaceId:workspace.id,taskId:task.id,routeId:route.id,executionId};evidence.workspace=workspace.path;evidence.stage='dispatch';save();
 const first=await request(path+'/start',approval);runId=first.runId;evidence.ids.runId=runId;save();
 const duplicate=await request(path+'/start',approval);assert.equal(duplicate.runId,runId);assert.equal(store.runs().length,1);evidence.duplicateBlocked=true;
 let record=await request(path);const deadline=Date.now()+145000;
 while(['running','dispatching','interrupt_requested'].includes(record.status)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,500));record=await request(path);}
 if(['running','dispatching','interrupt_requested'].includes(record.status)){await request(path+'/interrupt',{});throw Error('VALIDATION_DEADLINE');}
 evidence.execution=record; evidence.run=store.getRun(runId!); evidence.stage='result';save();
 const output=join(workspace.path,'result.txt');evidence.file={exists:existsSync(output)};
 if(existsSync(output)){const text=readFileSync(output,'utf8');evidence.file={exists:true,exact:text==='ORBIT_NATIVE_SMOKE\n',sha256:createHash('sha256').update(text).digest('hex')};}
 assert.equal(record.status,'execution_completed');assert.equal(evidence.file.exact,true);assert.equal(record.providerEvidence.source,'native');assert.equal(record.models.actualModelId,'unknown');
 // Unknown producer must block before any reviewer invocation. No reviewer model call is authorized.
 const qualityInput={reviewers:[{id:'independence-gate',providerId:'openai',modelId:'unverified-review-model'}],limits:{maxCalls:1,maxRepairs:0,timeoutMs:1000}};
 const preview=await request(path+'/quality-preview',qualityInput);assert.equal(preview.producer.source,'unknown');
 const quality=await request(path+'/quality-start',{...qualityInput,requestId:randomUUID(),confirmed:true,expectedPreviewDigest:preview.previewDigest});await controller.qualityLoops.settled(quality.qualityLoopId);
 record=await request(path);assert.equal(record.status,'quality_blocked');assert.equal(record.quality.result.issue,'QUALITY_PRODUCER_MODEL_UNKNOWN');assert.equal(record.quality.steps.length,0);
 const progress=await request(base+'/progress'),visible=progress.tasks.find((t:any)=>t.id===task.id);assert.deepEqual(visible.capabilityExecutions[0].providerEvidence,record.providerEvidence);
 const sequence=store.lastSeq();await request(path);await request(base+'/progress');assert.equal(store.lastSeq(),sequence);
 assert.equal((await request(path+'/start',approval)).runId,runId);assert.equal(store.runs().length,1);
 assert.equal(git('status','--porcelain'),'');
 const worktreeStatus=execFileSync('git',['status','--porcelain'],{cwd:workspace.path,encoding:'utf8'}).trim();assert.equal(worktreeStatus,'?? result.txt');
 assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:workspace.path,encoding:'utf8'}).trim(),git('rev-parse','HEAD'));evidence.worktreeOnlyResultFile=true;
 evidence.execution=record;evidence.progressTask=visible;evidence.sourceUnchanged=true;evidence.httpGetReadOnly=true;evidence.pipelineChecksPassed=true;evidence.stage='pipeline_checked';
}catch(error){evidence.error=error instanceof Error?error.message:'VALIDATION_FAILED';process.exitCode=1;}
finally{
 evidence.durationMs=Math.round(performance.now()-started);evidence.finishedAt=new Date().toISOString();
 evidence.events=store.eventsAfter(0).map(({seq,at,kind,runId})=>({seq,at,kind,runId}));
 evidence.runCount=store.runs().length;
 if(runId)evidence.run=store.getRun(runId);
 save();
 try{
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await controller.close();
  evidence.events=store.eventsAfter(0).map(({seq,at,kind,runId})=>({seq,at,kind,runId}));store.close();
  const reopened=new Store(db);try{if(executionId){const replay=readCapabilityExecution(reopened,project.id,executionId);evidence.restart={scope:'Store reopen only; full HTTP restart requires separate offline proof',runCount:reopened.runs().length,status:replay.status,providerEvidence:replay.providerEvidence};assert.equal(reopened.runs().length,1);assert.deepEqual(replay.providerEvidence,evidence.execution.providerEvidence);}}finally{reopened.close();}
  evidence.success=evidence.pipelineChecksPassed===true;evidence.stage=evidence.success?'verified':evidence.stage;
 }catch(error){evidence.success=false;evidence.postprocessingError=error instanceof Error?error.message:'POSTPROCESSING_FAILED';process.exitCode=1;}
 save();console.log(JSON.stringify({directory:dir,success:evidence.success,stage:evidence.stage,error:evidence.error,runCount:evidence.runCount,durationMs:evidence.durationMs}));
}
