import test from 'node:test';
import assert from 'node:assert/strict';
import { codexArgs } from '../server/codex.ts';
test('coding enables its required local tool host while preserving shell, MCP-related and other tool restrictions',()=>{
  const flags=(args:string[],option:string)=>args.filter((_v,i)=>args[i-1]===option);
  assert.ok(flags(codexArgs(false),'--disable').includes('code_mode_host'));
  assert.ok(flags(codexArgs(true),'--enable').includes('code_mode_host'));
  for(const feature of ['shell_tool','apps','plugins','hooks','code_mode','multi_agent','skill_mcp_dependency_install'])assert.ok(flags(codexArgs(true),'--disable').includes(feature));
  assert.equal(codexArgs(true).includes('danger-full-access'),false);
});
test('both native session modes explicitly disable unowned Goal continuations',()=>{
  for(const write of [false,true]){
    const args=codexArgs(write);
    assert.ok(args.some((arg,index)=>arg==='--disable'&&args[index+1]==='goals'));
    assert.equal(args.some((arg,index)=>arg==='--enable'&&args[index+1]==='goals'),false);
  }
});

import {toolLaunchConfig} from '../server/codex.ts';
test('tool profile enables exactly one known server and preserves network isolation',()=>{
  const profile=toolLaunchConfig(['fixture','other'],'fixture');
  assert.deepEqual(profile.mcp_servers,{fixture:{enabled:true},other:{enabled:false}});
  assert.deepEqual(profile.sandbox_workspace_write,{writable_roots:[],network_access:false,exclude_tmpdir_env_var:true,exclude_slash_tmp:true});
  assert.throws(()=>toolLaunchConfig(['other'],'fixture'),/MCP_ISOLATION_REQUIRED/);
  assert.throws(()=>toolLaunchConfig(['fixture','fixture'],'fixture'),/MCP_ISOLATION_REQUIRED/);
});
