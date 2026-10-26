import test from 'node:test';
import assert from 'node:assert/strict';
import {validateC4,parseC4} from '../web/visualization/c4.ts';
import {C4_LIMITS} from '../shared/c4.ts';
import type {C4Diagram,C4Element,C4Relationship} from '../shared/c4.ts';

const person=(id='user'):C4Element=>({id,kind:'person',name:'User',description:'Uses the service',parentId:null,technology:null});
const system=(id='orbit'):C4Element=>({id,kind:'system',name:'Orbit',description:'Coordinates work',parentId:null,technology:null});
const container=(id='api',parentId='orbit'):C4Element=>({id,kind:'container',name:'API',description:'Serves requests',parentId,technology:'Node.js'});
const component=(id='service',parentId='api'):C4Element=>({id,kind:'component',name:'Service',description:'Processes requests',parentId,technology:'TypeScript'});
const relation=(id='uses',from='user',to='orbit',technology:string|null=null):C4Relationship=>({id,from,to,description:'Sends requests to',technology});
const context=():C4Diagram=>({format:'c4-v1',title:'Orbit context',view:'context',scope:'orbit',elements:[person(),system(),system('external')],relationships:[relation()]});
const containers=():C4Diagram=>({format:'c4-v1',title:'Orbit containers',view:'container',scope:'orbit',elements:[system(),person(),container(),container('db'),system('external')],relationships:[relation('requests','user','api'),relation('reads','api','db','SQL')]});
const components=():C4Diagram=>({format:'c4-v1',title:'API components',view:'component',scope:'api',elements:[system(),container(),component(),container('db'),person(),system('external')],relationships:[relation('requests','user','service'),relation('reads','service','db'),relation('outside','service','external')]});
function reject(value:unknown){
  const result=validateC4(value);
  assert.equal(result.ok,false,JSON.stringify(value));assert.ok(result.issues.length>0&&result.issues.length<=C4_LIMITS.issues);
  assert.throws(()=>parseC4(JSON.stringify(value)),/^Error: INVALID_C4$/);
}

test('accepts context, container and component views without normalizing source fields',()=>{
  for(const value of [context(),containers(),components()]){
    assert.deepEqual(validateC4(value),{ok:true,issues:[]});
    assert.deepEqual(parseC4(JSON.stringify(value,null,2)),value);
  }
});

test('component scope includes sibling containers inside its parent system',()=>{
  const value=components();
  value.elements.push(container('worker'));
  value.relationships.push(relation('publish','db','worker','Queue'));
  assert.equal(validateC4(value).ok,true);
  assert.equal(parseC4(JSON.stringify(value)).elements.find(e=>e.id==='db')?.parentId,'orbit');
});

test('allows disconnected drafts, empty relationships and a single-system context',()=>{
  for(const value of [context(),containers(),components()])assert.equal(validateC4({...value,relationships:[]}).ok,true);
  assert.equal(validateC4({...context(),elements:[system()],relationships:[]}).ok,true);
});

test('allows cycles and distinct parallel or reverse directed relationships',()=>{
  const value=containers();
  value.relationships=[relation('one','api','db','SQL'),relation('two','db','api','SQL'),{...relation('three','api','db','SQL'),description:'Reads status from'},relation('four','api','db','HTTP')];
  assert.equal(validateC4(value).ok,true);
});

test('requires exact top-level and element/relationship fields and primitive enums',()=>{
  for(const value of [null,[],{}, {...context(),extra:true}, {...context(),format:'c4-v2'}, {...context(),view:'deployment'}, {...context(),title:null},
    {...context(),elements:[{...person(),extra:true},system()]},
    {...context(),elements:[{...person(),kind:'actor'},system()]},
    {...context(),elements:[{...person(),name:null},system()]},
    {...context(),relationships:[{...relation(),extra:true}]},
    {...context(),relationships:[{id:'uses',from:'user',to:'orbit',description:'Uses'}]},
    {...context(),relationships:[{...relation(),technology:42}]}
  ])reject(value);
  // JSON.stringify converts a boxed string into a valid string; its direct
  // object rejection is a separate boundary from parsing the resulting JSON.
  assert.equal(validateC4({...context(),view:new String('context')}).ok,false);
  for(const key of ['format','title','view','scope','elements','relationships']){
    const value:Record<string,unknown>={...context()};delete value[key];reject(value);
  }
  for(const key of ['id','kind','name','description','parentId','technology']){
    const value:Record<string,unknown>={...person()};delete value[key];reject({...context(),elements:[value,system()]});
  }
});

test('requires safe unique ASCII IDs across elements and relationships',()=>{
  for(const id of ['','x'.repeat(65),'1bad','has space','한글','../path','x/y','x:y','<id>','a\\b'])reject({...context(),elements:[person(),{...system(),id}],scope:id,relationships:[]});
  const long='A'.repeat(64);assert.equal(validateC4({...context(),scope:long,elements:[system(long)],relationships:[]}).ok,true);
  assert.equal(validateC4({...context(),scope:'my-system_1',elements:[system('my-system_1')],relationships:[]}).ok,true);
  reject({...context(),elements:[person(),system(),system()]});
  reject({...context(),relationships:[relation('user')]});
  reject({...context(),relationships:[relation(),{...relation(),description:'Different'}]});
});

test('requires kind-correct parent and technology fields',()=>{
  for(const value of [
    {...context(),elements:[{...person(),parentId:'orbit'},system()]},
    {...context(),elements:[person(),{...system(),technology:'Node'}]},
    {...context(),elements:[{...person(),technology:'Browser'},system()]},
    {...containers(),elements:[system(),{...container(),parentId:null}]},
    {...containers(),elements:[system(),{...container(),technology:null}]},
    {...containers(),elements:[system(),{...container(),technology:'   '}]},
    {...containers(),elements:[system(),container('api','missing')]},
    {...containers(),elements:[system(),person(),container('api','user')]},
    {...components(),elements:[system(),container(),component('service','orbit')]},
    {...components(),elements:[system(),container(),{...component(),technology:null}]},
    {...components(),elements:[system(),container(),component('service','service')]},
    {...components(),elements:[system(),container('api','api'),component()]}
  ])reject({...value,relationships:[]});
});

test('requires a valid scope and primary child for detailed views',()=>{
  reject({...context(),scope:'missing'});reject({...context(),scope:'user'});
  reject({...containers(),scope:'api'});reject({...components(),scope:'orbit'});
  reject({...containers(),elements:[system()],relationships:[]});
  reject({...components(),elements:[system(),container(),container('db')],relationships:[]});
  reject({...components(),elements:[container(),component()],relationships:[]});
});

test('rejects elements outside each view level and focused hierarchy',()=>{
  reject({...context(),elements:[...context().elements,container()]});
  reject({...context(),elements:[system(),container(),component()],relationships:[]});
  reject({...containers(),elements:[...containers().elements,component()]});
  reject({...containers(),elements:[...containers().elements,container('foreign','external')]});
  reject({...components(),elements:[...components().elements,component('foreign','db')]});
  reject({...components(),elements:[...components().elements,container('foreign','external')]});
});

test('rejects unknown endpoints and expanded boundaries at either end',()=>{
  reject({...context(),relationships:[relation('bad','missing','orbit')]});
  reject({...context(),relationships:[relation('bad','user','missing')]});
  for(const value of [containers(),components()]){
    const leaf=value.view==='container'?'api':'service';
    const boundaries=value.view==='container'?['orbit']:['orbit','api'];
    for(const id of boundaries){
      reject({...value,relationships:[relation('bad',id,leaf)]});
      reject({...value,relationships:[relation('bad',leaf,id)]});
    }
  }
});

test('rejects self edges and duplicate relationship semantics independently of IDs',()=>{
  reject({...context(),relationships:[relation('self','orbit','orbit')]});
  reject({...context(),relationships:[relation('one'),relation('two')]});
  reject({...containers(),relationships:[relation('one','api','db','SQL'),relation('two','api','db','SQL')]});
});

test('requires technology only between two container leaves',()=>{
  reject({...containers(),relationships:[relation('reads','api','db')]});
  reject({...containers(),relationships:[relation('reads','api','db',' ')]});
  for(const value of [context(),components()])assert.equal(validateC4(value).ok,true);
  assert.equal(validateC4({...context(),relationships:[relation('uses','user','orbit','HTTPS')]}).ok,true);
});

test('enforces Unicode code-point limits and preserves grapheme sequences',()=>{
  const family='👩‍👩‍👧‍👦',name='😀'.repeat(80),description='한'.repeat(160),technology='😀'.repeat(80);
  const value=components();value.title=name;value.elements[2]={...value.elements[2],name,description,technology};value.relationships[0]={...value.relationships[0],description,technology};
  assert.deepEqual(parseC4(JSON.stringify(value)),value);
  assert.equal(validateC4({...context(),title:`Team ${family} & C#`}).ok,true);
  reject({...value,title:name+'x'});
  for(const field of ['name','description','technology'] as const){
    const copy=structuredClone(value);copy.elements[2][field]+='x';reject(copy);
  }
  const tooLongDescription=structuredClone(value);tooLongDescription.relationships[0].description+='x';reject(tooLongDescription);
  const tooLongTechnology=structuredClone(value);tooLongTechnology.relationships[0].technology+='x';reject(tooLongTechnology);
  for(const text of ['','   '])reject({...context(),title:text});
});

test('rejects decoded unsafe strings on every display-text surface',()=>{
  const unsafe=['<img src=x>','https://example.test','http://example.test','javascript:alert(1)','data:text/html,x','mailto:user@example.test','//example.test','www.example.test','&lt;img&gt;','&#60;','#60;','%3Cimg','%%{init: {}}','x\u0000','x\u0009','x\n','x\r','x\u007f','x\u0085','x\ufffe','x\ud800','x\udfff','x\u202e','x\u2066','x\u200b','x\ufeff'];
  for(const text of unsafe){
    reject({...context(),title:text});
    for(const field of ['name','description','technology'] as const){
      const value=components();value.elements[2][field]=text;reject(value);
    }
    for(const field of ['description','technology'] as const){
      const value=context();value.relationships[0][field]=text;reject(value);
    }
  }
  const encoded=JSON.stringify(context()).replace('Orbit context','\\u003cscript\\u003e');
  assert.throws(()=>parseC4(encoded),/^Error: INVALID_C4$/);
});

test('bounds elements and relationships independently',()=>{
  const value=context();value.relationships=[];value.elements=Array.from({length:12},(_,i)=>system(i===0?'orbit':'s'+i));
  assert.equal(validateC4(value).ok,true);reject({...value,elements:[...value.elements,system('extra')]});
  const edges=Array.from({length:24},(_,i)=>({...relation('r'+i),description:'Relationship '+i}));
  assert.equal(validateC4({...context(),relationships:edges}).ok,true);
  reject({...context(),relationships:[...edges,{...relation('r24'),description:'Relationship 24'}]});
});

test('bounds raw UTF-8 input before JSON parsing and fails with fixed errors',()=>{
  const compact=JSON.stringify(context());const exact=compact+' '.repeat(C4_LIMITS.sourceBytes-Buffer.byteLength(compact));
  assert.deepEqual(parseC4(exact),context());
  for(const source of [exact+' ','','null','[]','{','{ "title": "private input"','한'.repeat(90000)])assert.throws(()=>parseC4(source),/^Error: INVALID_C4$/);
  for(const value of [null,undefined,42,{}])assert.throws(()=>parseC4(value as unknown as string),/^Error: INVALID_C4$/);
});

test('rejects sparse, extended, symbol-keyed, accessor and cyclic direct objects safely',()=>{
  assert.equal(validateC4({...context(),elements:new Array(1)}).ok,false);
  assert.equal(validateC4({...context(),relationships:new Array(1)}).ok,false);
  assert.equal(validateC4({...context(),elements:Object.assign(context().elements,{extra:true})}).ok,false);
  assert.equal(validateC4({...context(),relationships:Object.assign(context().relationships,{extra:true})}).ok,false);
  assert.equal(validateC4({...context(),[Symbol('extra')]:true}).ok,false);
  let accessed=false;
  const accessor={...context(),get title(){accessed=true;return 'Title';}};
  assert.equal(validateC4(accessor).ok,false);assert.equal(accessed,false);
  const cycle:Record<string,unknown>={...context()};cycle.elements=[cycle];assert.equal(validateC4(cycle).ok,false);
  const throwing=new Proxy({}, {ownKeys(){throw new Error('PRIVATE');}});
  assert.deepEqual(validateC4(throwing),{ok:false,issues:[{code:'INVALID_C4'}]});
});

test('returns deterministic detached models and bounded diagnostics without raw input',()=>{
  const value=components(),snapshot=JSON.stringify(value);
  assert.equal(validateC4(value).ok,true);assert.equal(JSON.stringify(value),snapshot);
  const first=parseC4(snapshot),second=parseC4(snapshot);first.elements[2].name='Changed';first.relationships.pop();assert.deepEqual(second,value);
  const bad={...context(),scope:'SYNTHETIC_PRIVATE_SCOPE',elements:context().elements.map(e=>({...e,name:'<SYNTHETIC_PRIVATE_LABEL>'}))};
  const result=validateC4(bad);assert.equal(result.ok,false);
  assert.ok(result.issues.length>0&&result.issues.length<=32);assert.equal(JSON.stringify(result).includes('SYNTHETIC'),false);
  assert.ok(result.issues.every(issue=>/^[A-Z_]+$/.test(issue.code)&&(!issue.field||/^[a-zA-Z.\d]+$/.test(issue.field))));
});

test('does not invoke inherited array serialization hooks',()=>{
  let called=false;
  const elements=context().elements;
  Object.setPrototypeOf(elements,Object.assign(Object.create(Array.prototype),{toJSON(){called=true;return [];}}));
  assert.equal(validateC4({...context(),elements}).ok,false);
  assert.equal(called,false);
});

const displayFields=['title','elementName','elementDescription','elementTechnology','relationshipDescription','relationshipTechnology'] as const;
function displayedText(field:typeof displayFields[number],text:string):C4Diagram {
  const value=components();
  if(field==='title')value.title=text;
  else if(field==='elementName')value.elements[2].name=text;
  else if(field==='elementDescription')value.elements[2].description=text;
  else if(field==='elementTechnology')value.elements[2].technology=text;
  else if(field==='relationshipDescription')value.relationships[0].description=text;
  else value.relationships[0].technology=text;
  return value;
}

for(const field of displayFields)test(`rejects Unicode format controls in ${field}`,()=>{
  const codePoints=[0x0600,0x180e,0xfff9,0xfffa,0xfffb,0xe0001,0xe0020,0xe0067,0xe007f];
  const accepted=codePoints.filter(codePoint=>validateC4(displayedText(field,'Label'+String.fromCodePoint(codePoint)+'Text')).ok);
  assert.deepEqual(accepted.map(codePoint=>'U+'+codePoint.toString(16)),[],field);
  for(const codePoint of codePoints){
    const value=displayedText(field,'Label'+String.fromCodePoint(codePoint)+'Text');
    assert.equal(validateC4(value).ok,false,`${field} U+${codePoint.toString(16)}`);
    assert.throws(()=>parseC4(JSON.stringify(value)),/^Error: INVALID_C4$/);
  }
});

test('preserves documented join controls and non-tag emoji graphemes on every text surface',()=>{
  for(const field of displayFields){
    for(const text of ['Team 👩‍👩‍👧‍👦','می\u200cرود','✈️ 🇰🇷']){
      const value=displayedText(field,text);
      assert.deepEqual(validateC4(value),{ok:true,issues:[]});
      assert.deepEqual(parseC4(JSON.stringify(value)),value);
    }
  }
});
