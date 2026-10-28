import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {createHttpServer} from '../server/http.ts';
import {generalPlanningFixture} from './general-planning-fixture.ts';
import {outcome,tick} from './claude-task-fixture.ts';

/** Exercise real handlers/session/CSRF without claiming a socket integration test. */
async function fixture(){
  const f=generalPlanningFixture(),server=createHttpServer(f.controller,'.'),host='127.0.0.1:45678';
  server.address=()=>({address:'127.0.0.1',family:'IPv4',port:45678});
  let cookie='',csrf='';
  const request=(method:string,url:string,data?:object,headers:Record<string,string>={})=>new Promise<{status:number;body:any;headers:Record<string,string>}>((resolve,reject)=>{
    const req=Object.assign(Readable.from(data?[Buffer.from(JSON.stringify(data))]:[]),{method,url,headers:{host,origin:'http://'+host,cookie,'content-type':'application/json','x-csrf-token':csrf,...headers}});
    const result={status:0,body:null as any,headers:{} as Record<string,string>};
    const res={headersSent:false,setHeader:(key:string,value:string)=>{result.headers[key]=value;},writeHead:(status:number)=>{result.status=status;res.headersSent=true;},end:(body:string)=>{try{result.body=JSON.parse(body);resolve(result);}catch(error){reject(error);}}};
    server.emit('request',req,res);
  });
  const session=await request('GET','/api/session');cookie=session.headers['Set-Cookie'].split(';')[0];csrf=session.body.csrfToken;
  return {...f,request,base:`/api/projects/${f.project.id}`,close:async()=>{server.emit('close');await f.close();}};
}
test('in-process preferences routes expose exact defaults/CAS/errors and preserve CSRF and side-effect boundaries',async()=>{
  const f=await fixture();try{
    const path=f.base+'/ai-preferences',seq=f.store.lastSeq();
    assert.deepEqual((await f.request('GET',path)).body,{planning:'claude-code',execution:'claude-code',revision:0,updatedAt:null});
    assert.equal((await f.request('POST',path,{expectedRevision:0,planning:'codex',execution:'claude-code'})).body.error,'GIT_REQUIRED');
    const code=f.projects.createProject({requestId:randomUUID(),name:'Code',kind:'code'}).project,codePath=`/api/projects/${code.id}/ai-preferences`,seqAfterCreate=f.store.lastSeq();
    const body={expectedRevision:0,planning:'claude-code',execution:'codex'};
    assert.equal((await f.request('POST',codePath,body,{'x-csrf-token':''})).status,403);
    assert.equal((await f.request('GET',path,undefined,{cookie:''})).status,401);
    const changed=await f.request('POST',codePath,body);assert.equal(changed.status,200);assert.equal(changed.body.revision,1);
    const stale=await f.request('POST',codePath,body);assert.equal(stale.status,409);assert.equal(stale.body.error,'AI_PREFERENCES_STALE');
    assert.deepEqual((await f.request('POST',codePath,{...body,expectedRevision:1})).body,changed.body);
    assert.equal((await f.request('POST',codePath,{...body,expectedRevision:1,execution:'claude-code'})).body.error,'RUNTIME_NOT_SUPPORTED');
    assert.equal((await f.request('POST',path,{...body,planning:'unknown'})).status,400);
    assert.equal((await f.request('GET',path+'?x=1')).status,400);
    assert.equal((await f.request('POST',path+'?x=1',body)).status,400);
    assert.equal((await f.request('GET',`/api/projects/${randomUUID()}/ai-preferences`)).status,404);
    assert.equal(f.store.lastSeq(),seqAfterCreate);assert.ok(seqAfterCreate>=seq);assert.equal(f.runners.length,0);assert.deepEqual(f.store.runs(),[]);
  }finally{await f.close();}
});
test('in-process general planning routes allow null/omitted workspace, consent, save and interrupt/recovery',async()=>{
  const f=await fixture();try{
    const path=f.base+'/planning-suggestions';
    assert.equal((await f.request('GET',path)).body.workspaceId,null);
    assert.equal((await f.request('GET',path+'?workspaceId='+randomUUID())).body.error,'GIT_REQUIRED');
    assert.equal((await f.request('POST',path+'/preview',{text:f.text,workspaceId:randomUUID()})).body.error,'GIT_REQUIRED');
    assert.equal((await f.request('POST',path+'/preview',{text:f.text,extra:true})).status,400);
    const preview=await f.request('POST',path+'/preview',{text:f.text});assert.equal(preview.status,200);assert.equal(preview.body.runtime,'claude-code');
    const input={requestId:randomUUID(),workspaceId:null,text:f.text,expectedPreviewDigest:preview.body.previewDigest,confirmed:true};
    assert.equal((await f.request('POST',path+'/start',input,{'x-csrf-token':''})).status,403);
    assert.equal((await f.request('POST',path+'/start',{...input,confirmed:false})).body.error,'PLANNING_CONFIRMATION_REQUIRED');
    const started=await f.request('POST',path+'/start',input);assert.equal(started.status,200);
    assert.equal((await f.request('POST',path+'/start',input)).body.id,started.body.id);
    await f.complete();assert.deepEqual(f.studio.read(f.project.id,'plans'),[]);
    const complete=f.service.record(started.body.id),saved=await f.request('POST',path+'/'+complete.id+'/save',{expectedOutputDigest:complete.outputDigest});
    assert.equal(saved.status,200);assert.equal(saved.body.state,'draft');
    const next=await f.request('POST',path+'/start',{...input,requestId:randomUUID()});await tick();
    const interrupted=await f.request('POST',path+'/'+next.body.id+'/interrupt',{});assert.equal(interrupted.status,200);assert.equal(interrupted.body.execution,'running');
    f.runners[1].finish(outcome('interrupted',{exit:'not_observed'}));await f.service.settle();
    assert.equal((await f.request('GET',path)).body.recoveryRequired,true);
    assert.equal((await f.request('POST',path+'/recover',{suggestionId:next.body.id,confirmedStopped:false})).status,409);
    assert.equal((await f.request('POST',path+'/recover',{suggestionId:next.body.id,confirmedStopped:true})).status,200);
    assert.equal((await f.request('GET',path)).body.recoveryRequired,false);assert.equal(f.nativeCalls,0);
  }finally{await f.close();}
});
