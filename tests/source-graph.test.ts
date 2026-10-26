import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { analyzeSourceGraph } from '../server/source-graph.ts';
import type {SourceGraphInput} from '../shared/source-graph.ts';
const sourceDigest='a'.repeat(64),baseSha='b'.repeat(40);
const input=(path:string,content:string,changed=false):SourceGraphInput=>({path,content,changed});

test('local imports, aliases, declarations and static calls produce deterministic graph and reverse impact',()=>{
  const files=[input('src/lib.ts','export function helper(){ return 1; }\nexport class Base { method(){ return helper(); } }',true),
    input('src/app.ts','import {helper as renamed,Base} from "./lib";\nexport class Child extends Base {}\nexport function main(){ return renamed(); }')];
  const graph=analyzeSourceGraph(files,sourceDigest,baseSha);
  assert.equal(graph.status,'available');assert.equal(graph.analyzer.name,'typescript-static');assert.match(graph.analyzer.version,/^5\.9\./);
  assert.equal(graph.sourceDigest,sourceDigest);assert.equal(graph.baseSha,baseSha);
  for(const kind of ['file','function','class','method'])assert.ok(graph.nodes.some(node=>node.kind===kind));
  for(const kind of ['contains','imports','calls','extends'])assert.ok(graph.edges.some(edge=>edge.kind===kind));
  const main=graph.nodes.find(node=>node.label==='main')!,helper=graph.nodes.find(node=>node.label==='helper')!;
  assert.ok(graph.edges.some(edge=>edge.kind==='calls'&&edge.from===main.id&&edge.to===helper.id&&edge.evidence==='typechecker'&&edge.staticOnly));
  assert.ok(graph.impact.nodeIds.includes(main.id));assert.equal(graph.impact.fileIds.length,2);assert.equal(graph.changedFileIds.length,1);
  assert.deepEqual(analyzeSourceGraph([...files].reverse(),sourceDigest,baseSha),graph);
});

test('analysis is map-only and never asks the compiler system for files or directories',t=>{
  t.mock.method(ts.sys,'readFile',()=>{throw new Error('SYNTHETIC_PRIVATE_FILE_READ');});
  t.mock.method(ts.sys,'readDirectory',()=>{throw new Error('SYNTHETIC_PRIVATE_DIRECTORY_READ');});
  t.mock.method(ts.sys,'fileExists',()=>{throw new Error('SYNTHETIC_PRIVATE_FILE_PROBE');});
  const graph=analyzeSourceGraph([input('safe.ts','/// <reference path="/outside/auth.json" />\nimport fs from "node:fs"; export function safe(){ return fs.readFileSync("SYNTHETIC_LITERAL"); }')],sourceDigest,baseSha);
  assert.equal(graph.nodes.filter(node=>node.kind==='file').length,1);assert.ok(graph.unresolved.total>0);
  assert.equal(JSON.stringify(graph).includes('SYNTHETIC_LITERAL'),false);assert.equal(JSON.stringify(graph).includes('outside/auth.json'),false);
});

test('source bodies, module strings, literal property names and credential-shaped labels never escape the graph',()=>{
  const graph=analyzeSourceGraph([input('src/sk-synthetic-path.ts','import x from "SYNTHETIC_EXTERNAL_MODULE"; export function ghp_SYNTHETICFUNCTIONSECRET(){ const password="SYNTHETIC_BODY_VALUE"; return "SYNTHETIC_LITERAL"; } class Safe { "sk-synthetic-method"(){ return 1; } }')],sourceDigest,baseSha);
  const text=JSON.stringify(graph);for(const secret of ['sk-synthetic-path','SYNTHETICFUNCTIONSECRET','SYNTHETIC_BODY_VALUE','SYNTHETIC_LITERAL','SYNTHETIC_EXTERNAL_MODULE','sk-synthetic-method'])assert.equal(text.includes(secret),false,secret);
  assert.ok(text.includes('REDACTED'));assert.ok(graph.unresolved.byReason.unsupported_declaration>0);
});

test('paths, duplicate aliases, unsupported extensions and malformed inputs fail with one safe diagnostic',()=>{
  for(const path of ['/absolute.ts','../escape.ts','src/../escape.ts','a\\b.ts','C:/outside.ts','a//b.ts','a\0.ts','.aws/keys.ts','data.json'])
    assert.throws(()=>analyzeSourceGraph([input(path,'')],sourceDigest,baseSha),/^Error: SOURCE_GRAPH_UNAVAILABLE$/);
  assert.throws(()=>analyzeSourceGraph([input('same.ts',''),input('SAME.ts','')],sourceDigest,baseSha),/^Error: SOURCE_GRAPH_UNAVAILABLE$/);
  assert.throws(()=>analyzeSourceGraph([], 'SYNTHETIC_PRIVATE_DIGEST',baseSha),/^Error: SOURCE_GRAPH_UNAVAILABLE$/);
  assert.throws(()=>analyzeSourceGraph([],sourceDigest,'bad-base'),/^Error: SOURCE_GRAPH_UNAVAILABLE$/);
  let accessed=false;const file={path:'safe.ts',changed:false};Object.defineProperty(file,'content',{enumerable:true,get(){accessed=true;return 'SYNTHETIC_PRIVATE';}});
  assert.throws(()=>analyzeSourceGraph([file as SourceGraphInput],sourceDigest,baseSha),/^Error: SOURCE_GRAPH_UNAVAILABLE$/);assert.equal(accessed,false);
});

test('parse failures reject the entire analysis instead of returning a plausible partial graph',()=>{
  assert.throws(()=>analyzeSourceGraph([input('good.ts','export function good(){}'),input('bad.ts','export function SYNTHETIC_PRIVATE_NAME( {')],sourceDigest,baseSha),/^Error: SOURCE_GRAPH_UNAVAILABLE$/);
});

test('file, byte and declaration bounds fail closed while a maximum-size ordinary comment remains analyzable',()=>{
  assert.throws(()=>analyzeSourceGraph(Array.from({length:101},(_,index)=>input('file'+index+'.ts','')),sourceDigest,baseSha),/^Error: SOURCE_GRAPH_UNAVAILABLE$/);
  assert.throws(()=>analyzeSourceGraph([input('large.ts','//'+ '한'.repeat(90000))],sourceDigest,baseSha),/^Error: SOURCE_GRAPH_UNAVAILABLE$/);
  assert.throws(()=>analyzeSourceGraph(Array.from({length:17},(_,index)=>input('total'+index+'.ts','//'+ 'x'.repeat(256*1024-2))),sourceDigest,baseSha),/^Error: SOURCE_GRAPH_UNAVAILABLE$/);
  assert.equal(analyzeSourceGraph([input('maximum.ts','//'+ 'x'.repeat(256*1024-2))],sourceDigest,baseSha).coverage.files,1);
  assert.throws(()=>analyzeSourceGraph([input('many.ts',Array.from({length:2001},(_,index)=>`function f${index}(){}`).join('\n'))],sourceDigest,baseSha),/^Error: SOURCE_GRAPH_UNAVAILABLE$/);
});

test('external, dynamic and unresolved references are counted without invented call targets',()=>{
  const graph=analyzeSourceGraph([input('calls.ts','import external from "outside"; import {missing} from "./not-here"; export function entry(callback:any,obj:any,key:string){ callback(); obj[key](); import("./later"); external(); missing(); }')],sourceDigest,baseSha);
  assert.equal(graph.edges.filter(edge=>edge.kind==='calls').length,0);assert.equal(graph.edges.filter(edge=>edge.kind==='imports').length,0);
  for(const reason of ['external_import','unresolved_import','dynamic_import','unresolved_call','dynamic_call'] as const)assert.ok(graph.unresolved.byReason[reason]>0,reason);
});

test('typechecker scope resolution does not connect a shadowed callback to an unrelated same-name function',()=>{
  const graph=analyzeSourceGraph([input('scope.ts','function helper(){} export function main(helper:()=>void){ helper(); }')],sourceDigest,baseSha);
  assert.equal(graph.edges.filter(edge=>edge.kind==='calls').length,0);assert.ok(graph.unresolved.byReason.unresolved_call>0);
});

test('re-exports, explicit js imports and named arrow functions resolve only through supplied local sources',()=>{
  const graph=analyzeSourceGraph([input('lib.ts','export const worker=()=>1;'),input('barrel.ts','export {worker as exposed} from "./lib.js";'),input('main.ts','import {exposed} from "./barrel"; export const main=()=>exposed();')],sourceDigest,baseSha);
  const main=graph.nodes.find(node=>node.label==='main')!,worker=graph.nodes.find(node=>node.label==='worker')!;
  assert.equal(main.kind,'function');assert.equal(worker.kind,'function');assert.ok(graph.edges.some(edge=>edge.kind==='calls'&&edge.from===main.id&&edge.to===worker.id));
});

test('reverse impact crosses dependency cycles but excludes disconnected files and is explicitly potential',()=>{
  const files=[input('a.ts','import {b} from "./b"; export function a(){ return b(); }',true),input('b.ts','import {a} from "./a"; export function b(){ return a(); }'),input('alone.ts','export function alone(){}')];
  const graph=analyzeSourceGraph(files,sourceDigest,baseSha),alone=graph.nodes.find(node=>node.path==='alone.ts'&&node.kind==='file')!;
  assert.equal(graph.impact.evidence,'potential-static-reverse-dependency');assert.equal(graph.impact.truncated,false);assert.equal(graph.impact.fileIds.includes(alone.id),false);
  assert.equal(graph.coverage.runtimeAccuracy,false);assert.equal(graph.coverage.externalResolution,false);
});

test('class instance method edges identify only a static declaration and never claim a runtime dispatch target',()=>{
  const graph=analyzeSourceGraph([input('methods.ts','class Base { method(){return 1;} } class Child extends Base { method(){return 2;} } export function entry(value:Base){ return value.method(); }')],sourceDigest,baseSha);
  const calls=graph.edges.filter(edge=>edge.kind==='calls');assert.ok(calls.length);assert.ok(calls.every(edge=>edge.staticOnly&&edge.evidence==='typechecker'));assert.equal(graph.coverage.runtimeAccuracy,false);
});

test('uppercase JS and TS suffixes selected by the reader remain supported with local call resolution',()=>{
  const graph=analyzeSourceGraph([input('lib.TS','export function helper(){return 1;}'),input('app.JS','import {helper} from "./lib.TS"; export function entry(){return helper();}')],sourceDigest,baseSha);
  assert.equal(graph.coverage.files,2);assert.ok(graph.edges.some(edge=>edge.kind==='imports'));assert.ok(graph.edges.some(edge=>edge.kind==='calls'));
});

test('explicitly reassigned function bindings and mutable arrow bindings remain unresolved',()=>{
  const graph=analyzeSourceGraph([input('mutable.ts','function original(){return 1;} function other(){return 2;} original=other; let mutable=()=>3; export function entry(){original(); mutable();}')],sourceDigest,baseSha);
  const caller=graph.nodes.find(node=>node.label==='entry')!;
  assert.equal(graph.edges.some(edge=>edge.kind==='calls'&&edge.from===caller.id),false);assert.ok(graph.unresolved.byReason.unresolved_call>=2);
});

test('destructuring writes through array, object, rest and default targets invalidate only the written callable',()=>{
  for(const assignment of ['[original]=[replacement];','({handler:original}={handler:replacement});','[...original]=[replacement];',
    '({handler:original=replacement}={});','({original}= {original:replacement});','({nested:[original]}={nested:[replacement]});']){
    const graph=analyzeSourceGraph([input('destructure.ts',`function original(){} function replacement(){} ${assignment} export function entry(){original();replacement();}`)],sourceDigest,baseSha);
    const entry=graph.nodes.find(node=>node.label==='entry')!,original=graph.nodes.find(node=>node.label==='original')!,replacement=graph.nodes.find(node=>node.label==='replacement')!;
    assert.equal(graph.edges.some(edge=>edge.kind==='calls'&&edge.from===entry.id&&edge.to===original.id),false,assignment);
    assert.ok(graph.edges.some(edge=>edge.kind==='calls'&&edge.from===entry.id&&edge.to===replacement.id),assignment);
    assert.ok(graph.unresolved.byReason.unresolved_call>0);
  }
});
