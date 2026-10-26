import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCapabilityRegistry } from '../server/capabilities.ts';
import { restrictedArgs } from '../server/codex.ts';

test('official support and installed version never imply an Orbit connection or permission',()=>{
  const registry=buildCapabilityRegistry('disconnected',null);
  assert.equal(registry.providers.length,2);
  for(const provider of registry.providers){
    assert.equal(provider.nativeProbe.status,'unknown');
    assert.equal(provider.nativeProbe.version,null);
    assert.equal(provider.billing.source,'unknown');
    assert.equal(provider.billing.remaining,null);
    for(const capability of provider.capabilities){
      assert.notEqual(capability.effective,'available');
      assert.equal(capability.runtime,'unknown');
      assert.ok(capability.sources.every(url=>url.startsWith('https://')));
    }
  }
  const found={checkedAt:'2026-10-25T00:00:00.000Z',codex:{status:'found' as const,version:'0.164.0'},claude:{status:'found' as const,version:'2.0.0'}};
  assert.ok(buildCapabilityRegistry('disconnected',found).providers.every(provider=>provider.capabilities.every(capability=>capability.effective!=='available')));
});

test('ready confirms only connected core capabilities and keeps restricted native tools disabled',()=>{
  const provider=buildCapabilityRegistry('ready',null).providers[0];
  for(const id of ['session','streaming','resume','interrupt']){
    const capability=provider.capabilities.find(item=>item.id===id)!;
    assert.equal(capability.effective,'available');
    assert.equal(capability.runtime,id==='session'?'confirmed':'unknown');
    assert.equal(capability.verification,'contract_tests');
  }
  for(const [id,flag] of [['hooks','hooks'],['plugins','plugins'],['subagents','multi_agent'],['goal','goals']] as const){
    assert.ok(restrictedArgs.some((arg,index)=>arg==='--disable'&&restrictedArgs[index+1]===flag));
    assert.equal(provider.capabilities.find(item=>item.id===id)!.effective,'blocked_policy');
  }
  assert.equal(provider.capabilities.find(item=>item.id==='mcp')!.effective,'blocked_policy');
  assert.equal(provider.capabilities.find(item=>item.id==='verification')!.effective,'not_connected');
  assert.ok(buildCapabilityRegistry('ready',null).providers[1].capabilities.every(item=>item.effective==='not_connected'));
});

test('not found on PATH is diagnostic evidence, not a claim of absent installation or authentication',()=>{
  const probe={checkedAt:'2026-10-25T00:00:00.000Z',codex:{status:'failed' as const,version:null},claude:{status:'not_found_on_path' as const,version:null}};
  const registry=buildCapabilityRegistry('auth_required',probe);
  assert.equal(registry.providers[0].connection,'auth_required');
  assert.equal(registry.providers[1].connection,'not_connected');
  assert.equal(registry.providers[1].authStatus,'unknown');
  assert.equal(registry.providers[1].nativeProbe.status,'not_found_on_path');
  assert.equal(registry.probedAt,probe.checkedAt);
  const returned=registry.providers[0].capabilities;returned.length=0;
  assert.ok(buildCapabilityRegistry('ready',null).providers[0].capabilities.length>10);
});

test('native review exposes the implemented isolated contract without claiming live runtime success or verification',()=>{
  const disconnected=buildCapabilityRegistry('disconnected',null).providers[0].capabilities.find(item=>item.id==='review')!;
  assert.equal(disconnected.effective,'connection_required');assert.equal(disconnected.verification,'contract_tests');assert.equal(disconnected.runtime,'unknown');
  const connected=buildCapabilityRegistry('ready',null).providers[0].capabilities.find(item=>item.id==='review')!;
  assert.equal(connected.effective,'available');assert.equal(connected.runtime,'unknown');assert.match(connected.note,/별도.*읽기 전용/);assert.match(connected.note,/실서비스.*미검증/);
});

test('extension list contracts do not claim native activation or live inventory success',()=>{
  const provider=buildCapabilityRegistry('ready',null).providers[0];
  for(const id of ['skills','hooks','mcp']){
    const capability=provider.capabilities.find(item=>item.id===id)!;
    assert.equal(capability.verification,'contract_tests');assert.equal(capability.runtime,'unknown');
    assert.match(capability.note,/목록|조회/);
  }
  assert.equal(provider.capabilities.find(item=>item.id==='skills')!.effective,'available');
  for(const id of ['hooks','mcp','plugins'])assert.equal(provider.capabilities.find(item=>item.id===id)!.effective,'blocked_policy');
});
