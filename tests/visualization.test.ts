import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Snapshot, AppEvent } from '../shared/types.ts';
import { validateMermaid, parseMermaid, generateArchitectureMermaid, validateArchitecture } from '../web/visualization/mermaid.ts';
import { toPresentationDocument,exportPresentation,validatePresentationDocument } from '../web/visualization/presentation.ts';
import { buildTimeline } from '../web/visualization/timeline.ts';
import { ArtifactRepository } from '../server/visualization/artifacts.ts';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const graph = {nodes:[{id:'browser',label:'Browser',kind:'client'},{id:'server',label:'Local server',kind:'service'}],edges:[{from:'browser',to:'server',label:'HTTP'}]};
const source = 'flowchart TD\n  browser["Browser"]\n  server["Local server"]\n  browser -->|HTTP| server';
const snapshot: Snapshot = {provider:'disconnected',issue:null,threadId:null,workspace:'fixture',readOnly:true,lastSeq:10,selectedWorkspaceId:'w1',runs:[{id:'r1',workspaceId:'w1',requestId:'q',turnId:null,prompt:'',response:'',execution:'completed',verification:'not_run',createdAt:'2026-10-25',updatedAt:'2026-10-25'}]};
const event = (seq:number,kind='run.completed',runId:string|null='r1',data:Record<string,unknown>={}):AppEvent => ({seq,kind,runId,data,at:'2026-10-25T00:00:00Z'});

test('restricted Mermaid generates and parses inert nodes and edges including Unicode labels',()=>{
  assert.equal(generateArchitectureMermaid(graph), 'flowchart TD\n  n0["Browser"]\n  n1["Local server"]\n  n0 -->|HTTP| n1');
  assert.equal(validateMermaid(source).ok,true);
  assert.equal(parseMermaid(source).edges[0].label,'HTTP');
  assert.equal(validateMermaid('flowchart LR\n  n["한글 & text"]\n  n --> n').ok,true);
});

test('Mermaid rejects executable, encoded, malformed and unsupported syntax',()=>{
  for(const input of [
    '%%{init: {securityLevel: "loose"}}%%\n'+source,
    source+'\nclick browser "https://example.com"',
    'flowchart TD\n n["<img src=x onerror=alert(1)>"]',
    'flowchart TD\n n["https://example.com"]',
    'flowchart TD\n n["mailto:person@example.com"]',
    'flowchart TD\n n["ftp:example.com"]',
    'flowchart TD\n n["javascript:alert(1)"]',
    'flowchart TD\n n["&#60;script&#62;"]',
    'flowchart TD\n n["#60;script#62;"]',
    'flowchart TD\n n["%3Cscript%3E"]',
    'flowchart TD\n n["x"]\n n["again"]',
    'flowchart TD\n n --> missing', 'sequenceDiagram\n A->>B: hi',
    source+'\nclassDef default fill:red', source+'; click browser callback',
    'flowchart TD\n n["x"]\n n --x n',
  ]) assert.equal(validateMermaid(input).ok,false,input);
  assert.equal(validateMermaid('x'.repeat(262145)).ok,false);
  assert.equal(validateMermaid('flowchart TD\n n["'+'한'.repeat(90000)+'"]').ok,false);
});

test('architecture rejects invalid topology, injected labels and runtime type violations',()=>{
  for(const bad of [null, {}, {nodes:[],edges:[]}, {...graph,edges:[{from:'browser',to:'missing'}]}, {...graph,nodes:[graph.nodes[0],graph.nodes[0]]}, {...graph,nodes:[{id:'a;click',label:'X',kind:'service'}]}, {...graph,nodes:[{id:'a',label:'<script>',kind:'service'}]}, {...graph,nodes:[{id:'a',label:42,kind:'service'}]}, {...graph,extra:true}]) {
    assert.equal(validateArchitecture(bad).ok,false);
    assert.throws(()=>generateArchitectureMermaid(bad as typeof graph));
  }
});

test('presentation preserves editable node text, shapes, and endpoint-linked connectors',()=>{
  const doc=toPresentationDocument(graph);
  const elements=doc.slides.flatMap(s=>s.elements);
  assert.equal(elements.filter(e=>e.type==='shape').length,2);
  assert.deepEqual(elements.filter(e=>e.type==='text').map(e=>e.text),['Browser','Local server','HTTP']);
  const connector=elements.find(e=>e.type==='connector');
  assert.ok(connector && connector.type==='connector');
  assert.equal(connector.from,'browser');assert.equal(connector.to,'server');
  assert.ok(elements.every(e=>e.type!=='image' as string));
  assert.throws(()=>toPresentationDocument({...graph,edges:[{from:'missing',to:'server'}]}));
});

test('export boundary supplies editable elements and rejects invalid graphs before dispatch',async()=>{
  let calls=0;
  const exporter={export:async(document:ReturnType<typeof toPresentationDocument>)=>{
    calls++;
    assert.equal(document.slides[0].elements.filter(e=>e.type==='connector').length,1);
    assert.equal(document.slides[0].elements.filter(e=>e.type==='text')[0].text,'Browser');
    return new Uint8Array([1,2,3]); // Synthetic transport bytes, deliberately not a PPTX fixture.
  }};
  assert.deepEqual(await exportPresentation(graph,exporter),new Uint8Array([1,2,3]));
  await assert.rejects(exportPresentation({nodes:[],edges:[]},exporter),/INVALID_ARCHITECTURE/);
  assert.equal(calls,1);
});

test('presentation validation rejects images, external fields and dangling connectors',()=>{
  const document=toPresentationDocument(graph);
  assert.equal(validatePresentationDocument(document),true);
  for(const element of [{type:'image',id:'image',src:'https://example.com'}, {type:'connector',id:'bad',from:'browser',to:'missing'}]) {
    const bad=structuredClone(document) as {slides:{elements:unknown[]}[]};
    bad.slides[0].elements.push(element);
    assert.equal(validatePresentationDocument(bad),false);
  }
  assert.equal(validatePresentationDocument({...document,path:'C:/example'}),false);
});

test('Artifact revisions preserve exact source, server authority and detached history',()=>{
  const repo=new ArtifactRepository();
  const input={kind:'mermaid' as const,source:source+'\n',metadata:{title:'Original'}};
  const first=repo.create('p1',input);
  assert.equal(first.revision,1);assert.equal(first.projectId,'p1');
  assert.equal(first.contentHash,createHash('sha256').update(input.source).digest('hex'));
  assert.equal(first.source,input.source);assert.match(first.id,/^[0-9a-f-]{36}$/);
  first.metadata.title='mutated';input.metadata.title='also mutated';
  const second=repo.revise('p1',first.id,1,{kind:'mermaid',source,metadata:{title:'Second'}});
  assert.equal(second.revision,2);assert.equal(second.id,first.id);
  assert.deepEqual(repo.history('p1',first.id).map(a=>a.metadata.title),['Original','Second']);
  assert.throws(()=>repo.revise('p1',first.id,1,{kind:'mermaid',source,metadata:{}}),/REVISION_CONFLICT/);
  assert.equal(repo.list('p2').length,0);
  assert.throws(()=>repo.history('p2',first.id),/ARTIFACT_NOT_FOUND/);
  assert.throws(()=>repo.revise('p2',first.id,2,{kind:'mermaid',source,metadata:{}}),/ARTIFACT_NOT_FOUND/);
});

test('Artifact input cannot inject identity, paths, hash, revision or invalid content',()=>{
  const repo=new ArtifactRepository();
  for(const extra of [{id:'injected'},{revision:900},{contentHash:'fake'},{createdAt:'fake'},{path:'C:/secret'},{projectId:'p2'}]) {
    assert.throws(()=>repo.create('p1',{kind:'mermaid',source,metadata:{},...extra}),/INVALID_ARTIFACT/);
  }
  assert.throws(()=>repo.create('../p1',{kind:'mermaid',source,metadata:{}}),/INVALID_PROJECT/);
  assert.throws(()=>repo.create('p1',{kind:'mermaid',source:'flowchart TD\nclick x callback',metadata:{}}));
  assert.throws(()=>repo.create('p1',{kind:'architecture',source:'{"nodes":[]}',metadata:{}}));
  assert.throws(()=>repo.create('p1',{kind:'presentation',source:'{}',metadata:{}}));
  assert.throws(()=>repo.create('p1',{kind:'mermaid',source,metadata:{secret:32}} as never));
  const architecture=repo.create('p1',{kind:'architecture',source:JSON.stringify(graph),metadata:{}});
  assert.equal(architecture.kind,'architecture');
  const presentation=repo.create('p1',{kind:'presentation',source:JSON.stringify(toPresentationDocument(graph)),metadata:{}});
  assert.equal(presentation.kind,'presentation');
});

test('timeline deduplicates and orders events without inferring verification',()=>{
  const before=structuredClone(snapshot);
  const view=buildTimeline(snapshot,[event(12,'run.interrupted'),event(11),event(11)]);
  assert.deepEqual(view.items.map(i=>i.seq),[11,12]);assert.equal(view.lastSeq,12);
  assert.equal(view.reload,null);assert.match(view.items[0].label,/not verified/i);
  assert.deepEqual(snapshot,before);
  assert.equal(buildTimeline(snapshot,[event(11,'untrusted.<script>')]).items[0].label,'Other event');
});

test('timeline detects gaps and conflicting duplicates without advancing past uncertainty',()=>{
  const gap=buildTimeline(snapshot,[event(12)]);
  assert.equal(gap.lastSeq,10);assert.equal(gap.reload?.reason,'gap');assert.equal(gap.items.length,0);
  const conflict=buildTimeline(snapshot,[event(11),event(11,'run.failed')]);
  assert.equal(conflict.lastSeq,10);assert.equal(conflict.reload?.reason,'conflicting_sequence');
});

test('timeline filters foreign workspaces and requires reload for selection events',()=>{
  const foreign=event(11,'run.completed','foreign',{run:{workspaceId:'w2'}});
  assert.equal(buildTimeline(snapshot,[foreign,event(12)]).items.length,1);
  const switched=buildTimeline(snapshot,[event(11,'workspace.selected',null,{workspaceId:'w2'}),event(12)]);
  assert.equal(switched.reload?.reason,'workspace_changed');assert.equal(switched.items.length,0);
  const next={...snapshot,selectedWorkspaceId:'w2',lastSeq:12,runs:[]};
  assert.equal(buildTimeline(next,[event(11),event(12)]).items.length,0);
  assert.notEqual(buildTimeline(snapshot,[]).workspaceKey,buildTimeline(next,[]).workspaceKey);
});

test('reserved Mermaid identifiers are remapped and prototype event names stay neutral',()=>{
  const generated=generateArchitectureMermaid({nodes:[{id:'end',label:'End service',kind:'service'}],edges:[]});
  assert.equal(validateMermaid(generated).ok,true);
  assert.equal(buildTimeline(snapshot,[event(11,'__proto__')]).items[0].label,'Other event');
});

test('Artifact list and history mutations never alter stored originals',()=>{
  const repo=new ArtifactRepository();const created=repo.create('p1',{kind:'mermaid',source,metadata:{title:'kept'}});
  repo.list('p1')[0].source='tampered';repo.history('p1',created.id)[0].metadata.title='tampered';
  assert.equal(repo.list('p1')[0].source,source);
  assert.equal(repo.history('p1',created.id)[0].metadata.title,'kept');
  assert.throws(()=>repo.revise('p1',created.id,1,{kind:'architecture',source:JSON.stringify(graph),metadata:{}}),/ARTIFACT_KIND_IMMUTABLE/);
});

// Transform JSX in memory, resolving only observed local imports. This checks rendered
// output without requiring a browser or writing transpiled files into the repository.
async function components() {
  const url=new URL('../web/visualization/Studio.tsx',import.meta.url);
  const transformed=await transform(await readFile(url,'utf8'),{loader:'tsx',format:'esm',jsx:'automatic'});
  const code=transformed.code.replace(/from "([^"]+)"/g,(_match,spec:string)=>`from ${JSON.stringify(spec.startsWith('.')?new URL(spec,url).href:import.meta.resolve(spec))}`);
  return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
}

test('standalone UI renders an inert preview and keeps unavailable PPTX export disabled',async()=>{
  const {VisualizationStudio,ArchitecturePreview}=await components();
  const html=renderToStaticMarkup(createElement(VisualizationStudio,{projectId:'p1',artifacts:[]}));
  assert.match(html,/Visualization Studio/);assert.match(html,/PPTX generation foundation only/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>Export PPTX/);
  const preview=renderToStaticMarkup(createElement(ArchitecturePreview,{graph}));
  assert.match(preview,/<svg/);assert.match(preview,/Local server/);assert.doesNotMatch(preview,/<image|foreignObject|<script/);
  assert.match(preview,/d="M 260 90 L 300 90"/,'same-row connector must use facing sides so its arrowhead remains visible');
});

test('reload lifecycle cancels stale dispatch and survives StrictMode setup-cleanup-setup',async()=>{
  const {startTimelineReload}=await import('../web/visualization/timeline.ts');
  const request={workspaceKey:'w1',after:10,reason:'gap'};
  const calls:unknown[]=[];let failures=0;
  const callback=async(input:typeof request)=>{calls.push(input);throw new Error('fixture failure');};
  const cancel=startTimelineReload(request,callback,()=>{failures++;});
  cancel();
  startTimelineReload(request,callback,()=>{failures++;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[request]);assert.equal(failures,1);
});

test('reload cleanup ignores an old in-flight failure and allows an explicit retry',async()=>{
  const {startTimelineReload}=await import('../web/visualization/timeline.ts');
  let rejectOld!:(error:Error)=>void;let failures=0,attempts=0;
  const request={workspaceKey:'w1',after:10,reason:'gap'};
  const cancel=startTimelineReload(request,()=>new Promise<void>((_resolve,reject)=>{rejectOld=reject;}),()=>{failures++;});
  await new Promise(resolve=>setImmediate(resolve));cancel();rejectOld(new Error('old failure'));
  startTimelineReload(request,async()=>{attempts++;},()=>{failures++;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(failures,0);assert.equal(attempts,1);
});

test('timeline UI labels completed runs unverified and never renders foreign diffs',async()=>{
  const {RunTimeline}=await components();
  const html=renderToStaticMarkup(createElement(RunTimeline,{view:buildTimeline(snapshot,[]),snapshot,onReload:async()=>{},diff:{workspaceId:'w2',baseSha:'abc',files:[{path:'foreign.txt',status:'M',patch:'secret fixture'}]}}));
  assert.match(html,/Verification: not_run/);assert.doesNotMatch(html,/foreign.txt|secret fixture/);
  const matching=renderToStaticMarkup(createElement(RunTimeline,{view:buildTimeline(snapshot,[]),snapshot,onReload:async()=>{},diff:{workspaceId:'w1',baseSha:'abc',files:[{path:'<img>.txt',status:'M',patch:'<script>fixture</script>'}]}}));
  assert.match(matching,/&lt;script&gt;fixture&lt;\/script&gt;/);assert.doesNotMatch(matching,/<script>/);
});
