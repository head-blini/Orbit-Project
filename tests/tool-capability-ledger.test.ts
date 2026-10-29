import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregate,itemDigest} from '../server/tool-capability-ledger.ts';
import type {ToolDiscoverySection,ToolGrant,ToolInvocationRecord,ToolItemMeta,ToolKind} from '../shared/tool-capabilities.ts';

const meta=(kind:ToolKind,id:string,over:Partial<ToolItemMeta>={}):ToolItemMeta=>({kind,id,scope:'user',handlerType:'mcpTool',nativeTrust:'trusted',pluginOwned:false,runtimeVersion:'1',adapterRevision:'a1',...over});
const key=(kind:ToolKind,itemId:string)=>({runtimeId:'codex' as const,kind,itemId});
const sec=(kind:ToolKind,items:ToolItemMeta[],status:ToolDiscoverySection['status']='available'):ToolDiscoverySection=>({runtimeId:'codex',kind,status,items});
const grant=(m:ToolItemMeta,grantId='g1'):ToolGrant=>({grantId,key:key(m.kind,m.id),itemDigest:itemDigest(m)});
const rec=(m:ToolItemMeta,evidenceSource:ToolInvocationRecord['evidenceSource'],g:ToolGrant|null):ToolInvocationRecord=>({key:key(m.kind,m.id),evidenceSource,grantId:g?.grantId??null,itemDigest:g?.itemDigest??null});

test('installed does not imply permitted, invoked or verified',()=>{
  const m=meta('mcp','a'),r=aggregate([sec('mcp',[m])],[],[]);
  assert.deepEqual(r.states[0],{key:key('mcp','a'),installed:'discovered',permitted:null,invoked:{native:0,mock:0,unknown:0},verified:0});
});
test('permitted without invocation is not invoked; invoked without grant is not verified',()=>{
  const m=meta('mcp','a'),g=grant(m);
  assert.equal(aggregate([sec('mcp',[m])],[g],[]).states[0].invoked.native,0);
  const s=aggregate([sec('mcp',[m])],[],[rec(m,'native',null)]).states[0];
  assert.equal(s.invoked.native,1);assert.equal(s.verified,0);
});
test('native with matching grant verifies; mock/unknown/local give verified 0',()=>{
  const m=meta('mcp','a'),g=grant(m),s=(rs:ToolInvocationRecord[])=>aggregate([sec('mcp',[m])],[g],rs).states[0];
  assert.equal(s([rec(m,'native',g)]).verified,1);
  const bad=s([rec(m,'mock',g),rec(m,'unknown',g),rec(m,'local',g)]);
  assert.deepEqual(bad.invoked,{native:0,mock:1,unknown:2});assert.equal(bad.verified,0);
  assert.equal(s([rec(m,'native',{...g,itemDigest:'0'.repeat(64)})]).verified,0);
});
test('metadata change voids the grant and verification',()=>{
  const old=meta('mcp','a'),g=grant(old),changed=meta('mcp','a',{nativeTrust:'modified'});
  const s=aggregate([sec('mcp',[changed])],[g],[rec(old,'native',g)]).states[0];
  assert.equal(s.permitted,null);assert.equal(s.verified,0);assert.equal(s.invoked.native,1);
  assert.notEqual(itemDigest(old),itemDigest(changed));
});
test('plugin, hook and subagent are never permitted',()=>{
  const ms=(['plugin','hook','subagent'] as const).map(k=>meta(k,k));
  const r=aggregate(ms.map(m=>sec(m.kind,[m])),ms.map(m=>grant(m)),ms.map(m=>rec(m,'native',grant(m))));
  for(const s of r.states){assert.equal(s.installed,'discovered');assert.equal(s.permitted,null);assert.equal(s.verified,0);}
  assert.equal(r.totals.permitted,0);
});
test('unknown inputs stay unknown; absent only from an available section',()=>{
  const m=meta('skill','s'),g=grant(m);
  assert.equal(aggregate([],[g],[]).states[0].installed,'unknown');
  assert.equal(aggregate([sec('skill',[],'partial')],[g],[]).states[0].installed,'unknown');
  const s=aggregate([sec('skill',[])],[g],[]).states[0];
  assert.equal(s.installed,'absent');assert.equal(s.permitted,null);
});
test('totals are deterministic regardless of input order',()=>{
  const a=meta('mcp','a'),b=meta('skill','b'),ga=grant(a,'g1'),gb=grant(b,'g2');
  const secs=[sec('mcp',[a]),sec('skill',[b])],rs=[rec(a,'native',ga),rec(b,'mock',gb),rec(a,'unknown',null)];
  const one=aggregate(secs,[ga,gb],rs),two=aggregate([...secs].reverse(),[gb,ga],[...rs].reverse());
  assert.deepEqual(one,two);
  // Only Codex MCP is grantable under the adopted defaults, so the skill grant is void.
  assert.deepEqual(one.totals,{keys:2,installed:2,permitted:1,invoked:{native:1,mock:1,unknown:1},verified:1});
});

test('only Codex MCP is grantable: skills, slash commands and Claude MCP grants are void',()=>{
  for(const [kind,runtimeId] of [['skill','codex'],['slash_command','codex'],['mcp','claude-code']] as const){
    const m=meta(kind,'x'),k={runtimeId,kind,itemId:'x'},g={...grant(m,'g'),key:k};
    const out=aggregate([{...sec(kind,[m]),runtimeId}],[g],[{...rec(m,'native',g),key:k}]);
    assert.equal(out.totals.permitted,0,kind+'/'+runtimeId);assert.equal(out.totals.verified,0,kind+'/'+runtimeId);
  }
});
