import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {Controller} from '../server/controller.ts';
import {Studio} from '../server/studio.ts';
import {createWorkspace} from '../server/workspace.ts';
import {createHttpServer} from '../server/http.ts';
import {kstIso,reuseDecisions} from '../server/reuse-discovery.ts';
import {approvedReuseDecisions,readReuseEvidence,vendorReuse} from '../server/reuse-vendor.ts';
import type {PlanningVersion} from '../shared/parallel.ts';

const now=()=>new Date('2026-10-30T03:04:05Z'),CDN='https://cdn.jsdelivr.net/npm/';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const adopt=(name='left-pad',version='1.3.0',planningVersionId='plan-1')=>({planningVersionId,...reuseDecisions({status:'searched',checkedAt:kstIso(now()),issue:null,
  candidates:[{name,version,license:'WTFPL',source:'https://www.npmjs.com/package/left-pad',decision:'adopt',reason:'Small and maintained'}]})[0]});
type Reply={status?:number;type?:string;body?:string;url?:string;headers?:Record<string,string>};
function fakeFetch(routes:Record<string,Reply>){
  const calls:{url:string;init:RequestInit}[]=[];
  const fetch=(async(input:string|URL|Request,init:RequestInit={})=>{
    const url=String(input);calls.push({url,init});
    const reply=routes[url];if(!reply)return new Response('missing',{status:404,headers:{'content-type':'text/plain'}});
    const response=new Response(reply.body??'',{status:reply.status??200,headers:{'content-type':reply.type??'text/plain',...reply.headers}});
    if(reply.url)Object.defineProperty(response,'url',{value:reply.url});
    return response;
  }) as typeof globalThis.fetch;
  return {fetch,calls};
}
const pkg=(extra:object={},name='left-pad',version='1.3.0')=>({type:'application/json; charset=utf-8',body:JSON.stringify({name,version,license:'WTFPL',main:'index.js',...extra})});
const routes=(extra:Record<string,Reply>={})=>({
  [CDN+'left-pad@1.3.0/package.json']:pkg({jsdelivr:'./dist/left-pad.min.js'}),
  [CDN+'left-pad@1.3.0/dist/left-pad.min.js']:{type:'application/javascript; charset=utf-8',body:'export const leftPad=1;'},
  [CDN+'left-pad@1.3.0/LICENSE.md']:{type:'text/markdown; charset=utf-8',body:'WTFPL text'},...extra});
function workspace(){const dir=mkdtempSync(join(tmpdir(),'orbit-reuse-vendor-')),root=join(dir,'ws');mkdirSync(root);return {dir,root,close:()=>rmSync(dir,{recursive:true,force:true})};}
const run=(root:string,fetch:typeof globalThis.fetch,decision=adopt(),extra:object={})=>vendorReuse({workspacePath:root,approved:[decision],planningVersionId:decision.planningVersionId,topic:decision.topic,fetch,now,...extra});
const rejects=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,(error:Error)=>error.message===code);

test('happy path writes entry + LICENSE under vendor/, records sha256 evidence, and is idempotent',async()=>{
  const w=workspace();try{
    const f=fakeFetch(routes()),result=await run(w.root,f.fetch);
    assert.equal(result.status,'vendored');
    assert.ok(f.calls.every(call=>call.url.startsWith(CDN+'left-pad@1.3.0/')&&call.init.redirect==='error'&&call.init.signal instanceof AbortSignal));
    assert.deepEqual(f.calls.map(call=>call.url.slice(CDN.length)),['left-pad@1.3.0/package.json','left-pad@1.3.0/dist/left-pad.min.js','left-pad@1.3.0/LICENSE','left-pad@1.3.0/LICENSE.md']);
    const dir=join(w.root,'vendor','left-pad-1.3.0');
    assert.equal(readFileSync(join(dir,'left-pad.min.js'),'utf8'),'export const leftPad=1;');assert.equal(readFileSync(join(dir,'LICENSE.md'),'utf8'),'WTFPL text');
    const evidence=JSON.parse(readFileSync(join(w.root,'vendor','REUSE-EVIDENCE.json'),'utf8'));
    assert.deepEqual(evidence,{entries:[{name:'left-pad',version:'1.3.0',license:{decision:'WTFPL',package:'WTFPL'},sourceDecision:'재사용: left-pad',sourceUrl:'https://www.npmjs.com/package/left-pad',
      files:[{path:'vendor/left-pad-1.3.0/left-pad.min.js',url:CDN+'left-pad@1.3.0/dist/left-pad.min.js',sha256:sha('export const leftPad=1;'),bytes:23},
        {path:'vendor/left-pad-1.3.0/LICENSE.md',url:CDN+'left-pad@1.3.0/LICENSE.md',sha256:sha('WTFPL text'),bytes:10}],
      licenseFile:'vendor/left-pad-1.3.0/LICENSE.md',checkedAt:'2026-10-30T12:04:05+09:00',planningVersionId:'plan-1'}]});
    assert.deepEqual(readReuseEvidence(w.root),evidence);
    const again=await run(w.root,fakeFetch(routes()).fetch);assert.equal(again.status,'unchanged');assert.equal(readReuseEvidence(w.root).entries.length,1);
    writeFileSync(join(dir,'left-pad.min.js'),'locally edited');
    await rejects(run(w.root,fakeFetch(routes()).fetch),'REUSE_VENDOR_CONFLICT');assert.equal(readFileSync(join(dir,'left-pad.min.js'),'utf8'),'locally edited');
  }finally{w.close();}
});

test('scoped package without LICENSE records license_file:absent and a preview-safe folder',async()=>{
  const w=workspace();try{
    const base=CDN+'@scope/ui@2.0.0-beta.1/',f=fakeFetch({[base+'package.json']:pkg({main:'../escape.js',style:'dist/ui.css',license:undefined},'@scope/ui','2.0.0-beta.1'),[base+'dist/ui.css']:{type:'text/css',body:'a{}'}});
    const result=await run(w.root,f.fetch,adopt('@scope/ui','2.0.0-beta.1'));
    assert.equal(result.entry.licenseFile,'license_file:absent');assert.equal(result.entry.license.package,null);
    assert.deepEqual(result.entry.files.map(file=>file.path),['vendor/_scope__ui-2.0.0-beta.1/ui.css']);
    assert.ok(!f.calls.some(call=>call.url.includes('escape')),'unsafe entry fields are skipped, never fetched');
  }finally{w.close();}
});

test('host lock: entry fields with other hosts are ignored, redirects and transport failures are refused',async()=>{
  const w=workspace();try{
    const absolute=fakeFetch(routes({[CDN+'left-pad@1.3.0/package.json']:pkg({jsdelivr:'https://evil.example/x.js',browser:'//evil.example/y.js'}),[CDN+'left-pad@1.3.0/index.js']:{type:'text/javascript',body:'1'}}));
    const result=await run(w.root,absolute.fetch);
    assert.ok(absolute.calls.every(call=>call.url.startsWith(CDN+'left-pad@1.3.0/')));assert.equal(result.entry.files[0].path,'vendor/left-pad-1.3.0/index.js');
  }finally{w.close();}
  const v=workspace();try{
    await rejects(run(v.root,fakeFetch(routes({[CDN+'left-pad@1.3.0/package.json']:{...pkg(),url:'https://evil.example/package.json'}})).fetch),'REUSE_VENDOR_REDIRECT');
    const throwing=(async()=>{throw new TypeError('fetch failed: redirect mode is set to error');}) as unknown as typeof fetch;
    await rejects(run(v.root,throwing),'REUSE_VENDOR_FETCH_FAILED');
    assert.equal(existsSync(join(v.root,'vendor')),false);
  }finally{v.close();}
});

test('oversize, content-type mismatch and package identity mismatch are refused before any write',async()=>{
  const w=workspace();try{
    const big='x'.repeat(2*1024*1024+1);
    await rejects(run(w.root,fakeFetch(routes({[CDN+'left-pad@1.3.0/dist/left-pad.min.js']:{type:'application/javascript',body:big}})).fetch),'REUSE_VENDOR_TOO_LARGE');
    await rejects(run(w.root,fakeFetch(routes({[CDN+'left-pad@1.3.0/dist/left-pad.min.js']:{type:'application/javascript',body:'a',headers:{'content-length':String(big.length)}}})).fetch),'REUSE_VENDOR_TOO_LARGE');
    await rejects(run(w.root,fakeFetch(routes({[CDN+'left-pad@1.3.0/dist/left-pad.min.js']:{type:'text/html',body:'<script>'}})).fetch),'REUSE_VENDOR_CONTENT_TYPE');
    await rejects(run(w.root,fakeFetch(routes({[CDN+'left-pad@1.3.0/package.json']:{type:'text/plain',body:'{}'}})).fetch),'REUSE_VENDOR_CONTENT_TYPE');
    await rejects(run(w.root,fakeFetch(routes({[CDN+'left-pad@1.3.0/package.json']:pkg({},'right-pad')})).fetch),'REUSE_VENDOR_PACKAGE_INVALID');
    await rejects(run(w.root,fakeFetch(routes({[CDN+'left-pad@1.3.0/package.json']:pkg({main:'index.ts',jsdelivr:undefined})})).fetch),'REUSE_VENDOR_NO_ENTRY');
    assert.equal(existsSync(join(w.root,'vendor')),false);
  }finally{w.close();}
});

test('invalid npm name or non-exact version is REUSE_VENDOR_UNSUPPORTED; decisions outside the approved head are refused',async()=>{
  const w=workspace(),f=fakeFetch(routes());try{
    for(const [name,version] of [['Chart.js','4.4.0'],['left-pad','^1.3.0'],['left-pad','latest'],['left-pad','1.3'],['a'.repeat(215),'1.0.0']])
      await rejects(run(w.root,f.fetch,adopt(name,version)),'REUSE_VENDOR_UNSUPPORTED');
    const decision=adopt();
    await rejects(run(w.root,f.fetch,{...decision,decision:decision.decision.replace('재사용 채택','재사용 미채택')}),'REUSE_VENDOR_UNSUPPORTED');
    await rejects(vendorReuse({workspacePath:w.root,approved:[decision],planningVersionId:'other-plan',topic:decision.topic,fetch:f.fetch}),'REUSE_VENDOR_DECISION_NOT_APPROVED');
    await rejects(vendorReuse({workspacePath:w.root,approved:[],planningVersionId:decision.planningVersionId,topic:decision.topic,fetch:f.fetch}),'REUSE_VENDOR_DECISION_NOT_APPROVED');
    assert.equal(f.calls.length,0);
    const version=(id:string,state:PlanningVersion['state'],lineageId='L')=>({id,projectId:'p',revision:1,contentHash:'h',state,lineageId,draft:{decisions:[{topic:decision.topic,decision:decision.decision,rationale:'r'},{topic:'Format',decision:'Markdown',rationale:'r'}]}}) as unknown as PlanningVersion;
    assert.deepEqual(approvedReuseDecisions([version('old','superseded'),version('draft','draft','M'),version('head','approved'),version('stale','approved','N')],lineage=>({L:'head',M:'draft',N:'other'} as Record<string,string>)[lineage]),
      [{planningVersionId:'head',topic:decision.topic,decision:decision.decision}]);
  }finally{w.close();}
});

test('symlinked or non-directory vendor paths are refused and outside files stay untouched',async()=>{
  const w=workspace();try{
    const outside=join(w.dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep.txt'),'keep');
    symlinkSync(outside,join(w.root,'vendor'));
    await rejects(run(w.root,fakeFetch(routes()).fetch),'REUSE_VENDOR_PATH_REJECTED');
    assert.throws(()=>readReuseEvidence(w.root),/REUSE_VENDOR_EVIDENCE_INVALID/);
    rmSync(join(w.root,'vendor'));writeFileSync(join(w.root,'vendor'),'user file');
    await rejects(run(w.root,fakeFetch(routes()).fetch),'REUSE_VENDOR_PATH_REJECTED');assert.equal(readFileSync(join(w.root,'vendor'),'utf8'),'user file');
    rmSync(join(w.root,'vendor'));mkdirSync(join(w.root,'vendor','left-pad-1.3.0'),{recursive:true});
    symlinkSync(join(outside,'keep.txt'),join(w.root,'vendor','left-pad-1.3.0','left-pad.min.js'));
    await rejects(run(w.root,fakeFetch(routes()).fetch),'REUSE_VENDOR_PATH_REJECTED');
    symlinkSync(join(outside,'keep.txt'),join(w.root,'vendor','REUSE-EVIDENCE.json'));
    assert.throws(()=>readReuseEvidence(w.root),/REUSE_VENDOR_EVIDENCE_INVALID/);
    assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'keep');
    const guarded=workspace();try{await rejects(run(guarded.root,fakeFetch(routes()).fetch,adopt(),{beforeWrite:()=>{throw new Error('WORKSPACE_MISMATCH');}}),'WORKSPACE_MISMATCH');assert.equal(existsSync(join(guarded.root,'vendor')),false);}finally{guarded.close();}
  }finally{w.close();}
});

async function server(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-reuse-http-')),root=join(dir,'project');mkdirSync(root);
  const git=(...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,stdio:'pipe'});
  git('init','-q','-b','main');writeFileSync(join(root,'index.html'),'<!doctype html><h1>app</h1>');
  git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgSign=false','commit','-qm','fixture');
  const store=new Store(join(dir,'test.sqlite')),projects=new Projects(store,join(dir,'managed'),[root]);
  const project=projects.register(root),workspace=projects.create(project.id),other=projects.create(project.id);
  const controller=new Controller(store,createWorkspace(dir),()=>{throw Error('NO_NATIVE_ALLOWED');},projects);await controller.selectWorkspace(workspace.id);
  writeFileSync(join(dir,'index.html'),'<!doctype html><html><head><title>fixture</title></head><body></body></html>');
  // An approved head whose adopt decision is not an exact semver: the route must resolve it server-side and refuse before any network.
  const studio=new Studio(store),decision=adopt('left-pad','latest');
  const text=JSON.stringify({schema_version:'1.0',title:'App',goal:'Pad text',requirements:[{id:'R1',description:'Pad',acceptance_criteria:['Padded']}],constraints:[],open_questions:[],decisions:[{topic:decision.topic,decision:decision.decision,rationale:'r'}]});
  const draft=studio.mutate(project.id,'plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text}}) as PlanningVersion;
  const plan=studio.mutate(project.id,'plans',draft.id,'approve',{expectedRevision:1}) as PlanningVersion;
  const http=createHttpServer(controller,dir);await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(http.address() as {port:number}).port;
  const response=await fetch(origin+'/api/session'),{csrfToken}=await response.json() as any;
  const headers={Cookie:response.headers.get('set-cookie')!.split(';')[0],Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  const base='/api/workspaces/'+workspace.id+'/reuse-vendor';
  return {plan,decision,workspace,base,other,
    get:(path=base)=>fetch(origin+path,{headers}),post:(body:object,path=base)=>fetch(origin+path,{method:'POST',headers,body:JSON.stringify(body)}),
    close:async()=>{http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));await controller.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('HTTP: exact keys, approved head as source of truth, selected workspace only',async()=>{
  const s=await server();try{
    const view=await (await s.get()).json() as any;
    assert.deepEqual(view,{evidence:{entries:[]},decisions:[{planningVersionId:s.plan.id,topic:'재사용: left-pad',decision:s.decision.decision}]});
    const body={planningVersionId:s.plan.id,topic:'재사용: left-pad'};
    for(const bad of [{...body,name:'left-pad'},{planningVersionId:s.plan.id},{...body,topic:1}]){const r=await s.post(bad);assert.equal(r.status,400);assert.equal((await r.json() as any).error,'INVALID_FIELDS');}
    assert.equal((await s.post(body,s.base+'?x=1')).status,400);assert.equal((await s.get(s.base+'?x=1')).status,400);
    const unsupported=await s.post(body);assert.equal(unsupported.status,422);assert.equal((await unsupported.json() as any).error,'REUSE_VENDOR_UNSUPPORTED');
    const missing=await s.post({...body,topic:'재사용: other'});assert.equal(missing.status,404);assert.equal((await missing.json() as any).error,'REUSE_VENDOR_DECISION_NOT_APPROVED');
    const otherPath='/api/workspaces/'+s.other.id+'/reuse-vendor';
    const wrong=await s.post(body,otherPath);assert.equal(wrong.status,409);assert.equal((await wrong.json() as any).error,'WORKSPACE_MISMATCH');
    assert.equal((await s.get(otherPath)).status,409);
    assert.equal(existsSync(join(s.workspace.path,'vendor')),false);
  }finally{await s.close();}
});
