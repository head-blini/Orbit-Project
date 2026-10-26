import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { createHttpProviderTransport,type HttpTransportConfig,type HttpChatEvent } from '../server/providers/http-transport.ts';

async function fixture(handler:http.RequestListener){
  const server=http.createServer(handler);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {endpoint:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})};
}
function config(endpoint:string,patch:Partial<HttpTransportConfig>={}):HttpTransportConfig {
  return {providerId:'local',endpoint,approved:true,locality:'loopback',credential:()=>undefined,requireCredential:false,
    models:['fixture-model'],authorize:request=>({allowed:true,...(request.operation==='chat'?{messages:request.messages}:{})}),...patch};
}
async function events(transport:ReturnType<typeof createHttpProviderTransport>,signal?:AbortSignal){
  const result:HttpChatEvent[]=[];for await(const event of transport.chat({model:'fixture-model',messages:[{role:'user',content:'original text'}]},{signal}))result.push(event);return result;
}

test('construction is inert and approved model discovery returns only the configured model intersection',async()=>{
  let calls=0;const f=await fixture((req,res)=>{calls++;assert.equal(req.method,'GET');assert.equal(req.url,'/v1/models');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model'},{id:'not-approved'}]}));});
  try{const transport=createHttpProviderTransport(config(f.endpoint));assert.equal(calls,0);assert.deepEqual(await transport.listModels(),['fixture-model']);assert.equal(calls,1);}finally{await f.close();}
});

test('chat sends only the authorized message snapshot and parses fragmented SSE into cumulative text and provider usage',async()=>{
  const requests:unknown[]=[];const f=await fixture(async(req,res)=>{
    assert.equal(req.url,'/v1/chat/completions');assert.equal(req.method,'POST');
    let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const part of ['da','ta: {"choices":[{"index":0,"delta":{"content":"안녕 "}}]}\r','\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"세계"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DO','NE]\n\n'])res.write(part);
    res.end();
  });
  try{const result=await events(createHttpProviderTransport(config(f.endpoint,{authorize:()=>({allowed:true,messages:[{role:'user',content:'sanitized text'}]})})));
    assert.deepEqual(requests,[{model:'fixture-model',messages:[{role:'user',content:'sanitized text'}],stream:true,stream_options:{include_usage:true},max_tokens:1024}]);
    assert.equal(result.filter(event=>event.type==='text').at(-1)?.text,'안녕 세계');
    assert.deepEqual(result.at(-1),{type:'done',usage:{promptTokens:3,completionTokens:2,totalTokens:5,source:'provider'}});
  }finally{await f.close();}
});

test('every existing provider kind serializes the server output-token cap captured before caller mutation',async()=>{
  const requests:{max_tokens:number}[]=[];
  const f=await fixture(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"index":0,"delta":{"content":"safe output"}}]}\n\ndata: [DONE]\n\n');});
  const cases=[['openai-compatible',1],['litellm',8192],['vllm',17],['freellmapi',1024],['local',2048]] as const;
  try{
    for(const [providerId,cap] of cases){
      const setup=config(f.endpoint,{providerId,maxOutputTokens:cap});
      const transport=createHttpProviderTransport(setup);setup.maxOutputTokens=cap===1?8192:1;
      assert.equal((await events(transport)).at(-1)?.type,'done');
    }
    assert.deepEqual(requests.map(request=>request.max_tokens),cases.map(([,cap])=>cap));
  }finally{await f.close();}
});

test('invalid output-token caps fail before authorization, credentials or any local request',async()=>{
  let calls=0,authorized=0,credentials=0;
  const f=await fixture((_req,res)=>{calls++;res.end();});
  try{
    for(const maxOutputTokens of [null,0,-1,8193,1.5,NaN,Infinity,'1024',true]){
      assert.throws(()=>createHttpProviderTransport(config(f.endpoint,{maxOutputTokens,authorize:()=>{authorized++;return {allowed:false};},credential:()=>{credentials++;return 'synthetic';}} as never)),/^Error: INVALID_PROVIDER_CONFIGURATION$/);
    }
    const setup=config(f.endpoint);Object.defineProperty(setup,'maxOutputTokens',{enumerable:true,get(){throw new Error('SYNTHETIC_PRIVATE_DETAILS');}});
    assert.throws(()=>createHttpProviderTransport(setup),/^Error: INVALID_PROVIDER_CONFIGURATION$/);
    assert.equal(calls,0);assert.equal(authorized,0);assert.equal(credentials,0);
  }finally{await f.close();}
});

test('reported completion tokens exceeding the requested cap reject without a done event or raw response details',async()=>{
  for(const includeLaterUnderLimit of [false,true]){
    let requestedCap:number|undefined;
    const f=await fixture(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk;requestedCap=JSON.parse(body).max_tokens;
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write('data: {"choices":[{"index":0,"delta":{"content":"safe output "}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"completion_tokens":3},"privateDetails":"SYNTHETIC_PRIVATE_DETAILS"}\n\n');
      if(includeLaterUnderLimit)res.write('data: {"choices":[],"usage":{"completion_tokens":1}}\n\n');
      res.end('data: [DONE]\n\n');
    });
    const received:HttpChatEvent[]=[];
    try{
      const transport=createHttpProviderTransport(config(f.endpoint,{maxOutputTokens:2}));
      await assert.rejects(async()=>{for await(const event of transport.chat({model:'fixture-model',messages:[{role:'user',content:'safe input'}]}))received.push(event);},/^Error: PROVIDER_OUTPUT_LIMIT$/);
      assert.equal(requestedCap,2);assert.equal(received.some(event=>event.type==='done'),false);assert.equal(JSON.stringify(received).includes('SYNTHETIC_PRIVATE_DETAILS'),false);
    }finally{await f.close();}
  }
});

test('completion tokens at the cap and absent completion usage never turn prompt or total tokens into an output estimate',async()=>{
  for(const completionTokens of [1,null]){
    const f=await fixture((_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"index":0,"delta":{"content":"safe"}}]}\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:8999,completion_tokens:completionTokens,total_tokens:9000}})+'\n\ndata: [DONE]\n\n');});
    try{const result=await events(createHttpProviderTransport(config(f.endpoint,{maxOutputTokens:1})));
      assert.deepEqual(result.at(-1),{type:'done',usage:{promptTokens:8999,completionTokens:completionTokens,totalTokens:9000,source:'provider'}});
    }finally{await f.close();}
  }
});

test('unapproved configurations and missing or denying authorization never contact the server or read credentials',async()=>{
  let calls=0,credentials=0;const f=await fixture((_req,res)=>{calls++;res.end();});
  try{
    for(const patch of [{approved:false},{authorize:()=>({allowed:false as const})},{authorize:undefined as unknown as HttpTransportConfig['authorize']}]){
      await assert.rejects(async()=>{const transport=createHttpProviderTransport(config(f.endpoint,{credential:()=>{credentials++;return 'synthetic';},...patch}));await transport.listModels();},/^Error: (PROVIDER_NOT_APPROVED|PROVIDER_OUTBOUND_DENIED|INVALID_PROVIDER_CONFIGURATION)$/);
    }
    await assert.rejects(events(createHttpProviderTransport(config(f.endpoint,{authorize:()=>({allowed:true})}))),/^Error: PROVIDER_OUTBOUND_DENIED$/);
    assert.equal(calls,0);assert.equal(credentials,0);
  }finally{await f.close();}
});

test('unsafe endpoint spellings, mismatched locality and unsupported providers are rejected without DNS or traffic',()=>{
  for(const endpoint of ['http://user:synthetic@127.0.0.1/v1','http://127.0.0.1/v1?key=synthetic','http://127.0.0.1/v1#fragment','http://127.1/v1',
    'http://2130706433/v1','http://0x7f000001/v1','http://localhost/v1','http://127.0.0.1/%2e%2e/v1','http://127.0.0.1/a/../v1',
    'http://127.0.0.1:0/v1','http://127.0.0.1\\@other.test/v1','file:///v1',' https://models.example.test/v1']){
    assert.throws(()=>createHttpProviderTransport(config(endpoint)),/^Error: INVALID_PROVIDER_CONFIGURATION$/);
  }
  for(const endpoint of ['http://models.example.test/v1','https://127.0.0.1/v1','https://[::1]/v1','https://[::ffff:127.0.0.1]/v1','https://models.local/v1'])
    assert.throws(()=>createHttpProviderTransport(config(endpoint,{providerId:'openai-compatible',locality:'external',requireCredential:true})),/^Error: INVALID_PROVIDER_CONFIGURATION$/);
  assert.throws(()=>createHttpProviderTransport(config('http://127.0.0.1/v1',{providerId:'bedrock' as never})),/^Error: INVALID_PROVIDER_CONFIGURATION$/);
});

test('model allowlists and request shapes prevent model or destination overrides before authorization',async()=>{
  let authorized=0;const transport=createHttpProviderTransport(config('http://127.0.0.1:1/v1',{authorize:()=>{authorized++;return {allowed:false};}}));
  for(const input of [{model:'foreign-model',messages:[{role:'user',content:'text'}]},
    {model:'fixture-model',messages:[{role:'tool',content:'text'}]},
    {model:'fixture-model',messages:[{role:'user',content:'x'.repeat(256*1024)}]},
    {model:'fixture-model',messages:[{role:'user',content:'text'}],endpoint:'https://other.test'},
    {model:'fixture-model',messages:[{role:'user',content:'text'}],max_tokens:8192},
    {model:'fixture-model',messages:[{role:'user',content:'text'}],maxOutputTokens:8192}])
    await assert.rejects(async()=>{for await(const _event of transport.chat(input as never)){}},/^Error: INVALID_PROVIDER_REQUEST$/);
  assert.equal(authorized,0);
});

test('configuration, input and authorization results are copied before asynchronous work',async()=>{
  let received:unknown;const f=await fixture(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received=JSON.parse(body);res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: [DONE]\n\n');});
  try{
    const authorized=[{role:'user' as const,content:'approved snapshot'}];
    const setup=config(f.endpoint,{authorize:request=>{assert.ok(Object.isFrozen(request));assert.ok(Object.isFrozen(request.messages));
      queueMicrotask(()=>{authorized[0].content='changed later';});return {allowed:true,messages:authorized};}});
    const transport=createHttpProviderTransport(setup);setup.endpoint='http://127.0.0.1:1/v1';setup.approved=false;setup.models=['different'];
    await events(transport);assert.equal((received as {messages:{content:string}[]}).messages[0].content,'approved snapshot');
  }finally{await f.close();}
});

test('redirects and provider errors produce fixed diagnostics and never forward credentials to a second host',async()=>{
  for(const status of [302,401,429,500]){
    let calls=0;const f=await fixture((_req,res)=>{calls++;res.writeHead(status,{'Content-Type':'application/json',Location:'http://127.0.0.1:1/leak'});res.end('{"error":"Bearer synthetic-server-error"}');});
    try{await assert.rejects(createHttpProviderTransport(config(f.endpoint,{credential:()=> 'synthetic-auth'})).listModels(),/^Error: (PROVIDER_REDIRECT_REJECTED|PROVIDER_AUTH_REQUIRED|PROVIDER_RATE_LIMITED|PROVIDER_HTTP_ERROR)$/);assert.equal(calls,1);}finally{await f.close();}
  }
});

test('authorization denial, exception, indefinite wait and prior abort are bounded without opening a connection',async()=>{
  let calls=0;const f=await fixture((_req,res)=>{calls++;res.end();});
  try{
    const aborted=new AbortController();aborted.abort(new Error('synthetic-sensitive-reason'));
    await assert.rejects(createHttpProviderTransport(config(f.endpoint)).listModels({signal:aborted.signal}),/^Error: PROVIDER_ABORTED$/);
    await assert.rejects(createHttpProviderTransport(config(f.endpoint,{authorize:()=>{throw new Error('Bearer synthetic-private-error');}})).listModels(),/^Error: PROVIDER_OUTBOUND_DENIED$/);
    await assert.rejects(createHttpProviderTransport(config(f.endpoint,{timeoutMs:25,authorize:()=>new Promise(()=>{})})).listModels(),/^Error: PROVIDER_TIMEOUT$/);
    const cancel=new AbortController();const pending=createHttpProviderTransport(config(f.endpoint,{authorize:()=>new Promise(()=>{})})).listModels({signal:cancel.signal});cancel.abort();await assert.rejects(pending,/^Error: PROVIDER_ABORTED$/);
    assert.equal(calls,0);
  }finally{await f.close();}
});

test('response header wait, stalled stream and caller cancellation close their own bounded request',async()=>{
  for(const mode of ['headers','stream','abort']){
    const f=await fixture((_req,res)=>{if(mode!=='headers'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': waiting\n\n');}});
    try{const cancel=new AbortController();const pending=mode==='headers'?createHttpProviderTransport(config(f.endpoint,{timeoutMs:25})).listModels():events(createHttpProviderTransport(config(f.endpoint,{timeoutMs:mode==='abort'?1000:25})),cancel.signal);
      if(mode==='abort')setTimeout(()=>cancel.abort(),25);await assert.rejects(pending,mode==='abort'?/^Error: PROVIDER_ABORTED$/:/^Error: PROVIDER_TIMEOUT$/);
    }finally{await f.close();}
  }
});

test('malformed, oversized, compressed and non-JSON model responses never expose their bodies',async()=>{
  for(const sample of [
    {body:'{"data":[{"id":"fixture-model"}]}'.repeat(20),headers:{'Content-Type':'application/json'},limit:128,code:'PROVIDER_RESPONSE_TOO_LARGE'},
    {body:'Bearer synthetic private error',headers:{'Content-Type':'application/json'},code:'PROVIDER_INVALID_RESPONSE'},
    {body:'{"data":[{}]}',headers:{'Content-Type':'application/json'},code:'PROVIDER_INVALID_RESPONSE'},
    {body:'{"data":[]}',headers:{'Content-Type':'text/html'},code:'PROVIDER_INVALID_RESPONSE'},
    {body:'{"data":[]}',headers:{'Content-Type':'application/json','Content-Encoding':'gzip'},code:'PROVIDER_INVALID_RESPONSE'},
  ]){
    const f=await fixture((_req,res)=>{res.writeHead(200,sample.headers);res.end(sample.body);});
    try{await assert.rejects(createHttpProviderTransport(config(f.endpoint,{maxResponseBytes:sample.limit??1024})).listModels(),new RegExp(`^Error: ${sample.code}$`));}finally{await f.close();}
  }
});

test('SSE requires valid JSON and DONE, rejects error or tool chunks, and keeps absent usage unknown',async()=>{
  for(const [body,code] of [
    ['data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n','PROVIDER_STREAM_INCOMPLETE'],
    ['data: broken-secret-body\n\ndata: [DONE]\n\n','PROVIDER_INVALID_RESPONSE'],
    ['data: {"error":{"message":"Bearer synthetic"}}\n\n','PROVIDER_HTTP_ERROR'],
    ['data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"x"}]}}]}\n\ndata: [DONE]\n\n','PROVIDER_INVALID_RESPONSE'],
    ['data: {"choices":[{"index":0,"delta":{"content":"ordinary"}}]}\n\ndata: [DONE]\n\n',null],
  ] as const){
    const f=await fixture((_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(body);});
    try{const pending=events(createHttpProviderTransport(config(f.endpoint)));if(code)await assert.rejects(pending,new RegExp(`^Error: ${code}$`));
      else assert.deepEqual((await pending).at(-1),{type:'done',usage:{promptTokens:null,completionTokens:null,totalTokens:null,source:'unknown'}});
    }finally{await f.close();}
  }
});

test('stream snapshots hide split output credentials and a provider echo of the request Authorization credential',async()=>{
  const f=await fixture((req,res)=>{assert.equal(req.headers.authorization,'Bearer synthetic-authorization-fixture');res.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const content of ['Hello api_','key=synthetic-','output-secret; ','synthetic-author','ization-fixture ','safe'])res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content}}]})+'\n\n');res.end('data: [DONE]\n\n');});
  try{const result=await events(createHttpProviderTransport(config(f.endpoint,{credential:()=> 'synthetic-authorization-fixture'})));
    for(const event of result)if(event.type==='text'){assert.equal(event.text.includes('synthetic-output-secret'),false);assert.equal(event.text.includes('synthetic-authorization-fixture'),false);}
    assert.equal(result.filter(event=>event.type==='text').at(-1)?.text,'Hello [REDACTED]; [REDACTED] safe');
  }finally{await f.close();}
});

test('credential failures and missing required credentials never leak values in errors or send a request',async()=>{
  let calls=0;const f=await fixture((_req,res)=>{calls++;res.end();});
  try{for(const credential of [()=>undefined,()=>{throw new Error('synthetic-credential-error');},()=> 'bad\r\nInjected: synthetic']){
    await assert.rejects(createHttpProviderTransport(config(f.endpoint,{requireCredential:true,credential})).listModels(),/^Error: PROVIDER_CREDENTIAL_REQUIRED$/);
  }assert.equal(calls,0);}finally{await f.close();}
});

test('external resolution rejects private, special, mapped, IPv6 and mixed DNS results before connection',async t=>{
  const lookup=t.mock.method(dns,'lookup',async()=>[] as never);
  for(const addresses of [['127.0.0.1'],['10.2.3.4'],['169.254.169.254'],['172.16.1.1'],['192.168.1.1'],['100.64.1.1'],['0.0.0.0'],['224.0.0.1'],['255.255.255.255'],['::ffff:127.0.0.1'],['2606:4700:4700::1111'],['1.1.1.1','192.168.0.1']]){
    lookup.mock.mockImplementation(async()=>addresses.map(address=>({address,family:address.includes(':')?6:4})) as never);
    const transport=createHttpProviderTransport(config('https://models.example.test/v1',{providerId:'openai-compatible',locality:'external',requireCredential:true,credential:()=> 'synthetic'}));
    await assert.rejects(transport.listModels(),/^Error: PROVIDER_DESTINATION_REJECTED$/);
  }
});

test('verified external IPv4 is pinned to its hostname with strict TLS and no proxy or global agent reuse',async t=>{
  let lookups=0;const addresses:string[]=[];
  t.mock.method(dns,'lookup',async()=>{lookups++;return [{address:'1.1.1.1',family:4}] as never;});
  t.mock.method(https,'request',((options:http.RequestOptions,callback:(response:http.IncomingMessage)=>void)=>{
    assert.equal(options.hostname,'models.example.test');assert.equal((options as https.RequestOptions).servername,'models.example.test');
    assert.equal((options as https.RequestOptions).rejectUnauthorized,true);assert.equal(options.agent,false);assert.equal((options as http.RequestOptions&{autoSelectFamily:boolean}).autoSelectFamily,false);
    const lookup=options.lookup as unknown as (host:string,options:object,callback:(error:null,address:string,family:number)=>void)=>void;
    for(let i=0;i<2;i++)lookup('models.example.test',{},(_error,address,family)=>{assert.equal(family,4);addresses.push(address);});
    const request=new EventEmitter() as EventEmitter&{end:()=>void;destroy:()=>void};request.destroy=()=>{};
    request.end=()=>{const response=Readable.from(['{"data":[{"id":"fixture-model"}]}']) as http.IncomingMessage;response.statusCode=200;response.headers={'content-type':'application/json'};queueMicrotask(()=>callback(response));};return request;
  }) as typeof https.request);
  const transport=createHttpProviderTransport(config('https://models.example.test/v1',{providerId:'openai-compatible',locality:'external',requireCredential:true,credential:()=> 'synthetic'}));
  assert.deepEqual(await transport.listModels(),['fixture-model']);assert.equal(lookups,1);assert.deepEqual(addresses,['1.1.1.1','1.1.1.1']);
});

test('invalid optional limits and untyped configuration values fail closed',()=>{
  for(const patch of [{timeoutMs:null},{maxResponseBytes:null},{timeoutMs:0},{timeoutMs:120001},{maxResponseBytes:0},{models:[]},{requireCredential:undefined}])
    assert.throws(()=>createHttpProviderTransport(config('http://127.0.0.1:1/v1',patch as never)),/^Error: INVALID_PROVIDER_CONFIGURATION$/);
});

test('SSE bytes may split inside a Unicode character and missing or malformed usage is never fabricated',async()=>{
  const f=await fixture((_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});
    const body=Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"한글"}}]}\n\ndata: [DONE]\n\n');
    const split=body.indexOf(Buffer.from('한'))+1;res.write(body.subarray(0,split));res.end(body.subarray(split));});
  try{const result=await events(createHttpProviderTransport(config(f.endpoint)));assert.equal(result.filter(event=>event.type==='text').at(-1)?.text,'한글');assert.deepEqual(result.at(-1),{type:'done',usage:{promptTokens:null,completionTokens:null,totalTokens:null,source:'unknown'}});}finally{await f.close();}
  const invalid=await fixture((_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[],"usage":{"total_tokens":-1}}\n\ndata: [DONE]\n\n');});
  try{await assert.rejects(events(createHttpProviderTransport(config(invalid.endpoint))),/^Error: PROVIDER_INVALID_RESPONSE$/);}finally{await invalid.close();}
});

test('DNS resolution and streaming response growth remain inside the operation deadline and byte cap',async t=>{
  t.mock.method(dns,'lookup',()=>new Promise(()=>{}));
  const external=createHttpProviderTransport(config('https://models.example.test/v1',{providerId:'openai-compatible',locality:'external',timeoutMs:25}));
  await assert.rejects(external.listModels(),/^Error: PROVIDER_TIMEOUT$/);
  const f=await fixture((_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'x'.repeat(300)}}]})+'\n\ndata: [DONE]\n\n');});
  try{await assert.rejects(events(createHttpProviderTransport(config(f.endpoint,{maxResponseBytes:128}))),/^Error: PROVIDER_RESPONSE_TOO_LARGE$/);}finally{await f.close();}
});

for(const mode of ['abort','deadline'] as const)test(`done is rejected after ${mode} while the consumer holds the final text snapshot`,async()=>{
  const f=await fixture((_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"index":0,"delta":{"content":"final-token"}}]}\n\ndata: [DONE]\n\n');});
  const cancel=new AbortController();
  const iterator=createHttpProviderTransport(config(f.endpoint,{timeoutMs:mode==='deadline'?500:30000})).chat({model:'fixture-model',messages:[{role:'user',content:'ordinary text'}]},{signal:cancel.signal});
  try{
    let final=false;
    while(!final){const event=await iterator.next();assert.equal(event.done,false,'final text must arrive before completion');final=event.value?.type==='text'&&event.value.text==='final-token';}
    if(mode==='abort')cancel.abort(new Error('synthetic-private-cancellation-reason'));
    else await new Promise(resolve=>setTimeout(resolve,550));
    await assert.rejects(iterator.next(),mode==='abort'?/^Error: PROVIDER_ABORTED$/:/^Error: PROVIDER_TIMEOUT$/);
  }finally{await iterator.return(undefined);await f.close();}
});
