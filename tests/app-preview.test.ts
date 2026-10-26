import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AppPreviewHost} from '../server/app-preview.ts';
import type {WorkspaceFileSnapshot} from '../server/workspace-fingerprint.ts';

const file=(path:string,text:string):WorkspaceFileSnapshot=>({path,mode:'100644',presence:'present',bytes:Buffer.from(text)});
async function fixture(){
  let files=[file('site/index.html','<!doctype html><button>Count</button><script type="module" src="./app.js"></script>'),file('site/app.js','export const value=1;'),file('site/style.css','body{color:navy}'),file('README.md','not an asset')];
  let clock=Date.now();const snapshot=()=>({sourceDigest:createHash('sha256').update(JSON.stringify(files)).digest('hex'),files});
  const host=new AppPreviewHost(()=>snapshot(),()=>clock);await host.listen('http://127.0.0.1:4317');
  const create=(workspaceId='workspace')=>host.create(workspaceId,{entryPath:'site/index.html',expectedSourceDigest:snapshot().sourceDigest});
  return {host,create,snapshot,set:(next:WorkspaceFileSnapshot[])=>{files=next;},advance:()=>{clock+=600001;},close:()=>host.close()};
}
const get=(url:string,dest='iframe',extra:Record<string,string>={})=>fetch(url,{headers:{'Sec-Fetch-Dest':dest,...extra}});

test('closing during listener startup cannot reopen a preview origin',async()=>{
  const host=new AppPreviewHost(()=>({sourceDigest:'a'.repeat(64),files:[]}));
  const starting=host.listen('http://127.0.0.1:4317').catch(()=>{});
  await host.close();await starting;assert.equal(host.origin,'');
});

test('preview serves exact frozen HTML and relative module assets on a separate origin',async()=>{
  const f=await fixture();try{
    assert.deepEqual(f.host.catalog('workspace').entries,['site/index.html']);
    const preview=f.create();assert.equal(preview.sourceDigest,f.snapshot().sourceDigest);assert.notEqual(new URL(preview.url).origin,'http://127.0.0.1:4317');
    const page=await get(preview.url);assert.equal(page.status,200);assert.equal(await page.text(),Buffer.from((f.snapshot().files[0] as any).bytes).toString());
    const script=await get(new URL('./app.js',preview.url).href,'script',{Origin:'null'});assert.equal(script.status,200);assert.equal(await script.text(),'export const value=1;');
    assert.equal(script.headers.get('access-control-allow-origin'),'*');assert.equal(script.headers.get('access-control-allow-credentials'),null);
    assert.equal(script.headers.get('set-cookie'),null);assert.equal(script.headers.get('content-type'),'text/javascript; charset=utf-8');
    f.set([file('site/index.html','NEW')]);assert.notEqual(f.host.catalog('workspace').sourceDigest,preview.sourceDigest);
    assert.match(await (await get(preview.url)).text(),/Count/);
    assert.throws(()=>f.host.create('workspace',{entryPath:'site/index.html',expectedSourceDigest:preview.sourceDigest}),/APP_PREVIEW_STALE/);
    const next=f.create();assert.equal((await get(preview.url)).status,404);assert.equal(await (await get(next.url)).text(),'NEW');
  }finally{await f.close();}
});

test('preview denies non-assets, navigation documents, hostile origins and expired capabilities',async()=>{
  const f=await fixture();try{
    const preview=f.create(),url=preview.url;
    for(const dest of ['document','script','empty',''])assert.equal((await get(url,dest)).status,403);
    assert.equal((await get(url,'iframe',{Origin:'https://example.invalid'})).status,403);
    for(const path of ['../README.md','../../api/state','./missing.js','./%2e%2e%2fREADME.md','./app.js?token=bad','./app.js%00'])assert.equal((await get(new URL(path,url).href,'script')).status,404,path);
    assert.equal((await fetch(url,{method:'POST'})).status,405);
    const headers=(await get(url)).headers,csp=headers.get('content-security-policy')!;
    for(const value of ["sandbox allow-scripts","connect-src 'none'","worker-src 'none'","frame-src 'none'","base-uri 'none'","form-action 'none'","frame-ancestors http://127.0.0.1:4317"])assert.ok(csp.includes(value),value);
    assert.ok(!csp.includes('allow-same-origin'));assert.equal(headers.get('x-dns-prefetch-control'),'off');assert.equal(headers.get('cache-control'),'no-store');
    f.advance();assert.equal((await get(url)).status,404);
  }finally{await f.close();}
});

test('preview validates entries and bounds; deleted and unsupported files cannot become assets',async()=>{
  const f=await fixture();try{
    f.set([file('site/index.html','OK'),file('server.ts','throw Error()'),{path:'deleted.html',mode:'100644',presence:'deleted'},file('.hidden.html','hidden')]);
    assert.deepEqual(f.host.catalog('workspace').entries,['site/index.html']);
    for(const entryPath of ['server.ts','../site/index.html','deleted.html','.hidden.html','/site/index.html'])assert.throws(()=>f.host.create('workspace',{entryPath,expectedSourceDigest:f.snapshot().sourceDigest}),/APP_PREVIEW_ENTRY/);
    f.set([file('site/index.html','a'.repeat(1024*1024+1))]);assert.throws(()=>f.create(),/APP_PREVIEW_LIMIT/);
    f.set([file('site/index.html','ok'),...Array.from({length:256},(_,i)=>file(`${i}.js`,'x'))]);assert.throws(()=>f.create(),/APP_PREVIEW_LIMIT/);
    f.set([file('site/index.html','ok'),...Array.from({length:3},(_,i)=>file(`${i}.js`,'x'.repeat(3*1024*1024)))]);assert.throws(()=>f.create(),/APP_PREVIEW_LIMIT/);
    f.set([file('site/index.html','ok')]);for(let i=0;i<4;i++)f.create('workspace'+i);
    assert.throws(()=>f.create('fifth'),/APP_PREVIEW_QUOTA/);f.advance();assert.doesNotThrow(()=>f.create('fifth'));
  }finally{await f.close();}
});
