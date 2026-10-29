import {Readable} from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHttpServer} from '../server/http.ts';
import {toolFixture} from './tool-fixture.ts';

for(const transport of ['listener','in-process'] as const)test(`tool HTTP ${transport}: session, Origin, CSRF, exact fields and read-only GET`,async()=>{
  const f=await toolFixture('mock'),server=createHttpServer(f.controller,'.');
  try{
    if(transport==='listener')await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    else server.address=()=>({address:'127.0.0.1',family:'IPv4',port:43210});
    const request=(url:string,init:RequestInit={}):Promise<Response>=>{
      if(transport==='listener')return fetch(url,init);
      return new Promise(resolve=>{
        const parsed=new URL(url),headers=Object.fromEntries(new Headers(init.headers));
        const req=Object.assign(Readable.from(init.body?[Buffer.from(String(init.body))]:[]),{method:init.method??'GET',url:parsed.pathname+parsed.search,headers:{host:parsed.host,...headers}});
        const output=new Headers();let status=200;
        const res={headersSent:false,setHeader:(name:string,value:string)=>output.set(name,value),
          writeHead:(value:number,values:Record<string,string>)=>{status=value;for(const [name,text] of Object.entries(values))output.set(name,text);res.headersSent=true;},
          end:(value:string)=>resolve(new Response(value,{status,headers:output}))};
        server.emit('request',req,res);
      });
    };
    const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
    const session=await request(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],csrf=(await session.json()).csrfToken;
    const post=(action:string,data:unknown,headers:Record<string,string>={})=>request(origin+'/api/tool-invocations/'+action,{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-csrf-token':csrf,...headers},body:JSON.stringify(data)});
    assert.equal((await post('preview',f.selection,{cookie:''})).status,401);
    assert.equal((await post('preview',f.selection,{origin:'https://foreign.invalid'})).status,403);
    assert.equal((await post('preview',f.selection,{'x-csrf-token':''})).status,403);
    for(const action of ['preview','approve','invoke']){
      const seq=f.store.lastSeq(),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
      await request(origin+'/api/tool-invocations/'+action,{headers:{cookie}});
      assert.equal(f.store.lastSeq(),seq);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
      assert.equal((await post(action,{...f.selection,command:'injected'})).status,400);
      assert.equal((await post(action+'?extra=1',{})).status,400);
    }
    for(const selection of [{...f.selection,runtimeId:'claude-code'},{...f.selection,runtimeId:'claude-code',kind:'skill'},{...f.selection,kind:'hook'}]){
      const response=await post('preview',selection);assert.equal(response.status,403);assert.equal((await response.json()).error,'TOOL_NOT_GRANTABLE');
    }
    const previewResponse=await post('preview',f.selection);assert.equal(previewResponse.status,200);const p=await previewResponse.json();
    const approve={requestId:randomUUID(),previewId:p.previewId,expectedDigest:p.digest,confirmed:true};
    assert.equal((await post('approve',{...approve,confirmed:false})).status,409);
    const approved=await post('approve',approve);assert.equal(approved.status,200);const a=await approved.json();
    const invoke={requestId:randomUUID(),previewId:a.previewId,expectedDigest:a.digest,confirmed:true};
    const wrong=await post('invoke',{...invoke,expectedDigest:'0'.repeat(64)});assert.equal(wrong.status,409);assert.equal((await wrong.json()).error,'ROUTE_CHANGED');
    const invoked=await post('invoke',invoke);assert.equal(invoked.status,200);const result=await invoked.json();assert.equal(result.evidenceSource,'mock');assert.equal(f.rpc.starts,1);
    assert.deepEqual(await (await post('invoke',invoke)).json(),result);assert.equal(f.rpc.starts,1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});
