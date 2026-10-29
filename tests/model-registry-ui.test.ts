import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import ts from 'typescript';
import type {RegistryValidation} from '../shared/model-registry.ts';

async function load(){
  const webRoot=new URL('../web/',import.meta.url).href;
  const hooks=registerHooks({load(url,context,next){
    if(url.startsWith(webRoot)&&url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};
    return next(url,context);
  }});
  try{return await import('../web/model-registry.tsx');}finally{hooks.deregister();}
}
const unknownCost={kind:'unknown',source:'unknown',checkedAt:null,sourceUrl:null,currency:null,unit:null,unitPrice:null} as const;
const row=(over:object={})=>({id:'m1',label:'Model 1',kind:'model',providerId:'p1',modelId:'gpt-x',origin:'user',revision:2,enabled:true,createdAt:'',updatedAt:'',declaredCapabilities:[],cost:unknownCost,
  configDigest:'a'.repeat(64),authReferences:[],nativeStatus:null,...over}) as any;
const validation=(over:Partial<RegistryValidation>):RegistryValidation=>({id:'v'+Math.random(),requestId:'r',entryId:'m1',revision:2,configDigest:'a'.repeat(64),requestDigest:'b'.repeat(64),kind:'local',state:'passed',createdAt:'2026-10-29T01:00:00Z',finishedAt:'2026-10-29T01:00:01Z',evidenceRefs:[],code:null,...over});

test('registry status uses only validations bound to the current revision and config digest',async()=>{
  const {registryStatus,writable}=await load();
  assert.equal(registryStatus(row(),[]),'검증 전');
  assert.equal(registryStatus(row(),[validation({})]),'설정 검사 통과 · 연결 진단 전');
  assert.equal(registryStatus(row(),[validation({revision:1})]),'검증 전','older revision evidence never counts');
  assert.equal(registryStatus(row(),[validation({configDigest:'c'.repeat(64)})]),'검증 전','changed config digest invalidates evidence');
  assert.equal(registryStatus(row(),[validation({}),validation({kind:'connection',state:'intent'})]),'연결 진단 진단 중 · 결과 미확인');
  assert.equal(registryStatus(row(),[validation({kind:'connection',state:'unknown'})]),'연결 진단 결과 미확인');
  assert.equal(registryStatus(row({enabled:false}),[validation({kind:'connection'})]),'비활성');
  assert.equal(writable(row()),true);assert.equal(writable(row({origin:'env'})),false);assert.equal(writable(row({origin:'builtin'})),false);
});
