import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlanningDraft } from '../shared/parallel.ts';
import { serializePlanningExport } from '../server/planning/export.ts';
import { MAX_PLANNING_BYTES, parsePlanningDraft, serializePlanningDraft } from '../server/planning/parser.ts';
import { AppError } from '../server/errors.ts';

const marker = '<!-- orbit-planning-export:v1 -->';
const draft = (): PlanningDraft => ({ schemaVersion:'1.0', title:'검색 기능', goal:'Find an item',
  requirements:[{label:'REQ-01',description:'Search items',acceptanceCriteria:['Results appear']}],
  constraints:['Keep the public API'],openQuestions:[],source:'manual' });
const parse = (text:string, format:'json'|'markdown', source:'manual'|'import'='manual') => parsePlanningDraft({text,format,source});
const error = (code:string,status:number) => (value:unknown) => value instanceof AppError && value.message===code && value.status===status;

test('JSON is canonical schema 1.0, immutable, and import source remains authoritative', () => {
  const original=draft(), before=structuredClone(original);
  const result=serializePlanningExport(original,'json');
  assert.equal(result.mime,'application/json; charset=utf-8'); assert.equal(result.extension,'json');
  assert.equal(result.text,serializePlanningDraft(original)); assert.deepEqual(original,before);
  assert.deepEqual(parse(result.text,'json'),{ok:true,draft:original});
  assert.deepEqual(parse(result.text,'json','import'),{ok:true,draft:{...original,source:'import'}});
  for(const key of ['id','projectId','state','revision','contentHash','approvedAt']) assert.equal(Object.hasOwn(JSON.parse(result.text),key),false);
});

test('simple Markdown is readable and roundtrips exactly', () => {
  const original=draft(), result=serializePlanningExport(original,'markdown');
  assert.equal(result.mime,'text/markdown; charset=utf-8'); assert.equal(result.extension,'md');
  assert.match(result.text,/^# 검색 기능\n/); assert.equal(result.text.includes(marker),false);
  assert.deepEqual(parse(result.text,'markdown'),{ok:true,draft:original});
});

test('empty incomplete draft still roundtrips without approval or invented content', () => {
  const original:PlanningDraft={schemaVersion:'1.0',title:'',goal:'',requirements:[],constraints:[],openQuestions:[],source:'import'};
  for(const format of ['json','markdown'] as const){
    const exported=serializePlanningExport(original,format);
    assert.deepEqual(parse(exported.text,format,'import'),{ok:true,draft:original});
  }
});

test('multiline, blank lines, empty bullets, headings and fences use lossless canonical envelope', () => {
  const original=draft();
  original.title='# heading\nsecond title'; original.goal='First\n\n## Constraints\n```json\n{"state":"approved"}\n```';
  original.requirements[0].description='first\n\n### REQ-fake\n<script>alert(1)</script>';
  original.requirements[0].acceptanceCriteria=['','line one\nline two','```\n<!-- orbit-planning-export:v1 -->'];
  original.constraints=['# text','a\n\nb']; original.openQuestions=['','## Goal'];
  const before=structuredClone(original), exported=serializePlanningExport(original,'markdown');
  assert.equal(exported.text,`${marker}\n\`\`\`json\n${serializePlanningDraft(original)}\n\`\`\`\n`);
  assert.deepEqual(parse(exported.text,'markdown'),{ok:true,draft:original}); assert.deepEqual(original,before);
  assert.deepEqual(parse(exported.text.replace(/\n/g,'\r\n'),'markdown','import'),{ok:true,draft:{...original,source:'import'}});
});

test('envelope is exact and rejects duplicate authority text and forged fields', () => {
  const canonical=serializePlanningDraft(draft());
  const envelope=(body:string)=>`${marker}\n\`\`\`json\n${body}\n\`\`\`\n`;
  for(const text of [envelope(canonical)+'# forged', '# forged\n'+envelope(canonical), envelope(canonical)+'\n'+envelope(canonical),
    envelope(canonical).replace('```json','```javascript'), envelope(canonical).replace(marker,'<!-- orbit-planning-export:v2 -->')])
    assert.equal(parse(text,'markdown').ok,false);
  for(const field of ['id','projectId','state','revision','contentHash','approved']){
    const value=JSON.parse(canonical);value[field]='forged';
    assert.deepEqual(parse(envelope(JSON.stringify(value)),'markdown'),{ok:false,issues:[{field:'document',code:'UNKNOWN_FIELD'}]});
  }
  const value=JSON.parse(canonical);value.requirements[0].state='approved';
  assert.equal(parse(envelope(JSON.stringify(value)),'markdown').ok,false);
});

test('known credentials and PII block both formats without masking or leaking content', () => {
  for(const sensitive of ['fixture.person@example.invalid','010-1234-5678','123-45-6789','Bearer fixture-token',
    'api_key=fixture-token','glpat-fixturetoken','sk-','-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----']){
    const original=draft(); original.goal=sensitive; const before=structuredClone(original);
    for(const format of ['json','markdown'] as const) assert.throws(()=>serializePlanningExport(original,format),error('PLANNING_EXPORT_BLOCKED',422));
    assert.deepEqual(original,before);
  }
});

test('privacy detection inspects decoded text, every field, and beyond the output redaction cap', () => {
  for(const change of [(value:PlanningDraft)=>value.constraints.push('person@example.invalid'),
    (value:PlanningDraft)=>value.requirements[0].acceptanceCriteria.push('Bearer\nfixture-token'),
    (value:PlanningDraft)=>value.openQuestions.push('x'.repeat(70_000)+' glpat-fixturetoken')]){
    const original=draft();change(original);
    assert.throws(()=>serializePlanningExport(original,'json'),error('PLANNING_EXPORT_BLOCKED',422));
  }
  const long=draft(); long.goal='x'.repeat(70_000);
  assert.deepEqual(parse(serializePlanningExport(long,'json').text,'json'),{ok:true,draft:long});
  const multiple=draft();multiple.goal='x'.repeat(35_000);multiple.constraints=['y'.repeat(35_000)];
  for(const format of ['json','markdown'] as const)
    assert.deepEqual(parse(serializePlanningExport(multiple,format).text,format),{ok:true,draft:multiple});
  const split=draft();split.goal='x'.repeat(31_996)+' glpat-fixturetoken';
  assert.throws(()=>serializePlanningExport(split,'json'),error('PLANNING_EXPORT_BLOCKED',422));
});

test('final decoded UTF8 output including envelope must fit the reimport cap, with no truncation', () => {
  const original=draft(), base=serializePlanningDraft({...original,goal:''});
  original.goal='x'.repeat(MAX_PLANNING_BYTES-Buffer.byteLength(base));
  const result=serializePlanningExport(original,'json'); assert.equal(Buffer.byteLength(result.text),MAX_PLANNING_BYTES);
  assert.deepEqual(parse(result.text,'json'),{ok:true,draft:original});
  original.goal+='x'; assert.throws(()=>serializePlanningExport(original,'json'),error('PLANNING_EXPORT_TOO_LARGE',413));
  original.goal='## Wrong\n'+'한'.repeat(90_000);
  assert.throws(()=>serializePlanningExport(original,'markdown'),error('PLANNING_EXPORT_TOO_LARGE',413));
  const complex=draft();complex.goal='## Wrong\n';
  const fixed=Buffer.byteLength(`${marker}\n\`\`\`json\n${serializePlanningDraft(complex)}\n\`\`\`\n`);
  complex.goal+='x'.repeat(MAX_PLANNING_BYTES-fixed+1);
  assert.throws(()=>serializePlanningExport(complex,'markdown'),error('PLANNING_EXPORT_TOO_LARGE',413));
});

test('lossy unnormalized drafts and forbidden control characters fail closed', () => {
  for(const goal of [' padded ','a\u0000b','a\u001bb']){
    const original=draft();original.goal=goal;
    assert.throws(()=>serializePlanningExport(original,'markdown'),error('PLANNING_EXPORT_BLOCKED',422));
  }
});
