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
