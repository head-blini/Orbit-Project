// Manual live proof only (LIVE-CLI, docs/ORBIT-UNIFIED-BACKLOG-2026-10-29.md). Never imported by tests; each invocation needs explicit approval.
// One real Claude Code subscription call through Orbit's execute.general capability adapter, in a disposable general project.
import {mkdtempSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';
import {readCapabilityExecution} from '../server/capability-execution.ts';
if(process.argv[2]!=='--approved-live')throw Error('EXPLICIT_LIVE_APPROVAL_REQUIRED');
const dir=mkdtempSync('/private/tmp/orbit-live-claude-'),db=join(dir,'orbit.sqlite');
const evidence:any={kind:'live_provider_validation',startedAt:new Date().toISOString(),directory:dir,provider:'claude-code',capability:'execute.general',costUsd:null,remainingQuota:null,stage:'setup',success:false};
const save=()=>writeFileSync(join(dir,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');save();console.log(JSON.stringify({evidenceDirectory:dir}));
const store=new Store(db),projects=new Projects(store,join(dir,'managed'),[],join(dir,'projects'));
// Codex is never launched by this proof.
const controller=new Controller(store,createWorkspace(dir),()=>{throw Error('CODEX_FORBIDDEN');},projects);
const server=createHttpServer(controller,resolve('dist'));
let runId:string|undefined,executionId:string|undefined,projectId:string|undefined;
const started=performance.now();
try{
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await session.json() as any;
 const headers={cookie,origin,'content-type':'application/json','x-csrf-token':csrfToken};
 const request=async(path:string,data?:object)=>{const response=await fetch(origin+path,{headers,method:data?'POST':'GET',...(data?{body:JSON.stringify(data)}:{})});const body:any=await response.json();if(!response.ok)throw Error('HTTP_'+response.status+'_'+String(body.error??body.code??'FAILED'));return body;};
 const {project}=projects.createProject({requestId:randomUUID(),name:'Orbit live Claude proof',kind:'general'});projectId=project.id;
 const base='/api/projects/'+project.id;
 evidence.stage='readiness';save();evidence.readiness=await request('/api/capability-orchestration/readiness/refresh',{});save();
 const plan=await request(base+'/plans',{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Orbit live Claude proof',goal:'Create one harmless local text file',requirements:[{id:'R1',description:'Create result.txt in the current project directory containing exactly ORBIT_CLAUDE_GENERAL_SMOKE followed by a newline. Do not create or modify any other file.',acceptance_criteria:['result.txt contains exactly ORBIT_CLAUDE_GENERAL_SMOKE followed by a newline.']}],constraints:['Only the current project directory. No shell, network, installation, credentials, MCP, skill, hook or subagent calls.'],open_questions:[]})}});
 await request(base+'/plans/'+plan.id+'/approve',{expectedRevision:1});const [task]=await request(base+'/plans/'+plan.id+'/task-drafts',{});
 evidence.stage='route';save();
 const route=await request(base+'/capability-routes',{requestId:randomUUID(),taskId:task.id,text:'문서 작성 실행'});
 evidence.route={status:route.status,capabilityId:route.capabilityId??route.recommendation?.capabilityId??null,runtimeId:route.runtimeId??route.recommendation?.runtimeId??null};save();
 assert.equal(route.status,'recommended');
 const execution=await request(base+'/capability-executions',{requestId:randomUUID(),routeId:route.id});executionId=execution.id;
 assert.equal(execution.runtimeId,'claude-code');
 const path=base+'/capability-executions/'+execution.id,approval={confirmed:true,expectedPlanDigest:execution.planDigest};
 evidence.ids={projectId:project.id,taskId:task.id,routeId:route.id,executionId,planDigest:execution.planDigest};evidence.stage='dispatch';save();
 const first=await request(path+'/start',approval);runId=first.runId;evidence.ids.runId=runId;save();
 const duplicate=await request(path+'/start',approval);assert.equal(duplicate.runId,runId);assert.equal(store.runs().length,1);evidence.duplicateBlocked=true;
 let record=await request(path);const deadline=Date.now()+180000;
 while(['running','dispatching','interrupt_requested'].includes(record.status)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,500));record=await request(path);}
 if(['running','dispatching','interrupt_requested'].includes(record.status)){await request(path+'/interrupt',{});throw Error('VALIDATION_DEADLINE');}
 evidence.execution=record;evidence.run=store.getRun(runId!);evidence.stage='result';save();
 const output=join(project.path,'result.txt');evidence.file={exists:existsSync(output)};
 if(existsSync(output)){const text=readFileSync(output,'utf8');evidence.file={exists:true,exact:text==='ORBIT_CLAUDE_GENERAL_SMOKE\n',sha256:createHash('sha256').update(text).digest('hex')};}
 evidence.projectFiles=readdirSync(project.path,{recursive:true}).map(String).sort();
 assert.equal(record.status,'execution_completed');assert.equal(evidence.file.exact,true);assert.equal(record.providerEvidence.source,'native');
 // No reviewer call is authorized: preview only (no dispatch). The observed producer model is recorded as-is, null when unobserved.
 const preview=await request(path+'/quality-preview',{reviewers:[{id:'independence-gate',providerId:'openai',modelId:'unverified-review-model'}],limits:{maxCalls:1,maxRepairs:0,timeoutMs:1000}}).catch(error=>({error:error.message}));
 evidence.qualityPreview=preview.error?{error:preview.error}:{producer:preview.producer,previewDigest:preview.previewDigest};
 const progress=await request(base+'/progress'),visible=progress.tasks.find((t:any)=>t.id===task.id);assert.deepEqual(visible.capabilityExecutions[0].providerEvidence,record.providerEvidence);
 const sequence=store.lastSeq();await request(path);await request(base+'/progress');assert.equal(store.lastSeq(),sequence);
 assert.equal((await request(path+'/start',approval)).runId,runId);assert.equal(store.runs().length,1);
 evidence.execution=record;evidence.progressTask={stage:visible.stage,quality:visible.quality??null};evidence.httpGetReadOnly=true;evidence.pipelineChecksPassed=true;evidence.stage='pipeline_checked';
}catch(error){evidence.error=error instanceof Error?error.message:'VALIDATION_FAILED';process.exitCode=1;}
finally{
 evidence.durationMs=Math.round(performance.now()-started);evidence.finishedAt=new Date().toISOString();
 evidence.runCount=store.runs().length;if(runId)evidence.run=store.getRun(runId);
 evidence.events=store.eventsAfter(0).map(({seq,at,kind,runId})=>({seq,at,kind,runId}));save();
 try{
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await controller.close();store.close();
  const reopened=new Store(db);try{if(executionId&&projectId){const replay=readCapabilityExecution(reopened,projectId,executionId);evidence.restart={scope:'Store reopen only',runCount:reopened.runs().length,status:replay.status,providerEvidence:replay.providerEvidence};assert.equal(reopened.runs().length,1);}}finally{reopened.close();}
  evidence.success=evidence.pipelineChecksPassed===true;evidence.stage=evidence.success?'verified':evidence.stage;
 }catch(error){evidence.success=false;evidence.postprocessingError=error instanceof Error?error.message:'POSTPROCESSING_FAILED';process.exitCode=1;}
 save();console.log(JSON.stringify({directory:dir,success:evidence.success,stage:evidence.stage,error:evidence.error,runCount:evidence.runCount,durationMs:evidence.durationMs}));
}
