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
 const extension=/\b(?:mcp|skills?|hooks?|slash|plugins?)\b|스킬|훅|슬래시|플러그인|(?:^|\s)\/[a-z][\w-]*/i.test(normalized);
 const unsupported=/이미지\s*생성|그림\s*생성|영상\s*생성|음성\s*생성|\b(?:generate|create)\s+(?:an?\s+)?(?:image|video|audio)\b|웹\s*검색|인터넷\s*검색|\bweb\s+search\b|\b(?:api|bedrock|ollama|vllm)\b/i.test(normalized);
 const review=/검증|검토|리뷰|\breview\b|\bverify\b/i.test(normalized);
 const planning=/기획|계획|\bplan(?:ning)?\b/i.test(normalized);
 const execution=/작성|구현|개발|수정|정리|요약|분석|실행|수행|진행|\b(?:run|execute|implement|write|summari[sz]e|fix|analy[sz]e)\b/i.test(normalized);
 const negative=/하지\s*마|하지\s*않|말고|금지|\b(?:not|never|without)\b|don['’]t/i.test(normalized);
 const intent:CapabilityRouteDecision['intent']=negative||Number(review)+Number(planning)+Number(execution)!==1?'unknown':review?'review':planning?'planning':'execution';
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
  exact(input as unknown as Record<string,unknown>,['requestId','taskId','text',...(Object.hasOwn(input,'runtimeId')?['runtimeId']:[])]);
  if(!id(input.requestId)||!id(input.taskId)||typeof input.text!=='string'||!input.text.trim()||input.text.length>4000||input.runtimeId!==undefined&&!['codex','claude-code'].includes(input.runtimeId))throw new AppError('INVALID_FIELDS',400);
  if(containsCredential(input.text)||outboundDenial(input.text))throw new AppError('SENSITIVE_ROUTING_INPUT',400);
  const project=this.project(projectId),inputDigest=digest({projectId,requestId:input.requestId,taskId:input.taskId,text:input.text,runtimeId:input.runtimeId??null});
  const previous=this.store.db.prepare('SELECT input_digest,body FROM capability_routes WHERE request_id=?').get(input.requestId);
  if(previous){if(previous.input_digest!==inputDigest)throw new AppError('IDEMPOTENCY_CONFLICT',409);return JSON.parse(String(previous.body));}
  const brief=this.studio.execution(projectId,input.taskId),prefs=this.preferences.read(projectId),intent=classify(input.text);
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
