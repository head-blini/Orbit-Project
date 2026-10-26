import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from './temp.ts';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { createHttpServer } from '../server/http.ts';
import type { Controller } from '../server/controller.ts';
import {c4Samples} from '../web/visualization/c4-samples.ts';

const input={format:'markdown',source:'manual',text:'# Product\n## Goal\nShip safely\n## Requirements\n### REQ-1\nSave a plan\n#### Acceptance criteria\n- Reload preserves it\n## Constraints\n- No execution\n## Open questions\n'};
const artifact={kind:'mermaid',source:'flowchart TD\na["Browser"]\nb["Server"]\na --> b',metadata:{title:'Architecture'}};
async function fixture(path=':memory:'){
  const store=new Store(path);
  if(!store.projects().length)for(const id of ['project-a','project-b'])store.saveProject({id,name:id,path:'never-accessed',createdAt:new Date().toISOString(),writeEnabled:false});
  const controller={store,snapshot:()=>({provider:'disconnected',runs:store.runs(),lastSeq:store.lastSeq()})} as unknown as Controller;
  const server=createHttpServer(controller,'.');await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const session=await fetch(origin+'/api/session');const cookie=session.headers.get('set-cookie')!.split(';')[0];
  const {csrfToken}=await session.json() as {csrfToken:string};
  const headers={cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  const get=(url:string)=>fetch(origin+url,{headers:{cookie}});
  const post=(url:string,data:object)=>fetch(origin+url,{method:'POST',headers,body:JSON.stringify(data)});
  return {store,origin,headers,get,post,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();}};
}
const plans='/api/projects/project-a/plans',artifacts='/api/projects/project-a/artifacts';

const classSource='classDiagram\nclass Project["프로젝트"] {\n+id: String\n+save(): bool\n}\nclass Task {\n+title: String\n+run(): Result\n}\nclass Repository {\n<<interface>>\n+load(id: String): Project\n}\nclass LocalRepository\nProject "1" *-- "0..999" Task : 작업 보존\nLocalRepository ..|> Repository : 구현\nTask ..> Repository : 조회\n';

test('class diagrams retain exact source and immutable editable exports through project isolation and restart',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'orbit-uml-class-')),'test.sqlite');let f=await fixture(path);
  try{
    const response=await f.post(artifacts,{requestId:randomUUID(),input:{kind:'mermaid',source:classSource,metadata:{title:'Classes'}}});assert.equal(response.status,200);
    const first=await response.json() as any;assert.equal(first.source,classSource);assert.equal(first.kind,'mermaid');
    const url=`${artifacts}/${first.id}/export?revision=1&hash=${first.contentHash}&format=pptx`;
    const exported=await f.get(url);assert.equal(exported.status,200);const bytes=Buffer.from(await exported.arrayBuffer());
    assert.equal(bytes.subarray(0,4).toString('hex'),'504b0304');assert.match(bytes.toString(),/<a:prstGeom prst="diamond"/);assert.match(bytes.toString(),/0\.\.999/);
    assert.match(bytes.toString(),/load/);assert.match(bytes.toString(),/<p:cxnSp>/);assert.doesNotMatch(bytes.toString(),/<p:pic|TargetMode="External"/);
    assert.ok((await (await f.get(url.replace('format=pptx','format=markdown'))).text()).includes('```mermaid\n'+classSource+'\n```'));
    assert.equal((await f.get(url.replace('project-a','project-b'))).status,404);assert.equal((await f.get(url.replace(first.contentHash,'0'.repeat(64)))).status,409);
    const revisedSource=classSource.replace('+title: String','+name: String');
    const revised=await f.post(`${artifacts}/${first.id}/revisions`,{requestId:randomUUID(),expectedRevision:1,input:{kind:'mermaid',source:revisedSource,metadata:{title:'Classes revised'}}});assert.equal(revised.status,200);
    await f.close();f=await fixture(path);assert.deepEqual(Buffer.from(await (await f.get(url)).arrayBuffer()),bytes);
    assert.deepEqual((await (await f.get(`${artifacts}/${first.id}/history`)).json() as any[]).map(r=>r.source),[classSource,revisedSource]);assert.equal(f.store.runs().length,0);
    f.store.db.prepare('UPDATE artifacts SET body=? WHERE project_id=? AND id=? AND revision=1').run(JSON.stringify({...first,source:classSource.replace('save','changed')}),'project-a',first.id);
    for(const format of ['pptx','markdown']){const corrupt=await f.get(url.replace('format=pptx',`format=${format}`));assert.equal(corrupt.status,409);assert.deepEqual(await corrupt.json(),{error:'ARTIFACT_INTEGRITY'});}
  }finally{await f.close();}
});

test('class unsupported syntax and geometry overflow leave history and audit untouched',async()=>{
  const f=await fixture();try{
    const response=await f.post(artifacts,{requestId:randomUUID(),input:{kind:'mermaid',source:classSource,metadata:{}}});assert.equal(response.status,200);
    const first=await response.json() as any,before=f.store.lastSeq();
    for(const source of [classSource+'Task --> Task',classSource+'Task --> Missing',classSource+'click Task href "https://example.invalid"',classSource.replace('+id: String','+<script>bad</script>')]){
      assert.equal((await f.post(artifacts,{requestId:randomUUID(),input:{kind:'mermaid',source,metadata:{}}})).status,400);
    }
    const limited=['classDiagram',...Array.from({length:5},(_,i)=>[`class C${i} {`,...Array.from({length:16},(_,j)=>`+field${j}: ${'설'.repeat(140)}`),'}']).flat()].join('\n');
    const input={kind:'mermaid',source:limited,metadata:{}};
    for(const [url,body] of [[artifacts,{requestId:randomUUID(),input}],[`${artifacts}/${first.id}/revisions`,{requestId:randomUUID(),expectedRevision:1,input}]] as const){
      const rejected=await f.post(url,body);assert.equal(rejected.status,422);assert.deepEqual(await rejected.json(),{error:'CLASS_LAYOUT_LIMIT'});
    }
    assert.equal(f.store.lastSeq(),before);assert.deepEqual(await (await f.get(`${artifacts}/${first.id}/history`)).json(),[first]);assert.deepEqual(await (await f.get(artifacts)).json(),[first]);
  }finally{await f.close();}
});

test('C4 Artifact preserves exact source, project ownership and editable historical exports through restart',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'orbit-c4-')),'test.sqlite');let f=await fixture(path);
  const source=JSON.stringify(c4Samples.container,null,2)+'\n';
  try{
    const response=await f.post(artifacts,{requestId:randomUUID(),input:{kind:'c4',source,metadata:{title:'C4'}}});assert.equal(response.status,200);
    const first=await response.json() as any;assert.equal(first.source,source);assert.equal(first.kind,'c4');
    const url=`${artifacts}/${first.id}/export?revision=1&hash=${first.contentHash}&format=pptx`;
    const exported=await f.get(url);assert.equal(exported.status,200);const bytes=Buffer.from(await exported.arrayBuffer());
    assert.equal(bytes.subarray(0,4).toString('hex'),'504b0304');assert.match(bytes.toString(),/로컬 서버/);assert.match(bytes.toString(),/<p:cxnSp>/);assert.doesNotMatch(bytes.toString(),/<p:pic|TargetMode="External"/);
    assert.ok((await (await f.get(url.replace('format=pptx','format=markdown'))).text()).includes('```json\n'+source+'\n```'));
    assert.equal((await f.get(url.replace('project-a','project-b'))).status,404);
    assert.equal((await f.get(url.replace(first.contentHash,'0'.repeat(64)))).status,409);
    const revisedSource=source.replace('프로젝트 요청','승인된 프로젝트 요청');
    const revised=await f.post(`${artifacts}/${first.id}/revisions`,{requestId:randomUUID(),expectedRevision:1,input:{kind:'c4',source:revisedSource,metadata:{title:'C4 revised'}}});assert.equal(revised.status,200);
    const changedKind=await f.post(`${artifacts}/${first.id}/revisions`,{requestId:randomUUID(),expectedRevision:2,input:artifact});assert.equal(changedKind.status,400);
    await f.close();f=await fixture(path);
    assert.deepEqual(Buffer.from(await (await f.get(url)).arrayBuffer()),bytes);
    const history=await (await f.get(`${artifacts}/${first.id}/history`)).json() as any[];assert.deepEqual(history.map(r=>r.source),[source,revisedSource]);
    assert.equal(f.store.runs().length,0);
    f.store.db.prepare('UPDATE artifacts SET body=? WHERE project_id=? AND id=? AND revision=1').run(JSON.stringify({...first,source:source.replace('로컬 서버','변조된 서버')}),'project-a',first.id);
    const corrupt=await f.get(url);assert.equal(corrupt.status,409);assert.deepEqual(await corrupt.json(),{error:'ARTIFACT_INTEGRITY'});
  }finally{await f.close();}
});

test('C4 invalid boundaries, self relationships and unsafe text cannot create an artifact or event',async()=>{
  const f=await fixture();try{
    const edits:((d:any)=>void)[]=[d=>d.relationships[0].to='orbit',d=>d.elements[2].parentId='codex',
      d=>d.relationships[0].to='user',d=>d.elements[2].name='<script>',d=>d.view='deployment',d=>d.extra=true];
    const seq=f.store.lastSeq();
    for(const edit of edits){const diagram=structuredClone(c4Samples.container);edit(diagram);
      assert.equal((await f.post(artifacts,{requestId:randomUUID(),input:{kind:'c4',source:JSON.stringify(diagram),metadata:{}}})).status,400);
    }
    assert.equal(f.store.lastSeq(),seq);assert.deepEqual(await (await f.get(artifacts)).json(),[]);assert.equal(f.store.runs().length,0);
  }finally{await f.close();}
});

test('C4 layout overflow leaves existing revisions and audit sequence untouched',async()=>{
  const f=await fixture();try{
    const created=await f.post(artifacts,{requestId:randomUUID(),input:{kind:'c4',source:JSON.stringify(c4Samples.context),metadata:{}}});assert.equal(created.status,200);
    const saved=await created.json() as any;
    const source=JSON.stringify({format:'c4-v1',title:'한'.repeat(80),view:'context',scope:'s0',
      elements:Array.from({length:12},(_,i)=>({id:`s${i}`,kind:'system',name:'한'.repeat(80),description:'설'.repeat(160),parentId:null,technology:null})),
      relationships:Array.from({length:24},(_,i)=>({id:`r${i}`,from:`s${i%12}`,to:`s${(i+1+Math.floor(i/12))%12}`,description:'관'.repeat(160),technology:'기'.repeat(80)}))});
    const seq=f.store.lastSeq(),input={kind:'c4',source,metadata:{}};
    for(const [url,body] of [[artifacts,{requestId:randomUUID(),input}],[`${artifacts}/${saved.id}/revisions`,{requestId:randomUUID(),expectedRevision:1,input}]] as const){
      const response=await f.post(url,body);assert.equal(response.status,422);assert.deepEqual(await response.json(),{error:'C4_LAYOUT_LIMIT'});
    }
    assert.equal(f.store.lastSeq(),seq);assert.deepEqual(await (await f.get(`${artifacts}/${saved.id}/history`)).json(),[saved]);assert.deepEqual(await (await f.get(artifacts)).json(),[saved]);
  }finally{await f.close();}
});

test('saved Artifact exports real PPTX and exact Markdown with immutable revision and ownership gates',async()=>{
  const f=await fixture();try{
    const first=await (await f.post(artifacts,{requestId:randomUUID(),input:artifact})).json() as any;
    const path=`${artifacts}/${first.id}/export?revision=1&hash=${first.contentHash}&format=pptx`;
    const pptx=await f.get(path);assert.equal(pptx.status,200);
    assert.equal(pptx.headers.get('content-type'),'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.match(pptx.headers.get('content-disposition')!,/^attachment; filename="orbit-[a-f0-9-]+-v1.pptx"$/);
    const bytes=Buffer.from(await pptx.arrayBuffer());assert.equal(bytes.subarray(0,4).toString('hex'),'504b0304');assert.ok(bytes.length>3000);
    const markdown=await f.get(path.replace('format=pptx','format=markdown'));assert.equal(markdown.status,200);assert.match(await markdown.text(),/flowchart TD/);
    assert.equal((await fetch(f.origin+path)).status,401);
    assert.equal((await f.get(path.replace('project-a','project-b'))).status,404);
    assert.equal((await f.get(path.replace(first.contentHash,'0'.repeat(64)))).status,409);
    assert.equal((await f.get(path+'&path=C:/private')).status,400);
    await f.post(`${artifacts}/${first.id}/revisions`,{requestId:randomUUID(),expectedRevision:1,input:{...artifact,source:artifact.source.replace('Browser','Client')}});
    assert.deepEqual(Buffer.from(await (await f.get(path)).arrayBuffer()),bytes,'export remains bound to the explicitly selected stored revision');
    assert.equal(f.store.runs().length,0);
  }finally{await f.close();}
});

test('sequence Artifact persists exact revisions and exports paginated editable slides after restart',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'orbit-sequence-')),'test.sqlite');let f=await fixture(path);
  const source='sequenceDiagram\nactor User as 사용자\nparticipant API as 서비스\nautonumber\nloop 반복\n'+Array.from({length:28},(_,i)=>`User->>API: 요청 ${i+1}\nAPI-->>User: 응답 ${i+1}`).join('\n')+'\nend\n';
  try{
    const response=await f.post(artifacts,{requestId:randomUUID(),input:{kind:'mermaid',source,metadata:{title:'Sequence'}}});assert.equal(response.status,200);
    const first=await response.json() as any;
    const url=`${artifacts}/${first.id}/export?revision=1&hash=${first.contentHash}&format=pptx`;
    const exported=await f.get(url);assert.equal(exported.status,200);const bytes=Buffer.from(await exported.arrayBuffer());
    assert.equal(bytes.subarray(0,4).toString('hex'),'504b0304');assert.ok(bytes.includes(Buffer.from('ppt/slides/slide2.xml')));
    assert.ok(bytes.includes(Buffer.from('<p:cxnSp>')));assert.ok(bytes.includes(Buffer.from('<a:prstDash val="dash"')));assert.ok(!bytes.includes(Buffer.from('<p:pic')));
    const markdown=await (await f.get(url.replace('format=pptx','format=markdown'))).text();assert.ok(markdown.includes('```mermaid\n'+source+'\n```'));
    assert.equal((await f.get(url.replace('project-a','project-b'))).status,404);
    const revised=await f.post(`${artifacts}/${first.id}/revisions`,{requestId:randomUUID(),expectedRevision:1,input:{kind:'mermaid',source:source.replace('요청 1','수정 1'),metadata:{title:'Sequence revised'}}});assert.equal(revised.status,200);
    await f.close();f=await fixture(path);
    assert.deepEqual(Buffer.from(await (await f.get(url)).arrayBuffer()),bytes);
    const history=await (await f.get(`${artifacts}/${first.id}/history`)).json() as any[];assert.equal(history.length,2);assert.equal(history[0].source,source);
    const limited=['sequenceDiagram',...Array.from({length:10},(_,i)=>`actor P${i} as ${'參'.repeat(160)}`),...Array.from({length:4},()=>[`alt ${'條'.repeat(160)}`,`else ${'枝'.repeat(160)}`]).flat(),...Array.from({length:108},()=>`P9->>P9: ${'文'.repeat(160)}`),'end','end','end','end'].join('\n');
    const before=f.store.lastSeq(),rejected=await f.post(artifacts,{requestId:randomUUID(),input:{kind:'mermaid',source:limited,metadata:{}}});assert.equal(rejected.status,422);assert.deepEqual(await rejected.json(),{error:'SEQUENCE_LAYOUT_LIMIT'});assert.equal(f.store.lastSeq(),before);assert.equal((await (await f.get(artifacts)).json() as any[]).length,1);
    assert.equal(f.store.runs().length,0);assert.equal(f.store.projects()[0].writeEnabled,false);
  }finally{await f.close();}
});

test('Artifact export revalidates stored source integrity before returning Markdown or PPTX',async()=>{
  const f=await fixture();try{
    const saved=await (await f.post(artifacts,{requestId:randomUUID(),input:artifact})).json() as any;
    f.store.db.prepare('UPDATE artifacts SET body=? WHERE project_id=? AND id=? AND revision=1').run(JSON.stringify({...saved,source:artifact.source.replace('Browser','Corrupted')}),'project-a',saved.id);
    for(const format of ['markdown','pptx']){
      const response=await f.get(`${artifacts}/${saved.id}/export?revision=1&hash=${saved.contentHash}&format=${format}`);assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'ARTIFACT_INTEGRITY'});
    }
    f.store.db.prepare('UPDATE artifacts SET body=? WHERE project_id=? AND id=? AND revision=1').run(JSON.stringify({...saved,revision:2}),'project-a',saved.id);
    const forgedRevision=await f.get(`${artifacts}/${saved.id}/export?revision=2&hash=${saved.contentHash}&format=markdown`);assert.equal(forgedRevision.status,409);assert.deepEqual(await forgedRevision.json(),{error:'ARTIFACT_INTEGRITY'});
  }finally{await f.close();}
});

test('planning HTTP persists approval and idempotent task drafts across restart without running an agent',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'orbit-studio-')),'test.sqlite');let f=await fixture(path);
  try{
    const requestId=randomUUID();const created=await f.post(plans,{requestId,input});assert.equal(created.status,200);
    const plan=await created.json() as any;assert.equal(plan.state,'draft');
    const createdEvent=f.store.eventsAfter(0).find(event=>event.kind==='planning.created')!;
    assert.equal(createdEvent.data.id,plan.id);assert.equal(createdEvent.data.revision,1);
    assert.deepEqual(await (await f.post(plans,{requestId,input})).json(),plan);
    assert.equal((await f.post(plans,{requestId,input:{...input,text:input.text+'changed'}})).status,409);
    assert.equal((await f.post(`${plans}/${plan.id}/task-drafts`,{})).status,422);
    assert.equal((await f.post(`${plans}/${plan.id}/approve`,{expectedRevision:1})).status,200);
    const tasks=await (await f.post(`${plans}/${plan.id}/task-drafts`,{})).json() as any[];
    assert.equal(tasks.length,1);assert.equal(tasks[0].state,'draft');assert.equal(tasks[0].verification,'not_run');
    const taskEvent=f.store.eventsAfter(0).find(event=>event.kind==='planning.tasks_created')!;
    assert.equal(taskEvent.data.planningVersionId,plan.id);assert.deepEqual(taskEvent.data.taskIds,tasks.map(task=>task.id));
    assert.deepEqual(await (await f.post(`${plans}/${plan.id}/task-drafts`,{})).json(),tasks);
    const revision=await (await f.post(`${plans}/${plan.id}/revisions`,{requestId:randomUUID(),expectedRevision:1,input})).json() as any;
    assert.equal(revision.revision,2);assert.equal(revision.state,'draft');
    assert.equal((await f.post(`${plans}/${plan.id}/approve`,{expectedRevision:1})).status,409);
    await f.close();f=await fixture(path);
    const versions=await (await f.get(plans)).json() as any[];
    assert.equal(versions.length,2);assert.equal(versions[0].state,'approved');assert.ok(versions[0].approvedAt);assert.ok(versions[0].approvedBy);
    assert.deepEqual(await (await f.get('/api/projects/project-a/tasks')).json(),tasks);
    assert.equal(f.store.runs().length,0);assert.equal(f.store.projects()[0].writeEnabled,false);
    assert.equal(JSON.stringify(f.store.eventsAfter(0)).includes('Ship safely'),false);
  }finally{await f.close();}
});

test('Studio routes enforce authentication, CSRF, ownership, exact fields and revision conflicts',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.origin+plans)).status,401);
    assert.equal((await fetch(f.origin+plans,{method:'POST',headers:{...f.headers,'X-CSRF-Token':''},body:JSON.stringify({requestId:randomUUID(),input})})).status,403);
    assert.equal((await f.post(plans,{requestId:randomUUID(),input,state:'approved'})).status,400);
    assert.equal((await f.get('/api/projects/missing/plans')).status,404);
    const plan=await (await f.post(plans,{requestId:randomUUID(),input})).json() as any;
    assert.equal((await f.post(`/api/projects/project-b/plans/${plan.id}/approve`,{expectedRevision:1})).status,404);
    assert.equal((await f.post(`${plans}/${plan.id}/approve`,{expectedRevision:2})).status,409);
    assert.equal((await f.post(`${plans}/${plan.id}/task-drafts`,{state:'approved'})).status,400);
  }finally{await f.close();}
});

test('Artifact HTTP saves validated immutable history and restores it after restart',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'orbit-artifact-')),'test.sqlite');let f=await fixture(path);
  try{
    const requestId=randomUUID();const response=await f.post(artifacts,{requestId,input:artifact});assert.equal(response.status,200);
    const first=await response.json() as any;
    assert.deepEqual(await (await f.post(artifacts,{requestId,input:artifact})).json(),first);
    const next={...artifact,source:artifact.source.replace('Browser','Client')};
    assert.equal((await f.post(`${artifacts}/${first.id}/revisions`,{requestId:randomUUID(),expectedRevision:1,input:next})).status,200);
    assert.equal((await f.post(`${artifacts}/${first.id}/revisions`,{requestId:randomUUID(),expectedRevision:1,input:next})).status,409);
    assert.equal((await f.get(`/api/projects/project-b/artifacts/${first.id}/history`)).status,404);
    assert.equal((await f.post(artifacts,{requestId:randomUUID(),input:{...artifact,source:'flowchart TD\na["<script>"]'}})).status,400);
    await f.close();f=await fixture(path);
    const history=await (await f.get(`${artifacts}/${first.id}/history`)).json() as any[];
    assert.equal(history.length,2);assert.equal(history[0].source,artifact.source);assert.equal(history[1].source,next.source);
    assert.equal((await (await f.get(artifacts)).json() as any[])[0].revision,2);
  }finally{await f.close();}
});

test('mock provider endpoint blocks PII and policy overrides and records only fixed metadata',async()=>{
  const f=await fixture();try{
    const path='/api/providers/mock/send';
    const denied=await f.post(path,{providerId:'bedrock',text:'Contact example@example.test'});assert.equal(denied.status,422);
    assert.deepEqual(await denied.json(),{error:'PERSONAL_DATA_BLOCKED'});
    assert.equal((await f.post(path,{providerId:'vllm',text:'api_key=synthetic-secret'})).status,422);
    assert.equal((await f.post(path,{providerId:'bedrock',text:'hello',action:'allow',endpoint:'https://evil.example'})).status,400);
    const accepted=await f.post(path,{providerId:'litellm',text:'hello'});assert.equal(accepted.status,200);
    assert.equal((await accepted.json() as any).mode,'mock_only');
    const events=JSON.stringify(f.store.eventsAfter(0));assert.equal(events.includes('example@example.test'),false);assert.equal(events.includes('synthetic-secret'),false);
    assert.equal(f.store.runs().length,0);
  }finally{await f.close();}
});

test('Studio accepts escaped 256 KiB documents but rejects oversized decoded text and unsafe Artifact metadata',async()=>{
  const f=await fixture();try{
    const large={...input,text:input.text+'- '+String.fromCharCode(1).repeat(240000)};
    assert.ok(JSON.stringify(large).length>256*1024);
    assert.equal((await f.post(plans,{requestId:randomUUID(),input:large})).status,200);
    assert.equal((await f.post(plans,{requestId:randomUUID(),input:{...input,text:'x'.repeat(256*1024+1)}})).status,400);
    const unknown={...artifact,path:'C:/private',state:'approved'};
    assert.equal((await f.post(artifacts,{requestId:randomUUID(),input:unknown})).status,400);
    assert.equal((await f.post(artifacts,{requestId:randomUUID(),input:{...artifact,source:'x'.repeat(256*1024+1)}})).status,400);
    assert.equal((await fetch(f.origin+plans,{headers:{cookie:f.headers.cookie,Origin:'https://foreign.example'}})).status,403);
  }finally{await f.close();}
});

test('failed task persistence rolls back records and events; event listeners see committed data',async()=>{
  const f=await fixture();try{
    const plan=await (await f.post(plans,{requestId:randomUUID(),input})).json() as any;
    await f.post(`${plans}/${plan.id}/approve`,{expectedRevision:1});
    const before=f.store.lastSeq();let emitted=0;
    f.store.on('event',()=>{emitted++;assert.equal(f.store.db.isTransaction,false);});
    f.store.db.exec("CREATE TRIGGER fail_task BEFORE INSERT ON planning_tasks BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    assert.equal((await f.post(`${plans}/${plan.id}/task-drafts`,{})).status,500);
    assert.equal(f.store.lastSeq(),before);assert.equal(emitted,0);
    assert.deepEqual(await (await f.get('/api/projects/project-a/tasks')).json(),[]);
    f.store.db.exec('DROP TRIGGER fail_task');
    assert.equal((await f.post(`${plans}/${plan.id}/task-drafts`,{})).status,200);assert.equal(emitted,1);
  }finally{await f.close();}
});

test('competing revisions have one winner and replay survives reopening the database',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'orbit-race-')),'test.sqlite');let f=await fixture(path);
  try{
    const plan=await (await f.post(plans,{requestId:randomUUID(),input})).json() as any;
    const a={requestId:randomUUID(),expectedRevision:1,input},b={...a,requestId:randomUUID()};
    const results=await Promise.all([f.post(`${plans}/${plan.id}/revisions`,a),f.post(`${plans}/${plan.id}/revisions`,b)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const winner=results[0].status===200?a:b;
    const version=await results.find(r=>r.status===200)!.json();
    const count=f.store.lastSeq();
    await f.close();f=await fixture(path);
    assert.deepEqual(await (await f.post(`${plans}/${plan.id}/revisions`,winner)).json(),version);
    assert.equal(f.store.lastSeq(),count);
    const raw=f.store.db.prepare('SELECT original_input FROM planning_versions WHERE id=?').get(plan.id)!;
    assert.deepEqual(JSON.parse(raw.original_input as string),input);
    assert.equal((await f.post(`${plans}/${plan.id}/approve`,{expectedRevision:1})).status,409);
  }finally{await f.close();}
});

test('version quota prevents new content but never blocks approval or idempotent task recovery',async()=>{
  const f=await fixture();try{
    const plan=await (await f.post(plans,{requestId:randomUUID(),input})).json() as any;
    // Fill the version-count budget with synthetic inert rows; no user DB or file is used.
    for(let i=0;i<199;i++)f.store.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?)').run('project-a','quota-fixture',i+1,'{}');
    assert.equal((await f.post(plans,{requestId:randomUUID(),input})).status,413);
    assert.equal((await f.post(`${plans}/${plan.id}/approve`,{expectedRevision:1})).status,200);
    const tasks=await f.post(`${plans}/${plan.id}/task-drafts`,{});assert.equal(tasks.status,200);
    assert.deepEqual(await (await f.post(`${plans}/${plan.id}/task-drafts`,{})).json(),await tasks.json());
  }finally{await f.close();}
});
