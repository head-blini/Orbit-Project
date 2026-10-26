import test from 'node:test';
import assert from 'node:assert/strict';
import type {ExtensionInventory} from '../shared/extensions.ts';
const module=await import('../server/extensions.ts').catch(()=>null);
function api(){assert.ok(module,'Extensions collector must exist');return module;}
const context=()=>({workspaceId:'workspace-fixture',workspacePath:process.cwd(),threadId:'thread-fixture',knownMcpNames:['fixture']});
function fixture(){const ctx=context(),calls:{method:string;params:unknown}[]=[];
  const mcp:any={data:[{name:'fixture',runtimeStatus:'disabled',tools:{},pluginId:null}],nextCursor:null};
  const skills:any={data:[{cwd:ctx.workspacePath,errors:[],skills:[{name:'Useful Skill',path:'C:/private/SKILL.md',scope:'repo',enabled:true,pluginId:null,description:'PRIVATE_DESCRIPTION',dependencies:{tools:['PRIVATE_DEPENDENCY']}}]}]};
  const hooks:any={data:[{cwd:ctx.workspacePath,errors:[],warnings:[],hooks:[{key:'PRIVATE_HOOK_KEY',eventName:'preToolUse',source:'project',enabled:true,handlerType:'command',trustStatus:'trusted',pluginId:null,command:'PRIVATE_COMMAND',sourcePath:'PRIVATE_SOURCE_PATH'}]}]};
  const request=async(method:string,params:unknown)=>{calls.push({method,params});return method==='mcpServerStatus/list'?mcp:method==='skills/list'?skills:hooks;};
  return {ctx,calls,mcp,skills,hooks,request};
}
const section=(inventory:ExtensionInventory,kind:string)=>inventory.sections.find(item=>item.kind===kind)!;

test('unqueried inventories are fresh detached unknown snapshots without RPC or fabricated installation',()=>{
  const m=api(),a=m.unknownExtensions('workspace-fixture'),b=m.unknownExtensions(null);assert.equal(a.status,'unknown');assert.equal(a.source,'not_queried');assert.equal(a.checkedAt,null);
  assert.deepEqual(a.sections.map(s=>s.kind),['skills','hooks','mcp','plugins']);assert.equal(section(a,'plugins').status,'not_connected');assert.ok(a.sections.every(s=>s.items.length===0));a.sections[0].items.push({} as never);assert.equal(b.sections[0].items.length,0);
});

test('MCP is verified first and official skills/hooks use exact parameters without plugin or activation calls',async()=>{
  const f=fixture(),result=await api().collectExtensions(f.request,f.ctx);assert.equal(result.status,'available');assert.equal(result.source,'codex_app_server');assert.ok(result.checkedAt);
  assert.deepEqual(f.calls,[{method:'mcpServerStatus/list',params:{threadId:f.ctx.threadId,detail:'toolsAndAuthOnly',limit:100}},{method:'skills/list',params:{cwds:[f.ctx.workspacePath],forceReload:false}},{method:'hooks/list',params:{cwds:[f.ctx.workspacePath]}}]);
  const skill=section(result,'skills').items[0],hook=section(result,'hooks').items[0],mcp=section(result,'mcp').items[0];
  assert.equal(skill.name,'Useful Skill');assert.equal(skill.configuredEnabled,true);assert.equal(skill.effective,'unknown');assert.equal(skill.scope,'repo');
  assert.equal(hook.name,'preToolUse');assert.equal(hook.nativeTrust,'trusted');assert.equal(hook.handlerType,'command');assert.equal(hook.effective,'blocked_policy');assert.equal(mcp.effective,'blocked_policy');
  assert.ok(result.sections.flatMap(s=>s.items).every(item=>/^[a-f0-9]{64}$/.test(item.id)&&item.version===null));assert.equal(section(result,'plugins').status,'not_connected');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|SKILL\.md|process|command.*PRIVATE/);
});

test('MCP isolation rejects duplicate missing unknown callable malformed cursor and oversized responses before other RPCs',async()=>{
  const variants=[{data:[],nextCursor:null},{data:[{name:'fixture',runtimeStatus:'disabled',tools:{}},{name:'fixture',runtimeStatus:'disabled',tools:{}}]},
    {data:[{name:'unknown',runtimeStatus:'disabled',tools:{}}]},{data:[{name:'fixture',runtimeStatus:'ready',tools:{}}]},
    {data:[{name:'fixture',runtimeStatus:null,tools:{}}]},{data:[{name:'fixture',runtimeStatus:'disabled',tools:{read:{}}}]},
    {data:[{name:'fixture',runtimeStatus:'disabled',tools:[]}]},{data:[{name:'fixture',runtimeStatus:'disabled',tools:Object.create({hidden:{}})}]},
    {data:[{name:'fixture',runtimeStatus:'disabled',tools:{}}],nextCursor:''},{data:Array(101).fill({name:'fixture',runtimeStatus:'disabled',tools:{}})}];
  for(const response of variants){const f=fixture();await assert.rejects(api().collectExtensions(async(method,params)=>{f.calls.push({method,params});return response;},f.ctx),(error:any)=>error.message==='MCP_ISOLATION_REQUIRED'&&error.status===503);assert.equal(f.calls.length,1);}
  const f=fixture();await assert.rejects(api().collectExtensions(async()=>{throw new Error('PRIVATE_FAILURE');},f.ctx),/^Error: MCP_ISOLATION_REQUIRED$/);
});

test('forbidden metadata getters, errors and warnings remain unread and raw failures are never returned',async()=>{
  const f=fixture();let reads=0;const secret=()=>{reads++;throw new Error('PRIVATE_GETTER');};
  for(const name of ['description','dependencies','interface','version'])Object.defineProperty(f.skills.data[0].skills[0],name,{get:secret,configurable:true});
  for(const name of ['command','sourcePath','matcher','statusMessage','server','tool','currentHash'])Object.defineProperty(f.hooks.data[0].hooks[0],name,{get:secret,configurable:true});
  Object.defineProperty(f.mcp.data[0],'authStatus',{get:secret});Object.defineProperty(f.mcp.data[0],'serverInfo',{get:secret});
  const errors=new Array(1);Object.defineProperty(errors,'0',{get:secret});f.skills.data[0].errors=errors;f.hooks.data[0].warnings=errors;
  const result=await api().collectExtensions(f.request,f.ctx);assert.equal(reads,0);assert.equal(section(result,'skills').status,'partial');assert.equal(section(result,'hooks').status,'partial');assert.equal(result.status,'partial');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|GETTER/);
});

test('required field accessors and malformed sections become unknown without falling back or dropping the good section',async()=>{
  for(const kind of ['skills','hooks'] as const){const f=fixture();let reads=0;const item=f[kind].data[0][kind][0];Object.defineProperty(item,kind==='skills'?'enabled':'eventName',{get(){reads++;throw new Error('PRIVATE_GETTER');}});
    const result=await api().collectExtensions(f.request,f.ctx);assert.equal(reads,0);assert.equal(section(result,kind).status,'unknown');assert.deepEqual(section(result,kind).items,[]);assert.equal(section(result,kind==='skills'?'hooks':'skills').status,'available');assert.equal(result.status,'partial');}
  const f=fixture();const result=await api().collectExtensions((method,params)=>method==='hooks/list'?Promise.reject(new Error('PRIVATE_FAILURE')):f.request(method,params),f.ctx);assert.equal(section(result,'hooks').issue,'EXTENSIONS_REQUEST_FAILED');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_FAILURE/);
});

test('workspace mismatches duplicate identities and caps fail sections closed rather than returning partial rows',async()=>{
  for(const kind of ['skills','hooks'] as const)for(const mode of ['cwd','duplicate','oversize'] as const){const f=fixture(),entry=f[kind].data[0];if(mode==='cwd')entry.cwd='other-workspace';if(mode==='duplicate')entry[kind].push({...entry[kind][0]});if(mode==='oversize')entry[kind]=Array(101).fill(entry[kind][0]);
    const result=await api().collectExtensions(f.request,f.ctx);assert.equal(section(result,kind).status,'unknown');assert.equal(section(result,kind).items.length,0);}
});

test('dangerous or overlong labels are masked while only hashed identity and configuration state survive',async()=>{
  for(const name of ['person@example.test','api_key=PRIVATE_TOKEN','\u202eevil','x'.repeat(81),'sk-PRIVATE_TOKEN']){const f=fixture();f.skills.data[0].skills[0].name=name;f.mcp.data[0].name=name;f.ctx.knownMcpNames=[name];
    const result=await api().collectExtensions(f.request,f.ctx);const skill=section(result,'skills').items[0],mcp=section(result,'mcp').items[0];assert.ok(skill.name.length<=80);assert.notEqual(skill.name,name);assert.notEqual(mcp.name,name);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_TOKEN|person@example|evil|x{81}/);assert.equal(skill.effective,'unknown');}
});

test('context and returned items detach from mutable caller and native response references',async()=>{
  const f=fixture(),ctxOriginal={...f.ctx,knownMcpNames:[...f.ctx.knownMcpNames]};let release!:(value:unknown)=>void;const slowHooks=new Promise(resolve=>{release=resolve;});
  const pending=api().collectExtensions(async(method,params)=>{f.calls.push({method,params});return method==='mcpServerStatus/list'?f.mcp:method==='skills/list'?f.skills:slowHooks;},f.ctx);
  f.ctx.workspaceId='changed';f.ctx.workspacePath='changed';f.ctx.threadId='changed';f.ctx.knownMcpNames.push('changed');
  for(let i=0;i<5;i++)await Promise.resolve();f.skills.data[0].skills[0].name='mutated after projection';release(f.hooks);
  const result=await pending;assert.equal(result.workspaceId,ctxOriginal.workspaceId);assert.equal(section(result,'skills').items[0].name,'Useful Skill');assert.equal((f.calls[1].params as any).cwds[0],ctxOriginal.workspacePath);
  f.hooks.data[0].hooks[0].enabled=false;assert.equal(section(result,'hooks').items[0].configuredEnabled,true);section(result,'skills').items[0].name='caller edit';assert.equal(f.skills.data[0].skills[0].name,'mutated after projection');
});

test('verified zero-item sections differ from unknown and invalid context makes no RPC',async()=>{
  const f=fixture();f.ctx.knownMcpNames=[];f.mcp.data=[];f.skills.data[0].skills=[];f.hooks.data[0].hooks=[];const result=await api().collectExtensions(f.request,f.ctx);assert.equal(result.status,'available');assert.ok(result.sections.every(s=>!s.items.length));
  let calls=0;await assert.rejects(api().collectExtensions(async()=>{calls++;return {};},{...f.ctx,knownMcpNames:['duplicate','duplicate']}),/MCP_ISOLATION_REQUIRED/);assert.equal(calls,0);
});
