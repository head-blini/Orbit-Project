import {ProjectAiPreferencesService} from '../server/project-ai-preferences.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './capability-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {CapabilityRoutingService} from '../server/capability-routing.ts';
import {discoverCapabilities} from '../server/capability-adapters.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
test('natural language routing respects project adapters, preserves baseline and never runs',()=>{
 for(const kind of ['code','general'] as const){const f=fixture(kind);try{
  const result=f.service.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text:kind==='code'?'코드를 구현해줘':'보고서를 작성해줘'},f.registry);
  assert.equal(result.status,'recommended');assert.equal(result.runtimeId,kind==='code'?'codex':'claude-code');
  assert.equal(result.baseline.planningContentHash,f.plan.contentHash);assert.equal(result.executionAuthorized,false);assert.equal(result.actualModel,'unknown');
  assert.equal(f.store.runs().length,0);assert.equal(f.service.records('p').length,1);
  assert.ok(!JSON.stringify(result).includes('보고서를 작성해줘'));assert.equal(result.textDigest.length,64);
 }finally{f.store.close();}}
});
test('unknown, conflicting, unsupported extensions and cross model review fail closed',()=>{
 const f=fixture();try{
  for(const [text,status,reason] of [
   ['알아서 해줘','needs_clarification','INTENT_UNCLEAR'],['실행하지 마','needs_clarification','INTENT_UNCLEAR'],
   ['MCP로 자료를 정리해줘','blocked','EXTENSION_NOT_AUTHORIZED'],['/some-command 실행','blocked','EXTENSION_NOT_AUTHORIZED'],
   ['다른 모델로 교차 검증해줘','blocked','QUALITY_MODEL_EVIDENCE_REQUIRED'],['코드를 구현해줘','blocked','PROJECT_KIND_MISMATCH'],
  ] as const){const r=f.service.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text},f.registry);assert.equal(r.status,status,text);assert.ok(r.reasons.includes(reason),text);}
  const mismatch=f.service.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text:'문서를 작성해줘',runtimeId:'codex'},f.registry);
  assert.equal(mismatch.status,'blocked');assert.ok(mismatch.reasons.includes('RUNTIME_SELECTION_REQUIRED'));
  assert.equal(f.store.runs().length,0);
 }finally{f.store.close();}
});
test('idempotency, scope, stale planning and sensitive text preserve policy',()=>{
 const f=fixture();try{
  const input={requestId:randomUUID(),taskId:f.task.id,text:'문서 작성'};
  const first=f.service.recommend('p',input,f.registry),seq=f.store.lastSeq();
  assert.deepEqual(f.service.recommend('p',input,discoverCapabilities({probe:null,codexReady:false})),first);
  assert.equal(f.store.lastSeq(),seq);assert.throws(()=>f.service.recommend('p',{...input,text:'다른 문서 작성'},f.registry),/IDEMPOTENCY_CONFLICT/);
  assert.throws(()=>f.service.recommend('missing',{...input,requestId:randomUUID()},f.registry),/PROJECT_NOT_FOUND/);
  assert.throws(()=>f.service.recommend('p',{...input,requestId:randomUUID(),text:'문서 작성 sk-proj-'+ 'a'.repeat(60)},f.registry),/CREDENTIAL|INPUT/);
  assert.throws(()=>f.service.recommend('p',{...input,requestId:randomUUID(),executionAuthorized:true} as never,f.registry),/INVALID_FIELDS/);
  f.store.db.prepare('UPDATE planning_heads SET version_id=?').run('different-head');
  assert.throws(()=>f.service.recommend('p',{...input,requestId:randomUUID()},f.registry),/PLANNING_VERSION_STALE/);
  assert.deepEqual(f.service.records('p'),[first]);assert.equal(f.store.runs().length,0);
 }finally{f.store.close();}
});
test('version absence never becomes runtime readiness and discovery cannot bypass review',()=>{
 const f=fixture();try{
  const registry=discoverCapabilities({probe:null,codexReady:false});
  const r=f.service.recommend('p',{requestId:randomUUID(),taskId:f.task.id,text:'문서 작성'},registry);
  assert.equal(r.status,'blocked');assert.ok(r.reasons.includes('RUNTIME_INSTALLATION_UNKNOWN'));
 }finally{f.store.close();}
});

test('explicit natural-language runtime choice is never silently replaced and code projects can write documents',()=>{
 const general=fixture(),code=fixture('code');try{
  const rejected=general.service.recommend('p',{requestId:randomUUID(),taskId:general.task.id,text:'Codex로 보고서를 작성해줘'},general.registry);
  assert.equal(rejected.status,'blocked');assert.ok(rejected.reasons.includes('RUNTIME_SELECTION_REQUIRED'));
  const document=code.service.recommend('p',{requestId:randomUUID(),taskId:code.task.id,text:'문서를 작성해줘'},code.registry);
  assert.equal(document.status,'recommended');assert.equal(document.runtimeId,'codex');
  new ProjectAiPreferencesService(code.store).update('p',{expectedRevision:0,planning:'claude-code',execution:'codex'});
  const planning=code.service.recommend('p',{requestId:randomUUID(),taskId:code.task.id,text:'기획해줘'},code.registry);
  assert.equal(planning.status,'recommended');assert.equal(planning.runtimeId,'claude-code');assert.equal(planning.preferencesRevision,1);assert.equal(planning.capabilityId,'plan');
  const media=general.service.recommend('p',{requestId:randomUUID(),taskId:general.task.id,text:'이미지 생성 작업을 실행해줘'},general.registry);
  assert.equal(media.status,'blocked');assert.ok(media.reasons.includes('CAPABILITY_NOT_IMPLEMENTED'));
 }finally{general.store.close();code.store.close();}
});

test('restart retains the exact discovery evidence and recommendation without replay',()=>{
 const dir=mkdtempSync(join(tmpdir(),'orbit-capability-')),path=join(dir,'test.sqlite'),f=fixture('general',path);let reopened:Store|undefined;
 try{
  const input={requestId:randomUUID(),taskId:f.task.id,text:'보고서 작성'},first=f.service.recommend('p',input,f.registry);
  f.store.close();reopened=new Store(path);const service=new CapabilityRoutingService(reopened),seq=reopened.lastSeq();
  assert.deepEqual(service.discovery(first.registryDigest),f.registry);
  assert.deepEqual(service.records('p'),[first]);
  assert.deepEqual(service.recommend('p',input,discoverCapabilities({probe:null,codexReady:false})),first);
  assert.equal(reopened.lastSeq(),seq);assert.equal(reopened.runs().length,0);
 }finally{reopened?.close();rmSync(dir,{recursive:true,force:true});}
});
