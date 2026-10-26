import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PlanningDraft } from '../shared/parallel.ts';
import { approvalIssues, MAX_PLANNING_BYTES, normalizeStoredPlanningDraft, parsePlanningDraft, serializePlanningDraft } from '../server/planning/parser.ts';
import { InMemoryPlanningRepository } from '../server/planning/repository.ts';
import { serializePlanningExport } from '../server/planning/export.ts';
import { AppError } from '../server/errors.ts';

const document=()=>({schema_version:'1.0',title:'Search',goal:'Find an item',
  requirements:[{id:'REQ-1',description:'Find matches',acceptance_criteria:['Results appear']}],constraints:[],open_questions:[],
  decisions:[] as unknown[],source:{kind:'in_app_manual',provider_id:null,external_url:null} as Record<string,unknown>});
const read=(value:unknown,source:'manual'|'import'='manual')=>parsePlanningDraft({format:'json',text:JSON.stringify(value),source});
function parsed(value:unknown,source:'manual'|'import'='manual'):PlanningDraft {
  const result=read(value,source);assert.equal(result.ok,true);if(!result.ok)throw new Error('Expected valid fixture');return result.draft;
}
const metadata=()=>({kind:'external_web',provider_id:'reference-tool',external_url:'https://example.invalid/plan',author:'Draft author',
  references:[{title:'Design reference',url:'https://reference.invalid/guide'}]});

test('empty decisions and either default source kind preserve exact legacy shapes and hashes',()=>{
  for(const source of ['manual','import'] as const)for(const kind of ['in_app_manual','file']){
    const input=document();input.source={kind,provider_id:null,external_url:null};
    const expected:PlanningDraft={schemaVersion:'1.0',title:'Search',goal:'Find an item',requirements:[
      {label:'REQ-1',description:'Find matches',acceptanceCriteria:['Results appear']}],constraints:[],openQuestions:[],source};
    const repository=new InMemoryPlanningRepository();const version=repository.create('project-a',{format:'json',text:JSON.stringify(input),source});
    assert.deepEqual(version.draft,expected);assert.equal(version.contentHash,createHash('sha256').update(JSON.stringify(expected)).digest('hex'));
    assert.deepEqual(normalizeStoredPlanningDraft(version.draft),{ok:true,draft:expected});
    assert.deepEqual(read(JSON.parse(serializePlanningDraft(version.draft)),source),{ok:true,draft:expected});
  }
});

test('JSON decisions and source attribution normalize and survive canonical serialization',()=>{
  const input=document();input.decisions=[{topic:' Storage ',decision:' Use SQLite ',rationale:' Local persistence '}];
  input.source={...metadata(),kind:' external_web ',provider_id:' reference-tool ',author:' Draft author '};
  const draft=parsed(input,'import');
  assert.deepEqual(draft.decisions,[{topic:'Storage',decision:'Use SQLite',rationale:'Local persistence'}]);
  assert.deepEqual(draft.provenance,{kind:'external_web',providerId:'reference-tool',externalUrl:'https://example.invalid/plan',author:'Draft author',
    references:[{title:'Design reference',url:'https://reference.invalid/guide'}]});
  const canonical=JSON.parse(serializePlanningDraft(draft));
  assert.deepEqual(canonical.decisions,draft.decisions);assert.deepEqual(canonical.source,metadata());
  assert.deepEqual(read(canonical,'import'),{ok:true,draft});assert.deepEqual(normalizeStoredPlanningDraft(draft),{ok:true,draft});
});

test('meaningful metadata on default kinds is preserved while empty optional attribution normalizes away',()=>{
  const input=document();input.source={kind:'file',provider_id:null,external_url:null,author:' ',references:[]};
  assert.equal(Object.hasOwn(parsed(input),'provenance'),false);
  input.source.author='Source author';
  assert.deepEqual(parsed(input).provenance,{kind:'file',providerId:null,externalUrl:null,author:'Source author'});
  input.source={kind:'external_web'};
  assert.deepEqual(parsed(input).provenance,{kind:'external_web',providerId:null,externalUrl:null});
});

test('incomplete decisions save but each blank decision field blocks approval',()=>{
  for(const field of ['topic','decision','rationale']){
    const input=document();input.decisions=[{topic:'Storage',decision:'Use SQLite',rationale:'Local persistence',[field]:' '}];
    const repository=new InMemoryPlanningRepository();const version=repository.create('project-a',{format:'json',text:JSON.stringify(input),source:'manual'});
    assert.equal(version.state,'draft');assert.deepEqual(approvalIssues(version.draft),[{field:`decisions.0.${field}`,code:'REQUIRED'}]);
    assert.throws(()=>repository.approve('project-a',version.id,version.revision),/INCOMPLETE_DRAFT/);
  }
});

test('decision count is bounded and malformed decision keys or types fail with fixed diagnostics',()=>{
  const valid={topic:'Storage',decision:'Use SQLite',rationale:'Local persistence'};
  assert.equal(read({...document(),decisions:Array.from({length:100},()=>({...valid}))}).ok,true);
  for(const decisions of [null,'private-fixture',Array.from({length:101},()=>({...valid})),[null],[{...valid,state:'approved'}],
    [{...valid,topic:12}],[{topic:'Storage',decision:'Use SQLite'}]]){
    const result=read({...document(),decisions});assert.equal(result.ok,false);
    assert.equal(JSON.stringify(result).includes('private-fixture'),false);
  }
});

test('English and Korean Markdown decision sections preserve multiline decision context',()=>{
  const english='# Search\n## Goal\nFind an item\n## Requirements\n### REQ-1\nFind matches\n#### Acceptance criteria\n- Results appear\n'+
    '## Decisions\n### Storage\n#### Decision\nUse SQLite\nKeep one database\n#### Rationale\nLocal persistence\nEasy backups\n';
  const expected=[{topic:'Storage',decision:'Use SQLite\nKeep one database',rationale:'Local persistence\nEasy backups'}];
  for(const text of [english,english.replace('## Decisions','## 결정사항').replace('#### Decision','#### 결정').replace('#### Rationale','#### 근거')]){
    const result=parsePlanningDraft({format:'markdown',text,source:'manual'});assert.equal(result.ok,true);
    if(result.ok)assert.deepEqual(result.draft.decisions,expected);
  }
});

test('Markdown permits incomplete decision drafts but rejects duplicated decision headings and excessive decisions',()=>{
  const result=parsePlanningDraft({format:'markdown',text:'# Draft\n## Decisions\n### Storage\n#### Decision\nUse SQLite\n',source:'manual'});
  assert.equal(result.ok,true);if(result.ok)assert.deepEqual(result.draft.decisions,[{topic:'Storage',decision:'Use SQLite',rationale:''}]);
  for(const text of ['# Draft\n## Decisions\n### Storage\nUndirected text\n',
    '# Draft\n## Decisions\n### Storage\n#### Decision\nOne\n#### Decision\nTwo',
    '# Draft\n## Decisions\n### Storage\n#### Rationale\nOne\n#### Rationale\nTwo',
    '# Draft\n## Decisions\n'+Array.from({length:101},(_,index)=>`### Topic ${index}\n`).join('')])
    assert.equal(parsePlanningDraft({format:'markdown',text,source:'manual'}).ok,false);
});

test('source metadata has exact nested keys and validates nullable fields without reflecting input',()=>{
  for(const source of [null,[],{...metadata(),state:'approved'},{...metadata(),kind:1},{...metadata(),provider_id:false},
    {...metadata(),external_url:42},{...metadata(),author:null},{...metadata(),references:'private-fixture'},
    {...metadata(),references:[{title:'Reference',url:'https://reference.invalid',approved:true}]},
    {...metadata(),references:[{title:42,url:'https://reference.invalid'}]},{...metadata(),references:[{title:'Reference'}]}]){
    const result=read({...document(),source});assert.equal(result.ok,false);
    assert.equal(JSON.stringify(result).includes('private-fixture'),false);
  }
});

test('metadata text lengths and reference counts accept their limits and reject one extra',()=>{
  const accepted={kind:'k'.repeat(64),provider_id:'p'.repeat(128),external_url:'https://example.invalid/'+'x'.repeat(2024),
    author:'a'.repeat(200),references:Array.from({length:50},()=>({title:'t'.repeat(200),url:'https://reference.invalid'}))};
  assert.equal(accepted.external_url.length,2048);assert.equal(read({...document(),source:accepted}).ok,true);
  for(const [field,extra] of [['kind','k'],['provider_id','p'],['external_url','x'],['author','a']] as const)
    assert.equal(read({...document(),source:{...accepted,[field]:accepted[field]+extra}}).ok,false);
  assert.equal(read({...document(),source:{...accepted,references:[...accepted.references,accepted.references[0]]}}).ok,false);
  assert.equal(read({...document(),source:{...metadata(),references:[{title:'t'.repeat(201),url:'https://reference.invalid'}]}}).ok,false);
  assert.equal(read({...document(),source:{...metadata(),references:[{title:'Reference',url:accepted.external_url+'x'}]}}).ok,false);
});

test('source URLs are inert explicit HTTP(S) URLs with a host and no credentials or parser ambiguities',()=>{
  for(const url of ['https://example.invalid/path?query=value#section','http://127.0.0.1:3000/plan','https://[::1]/plan']){
    const draft=parsed({...document(),source:{...metadata(),external_url:url,references:[{title:'Same source',url}]}});
    assert.equal(draft.provenance!.externalUrl,url);assert.equal(draft.provenance!.references![0].url,url);
  }
  for(const url of ['javascript:private-fixture','data:text/plain,private-fixture','file:///private-fixture','//example.invalid',
    'https:example.invalid','https:///example.invalid','https://','https://user:pass@example.invalid',
    'https://example.invalid\\@evil.invalid','https://exa\nmple.invalid','https://example.invalid/a b']){
    for(const source of [{...metadata(),external_url:url},{...metadata(),references:[{title:'Reference',url}]}]){
      const result=read({...document(),source});assert.equal(result.ok,false,url);assert.equal(JSON.stringify(result).includes('private-fixture'),false);
    }
  }
});

test('metadata and decisions remain subject to the external input byte cap',()=>{
  const input={...document(),decisions:[{topic:'Storage',decision:'Use SQLite',rationale:'x'.repeat(MAX_PLANNING_BYTES)}]};
  assert.deepEqual(read(input),{ok:false,issues:[{field:'text',code:'INPUT_TOO_LARGE'}]});
});

test('exports preserve decisions in ordinary Markdown and metadata in the lossless envelope',()=>{
  const original=parsed({...document(),decisions:[{topic:'Storage',decision:'Use SQLite',rationale:'Local persistence'}]});
  const ordinary=serializePlanningExport(original,'markdown');assert.match(ordinary.text,/## Decisions\n### Storage\n#### Decision\nUse SQLite/);
  assert.deepEqual(parsePlanningDraft({format:'markdown',text:ordinary.text,source:'manual'}),{ok:true,draft:original});
  const full=parsed({...document(),decisions:original.decisions,source:metadata()});
  for(const format of ['json','markdown'] as const){
    const exported=serializePlanningExport(full,format);
    if(format==='markdown')assert.match(exported.text,/^<!-- orbit-planning-export:v1 -->/);
    assert.deepEqual(parsePlanningDraft({format,text:exported.text,source:'manual'}),{ok:true,draft:full});
  }
});

test('complex decision text uses the lossless Markdown envelope without losing blank lines or headings',()=>{
  const original=parsed({...document(),decisions:[{topic:'Storage\nsecond line',decision:'Use SQLite\n\n#### Rationale\nQuoted heading',rationale:''}]});
  const exported=serializePlanningExport(original,'markdown');assert.match(exported.text,/^<!-- orbit-planning-export:v1 -->/);
  assert.deepEqual(parsePlanningDraft({format:'markdown',text:exported.text,source:'manual'}),{ok:true,draft:original});
});

test('exports inspect every decoded decision and attribution string for sensitive data',()=>{
  const edits:((draft:PlanningDraft)=>void)[]=[
    value=>{value.decisions![0].topic='person@example.invalid';},value=>{value.decisions![0].decision='Bearer\nfixture-token';},
    value=>{value.decisions![0].rationale='api_key=fixture-token';},value=>{value.provenance!.kind='person@example.invalid';},
    value=>{value.provenance!.providerId='glpat-fixturetoken';},value=>{value.provenance!.externalUrl='https://example.invalid/?token=glpat-fixturetoken';},
    value=>{value.provenance!.author='person@example.invalid';},value=>{value.provenance!.references![0].title='person@example.invalid';},
    value=>{value.provenance!.references![0].url='https://reference.invalid/?token=glpat-fixturetoken';},
  ];
  for(const edit of edits){
    const original=parsed({...document(),decisions:[{topic:'Storage',decision:'Use SQLite',rationale:'Local persistence'}],source:metadata()});
    edit(original);const before=structuredClone(original);
    for(const format of ['json','markdown'] as const)assert.throws(()=>serializePlanningExport(original,format),
      (error:unknown)=>error instanceof AppError&&error.status===422&&error.message==='PLANNING_EXPORT_BLOCKED');
    assert.deepEqual(original,before);
  }
});

test('new text beyond the redaction cap and forbidden controls are blocked during export',()=>{
  for(const rationale of ['x'.repeat(70_000)+' glpat-fixturetoken','Keep\u0000this']){
    const original=parsed({...document(),decisions:[{topic:'Storage',decision:'Use SQLite',rationale}]});
    assert.throws(()=>serializePlanningExport(original,'json'),/PLANNING_EXPORT_BLOCKED/);
  }
});
