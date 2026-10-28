import {createHash,randomUUID} from 'node:crypto';
import type {OrchestrationRegistry,OrchestrationCapabilityId,RuntimeId} from '../shared/capability-orchestration.ts';
import type {CapabilityRouteInput,CapabilityRouteDecision} from '../shared/capability-routing.ts';
import type {Store} from './store.ts';
import {Studio,exact} from './studio.ts';
import {ProjectAiPreferencesService} from './project-ai-preferences.ts';
import {containsCredential} from './privacy.ts';
import {outboundDenial} from './providers/policy.ts';
import {AppError} from './errors.ts';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

/** Deliberately limited local intent classifier; uncertain language never dispatches. */
function classify(text:string){
 const normalized=text.toLowerCase().replace(/claude\s+code/g,'claude');
 const extension=/\b(?:mcp|skills?|hooks?|slash|plugins?|subagents?|agents?)\b|스킬|훅|슬래시|플러그인|서브\s*에이전트|하위\s*에이전트|(?:^|\s)\/[a-z][\w-]*/i.test(normalized);
 const unsupported=/이미지\s*생성|그림\s*생성|영상\s*생성|음성\s*생성|\b(?:generate|create)\s+(?:an?\s+)?(?:image|video|audio)\b|웹\s*검색|인터넷\s*검색|\bweb\s+search\b|\b(?:api|bedrock|ollama|vllm)\b/i.test(normalized);
 const review=/검증|검토|리뷰|\breview\b|\bverify\b/i.test(normalized);
 const planning=/기획|계획|\bplan(?:ning)?\b/i.test(normalized);
 const execution=/작성|구현|개발|수정|정리|요약|분석|실행|수행|진행|\b(?:run|execute|implement|write|summari[sz]e|fix|analy[sz]e)\b/i.test(normalized);
 const negative=/하지\s*마|하지\s*않|말고|금지|\b(?:not|never|without)\b|don['’]t/i.test(normalized);
 const statusQuery=/상태\s*(?:확인|조회)|(?:check|query|show)\s+(?:run\s+)?status/i.test(normalized);
 const resultQuery=/결과\s*(?:확인|조회|수집)|(?:collect|show|get)\s+(?:run\s+)?results?/i.test(normalized);
 const interruptQuery=/중단|\b(?:interrupt|stop)\b/i.test(normalized);
 const lifecycleCount=Number(statusQuery)+Number(resultQuery)+Number(interruptQuery);
 const lifecycle=lifecycleCount===1&&!/작성|구현|개발|수정|기획|계획|검증|리뷰|\b(?:write|implement|fix|plan|review|verify)\b/i.test(normalized)?statusQuery?'status':resultQuery?'result':'interrupt':null;
 const intent:CapabilityRouteDecision['intent']=negative||lifecycleCount>0&&!lifecycle?'unknown':lifecycle?lifecycle:Number(review)+Number(planning)+Number(execution)!==1?'unknown':review?'review':planning?'planning':'execution';
 const wantsCode=/코드|코딩|버그|\b(?:code|coding|debug)\b/i.test(normalized);
 const wantsGeneral=/보고서|문서|자료|\b(?:report|document)\b/i.test(normalized);
 const codex=/\bcodex\b|코덱스/i.test(normalized),claude=/\bclaude\b|클로드/i.test(normalized);
 return {intent,extension,unsupported,wantsCode,wantsGeneral,mentioned:codex&&claude?'ambiguous':codex?'codex':claude?'claude-code':null};
}

/** Recommendations only. This service has no execution, credential, network or CLI port. */
export class CapabilityRoutingService {
 private store:Store;private studio:Studio;private preferences:ProjectAiPreferencesService;
 constructor(store:Store){
  this.store=store;this.studio=new Studio(store);this.preferences=new ProjectAiPreferencesService(store);
  store.db.exec('CREATE TABLE IF NOT EXISTS capability_discoveries(digest TEXT PRIMARY KEY,body TEXT NOT NULL)');
  store.db.exec('CREATE TABLE IF NOT EXISTS capability_routes(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,body TEXT NOT NULL)');
 }
 private project(projectId:string){const project=this.store.projects().find(p=>p.id===projectId);if(!project)throw new AppError('PROJECT_NOT_FOUND',404);return project;}
 records(projectId:string):CapabilityRouteDecision[]{this.project(projectId);return this.store.db.prepare('SELECT body FROM capability_routes WHERE project_id=? ORDER BY rowid DESC LIMIT 200').all(projectId).map(row=>JSON.parse(String(row.body)));}
 recordDiscovery(registry:OrchestrationRegistry):string {
  const key=digest(registry);
  this.store.db.prepare('INSERT OR IGNORE INTO capability_discoveries VALUES(?,?)').run(key,JSON.stringify(registry));return key;
 }
 discovery(key:string):OrchestrationRegistry {
  if(!/^[a-f0-9]{64}$/.test(key))throw new AppError('INVALID_FIELDS',400);
  const row=this.store.db.prepare('SELECT body FROM capability_discoveries WHERE digest=?').get(key);
  if(!row)throw new AppError('CAPABILITY_EVIDENCE_NOT_FOUND',404);return JSON.parse(String(row.body));
 }
 recommend(projectId:string,input:CapabilityRouteInput,registry:OrchestrationRegistry):CapabilityRouteDecision {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('INVALID_FIELDS',400);
  exact(input as unknown as Record<string,unknown>,['requestId','taskId','text',...(Object.hasOwn(input,'runtimeId')?['runtimeId']:[]),...(Object.hasOwn(input,'runId')?['runId']:[])]);
  if(!id(input.requestId)||!id(input.taskId)||typeof input.text!=='string'||!input.text.trim()||input.text.length>4000||input.runtimeId!==undefined&&!['codex','claude-code'].includes(input.runtimeId))throw new AppError('INVALID_FIELDS',400);
  if(input.runId!==undefined&&(typeof input.runId!=='string'||!/^[a-f0-9-]{36}$/.test(input.runId)))throw new AppError('INVALID_FIELDS',400);
  if(containsCredential(input.text)||outboundDenial(input.text))throw new AppError('SENSITIVE_ROUTING_INPUT',400);
  const project=this.project(projectId),inputDigest=digest({projectId,requestId:input.requestId,taskId:input.taskId,text:input.text,runtimeId:input.runtimeId??null,runId:input.runId??null});
  const previous=this.store.db.prepare('SELECT input_digest,body FROM capability_routes WHERE request_id=?').get(input.requestId);
  if(previous){if(previous.input_digest!==inputDigest)throw new AppError('IDEMPOTENCY_CONFLICT',409);return JSON.parse(String(previous.body));}
  const intent=classify(input.text),prefs=this.preferences.read(projectId);
  if(['status','result','interrupt'].includes(intent.intent)){
   const run=input.runId?this.store.getRun(input.runId):null;
   if(input.runId&&(!run||run.taskId!==input.taskId||(run.projectId??this.store.workspaces().find(w=>w.id===run.workspaceId)?.projectId)!==projectId))throw new AppError('TARGET_RUN_NOT_FOUND',404);
   const runtimeId:RuntimeId=run?.runtime==='claude-code'?'claude-code':'codex',capabilityId=intent.intent as 'status'|'result'|'interrupt';
   const baseline=run?{planningVersionId:run.planningVersionId!,planningContentHash:run.planningContentHash!}:this.studio.execution(projectId,input.taskId);
   const reasons:string[]=[],capability=registry.providers.find(p=>p.runtimeId===runtimeId)?.capabilities.find(c=>c.id===capabilityId);
   let status:CapabilityRouteDecision['status']=run?'recommended':'needs_clarification';
   if(!run)reasons.push('TARGET_RUN_REQUIRED');
   if(run&&(!run.planningVersionId||!run.planningContentHash)){status='blocked';reasons.push('RUN_BASELINE_UNKNOWN');}
   if(intent.extension||intent.unsupported){status='blocked';reasons.push('EXTENSION_NOT_AUTHORIZED');}
   if(intent.mentioned==='ambiguous'||input.runtimeId&&input.runtimeId!==runtimeId||intent.mentioned&&intent.mentioned!=='ambiguous'&&intent.mentioned!==runtimeId){status='blocked';reasons.push('TARGET_RUNTIME_MISMATCH');}
   if(run&&(!capability||capability.invocation!=='implemented'||capability.policy!=='allowed')){status='blocked';reasons.push('CAPABILITY_BLOCKED_POLICY');}
   if(status==='recommended')reasons.push('EXISTING_RUN_RUNTIME_PRESERVED','EXACT_TARGET_RUN','NO_MODEL_DISPATCH',capabilityId==='interrupt'?'EXPLICIT_INTERRUPT_APPROVAL_REQUIRED':'STORED_EXECUTION_EVIDENCE');
   const binding={projectId,taskId:input.taskId,runId:run?.id,runtimeId:run?runtimeId:null,capabilityId,baseline:{planningVersionId:baseline.planningVersionId,planningContentHash:baseline.planningContentHash}};
   const result:CapabilityRouteDecision={...binding,id:randomUUID(),requestId:input.requestId,createdAt:new Date().toISOString(),intent:intent.intent,status,reasons,preferencesRevision:prefs.revision,registryDigest:digest(registry),textDigest:digest(input.text),executionAuthorized:false,actualModel:'unknown',...(run?{invocationDigest:digest(binding)}:{})};
   this.store.transaction(()=>{this.recordDiscovery(registry);this.store.db.prepare('INSERT INTO capability_routes VALUES(?,?,?,?,?)').run(result.id,projectId,input.requestId,inputDigest,JSON.stringify(result));this.store.append('capability.route',null,{projectId,taskId:input.taskId,routeId:result.id,status:result.status,runtimeId:result.runtimeId});});return result;
  }
  if(input.runId)throw new AppError('TARGET_RUN_NOT_APPLICABLE',400);
  const brief=this.studio.execution(projectId,input.taskId);
  const reasons:string[]=[],stage=intent.intent==='planning'?'planning':'execution';
  const runtimeId:RuntimeId=prefs[stage];
  let capabilityId:OrchestrationCapabilityId|null=intent.intent==='unknown'?null:intent.intent==='review'?'review.text':intent.intent==='planning'?'plan':project.kind==='general'?'execute.general':'execute.code';
  let status:CapabilityRouteDecision['status']='recommended';
  const block=(reason:string)=>{status='blocked';reasons.push(reason);};
  if(intent.intent==='unknown'||intent.mentioned==='ambiguous'){status='needs_clarification';reasons.push('INTENT_UNCLEAR');capabilityId=null;}
  if(intent.extension)block('EXTENSION_NOT_AUTHORIZED');
  if(intent.unsupported)block('CAPABILITY_NOT_IMPLEMENTED');
  if(input.runtimeId&&input.runtimeId!==runtimeId||intent.mentioned&&intent.mentioned!=='ambiguous'&&intent.mentioned!==runtimeId)block('RUNTIME_SELECTION_REQUIRED');
  if(intent.intent==='execution'&&(project.kind==='general'&&intent.wantsCode))block('PROJECT_KIND_MISMATCH');
  if(intent.intent==='review')block('QUALITY_MODEL_EVIDENCE_REQUIRED');
  const provider=registry.providers.find(provider=>provider.runtimeId===runtimeId),capability=provider?.capabilities.find(capability=>capability.id===capabilityId);
  if(capabilityId){
   if(!capability||capability.implementation!=='implemented')block('CAPABILITY_NOT_IMPLEMENTED');
   else if(capability.policy!=='allowed')block('CAPABILITY_BLOCKED_POLICY');
   if(!provider||provider.installation!=='found'&&provider.connection!=='ready')block('RUNTIME_INSTALLATION_UNKNOWN');
  }
  if(status==='recommended')reasons.push('PROJECT_SELECTION_PRESERVED','EXISTING_ADAPTER_ONLY','EXECUTION_PREFLIGHT_REQUIRED');
  const result:CapabilityRouteDecision={id:randomUUID(),requestId:input.requestId,projectId,taskId:input.taskId,createdAt:new Date().toISOString(),
   intent:intent.intent,status,runtimeId:capabilityId?runtimeId:null,capabilityId,reasons:[...new Set(reasons)],baseline:{planningVersionId:brief.planningVersionId,planningContentHash:brief.planningContentHash},
   preferencesRevision:prefs.revision,registryDigest:digest(registry),textDigest:digest(input.text),executionAuthorized:false,actualModel:'unknown'};
  this.store.transaction(()=>{
   this.recordDiscovery(registry);
   this.store.db.prepare('INSERT INTO capability_routes VALUES(?,?,?,?,?)').run(result.id,projectId,input.requestId,inputDigest,JSON.stringify(result));
   this.store.append('capability.route',null,{projectId,taskId:input.taskId,routeId:result.id,status:result.status,runtimeId:result.runtimeId});
  });return result;
 }
}
