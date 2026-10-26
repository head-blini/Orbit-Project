import test from 'node:test';
import assert from 'node:assert/strict';
import {parseClassDiagram,validateClassDiagram,validateClassModel} from '../web/visualization/uml-class.ts';
import {CLASS_LIMITS} from '../shared/uml-class.ts';
import type {ClassDiagram,ClassNode,ClassRelationship,ClassRelationshipKind} from '../shared/uml-class.ts';

const node=(id='A'):ClassNode=>({id,name:id,annotation:null,attributes:[],operations:[]});
const edge=(id='r1'):ClassRelationship=>({id,kind:'association',from:'A',to:'B',fromMultiplicity:null,toMultiplicity:null,label:null});
const model=():ClassDiagram=>({kind:'class',classes:[node(),node('B')],relationships:[edge()]});
const source=(body:string)=>`classDiagram\n${body}`;
function reject(value:string){
  const result=validateClassDiagram(value);assert.equal(result.ok,false,value);assert.ok(result.issues.length>0&&result.issues.length<=CLASS_LIMITS.issues);
  assert.throws(()=>parseClassDiagram(value),/^Error: INVALID_CLASS_DIAGRAM$/);
}
function accept(value:string){const parsed=parseClassDiagram(value);assert.deepEqual(validateClassDiagram(value),{ok:true,issues:[]});assert.equal(validateClassModel(parsed),true);return parsed;}

test('explicit declarations preserve order, labels and empty class compartments',()=>{
  const result=accept(source('class A\nclass B["한글 이름"]\nclass C {\n}\nclass D["Label with C++"] {\n}'));
  assert.deepEqual(result,{kind:'class',classes:[node(),{...node('B'),name:'한글 이름'},node('C'),{...node('D'),name:'Label with C++'}],relationships:[]});
  assert.deepEqual(accept('\n classDiagram\r\n\tclass A\r\n'),{kind:'class',classes:[node()],relationships:[]});
});

test('members preserve visibility, typed colons, array syntax and internal plus signs',()=>{
  const result=accept(source('class Account {\n  +name:string\n  -items: Item[]\n  #C++ value\n  ~packageField: int\n  +get(id: Int): User\n  -operator+(other: Money) Money\n  #constructor()\n  ~refresh() void\n}'));
  assert.deepEqual(result.classes[0],{id:'Account',name:'Account',annotation:null,attributes:['+name:string','-items: Item[]','#C++ value','~packageField: int'],operations:['+get(id: Int): User','-operator+(other: Money) Money','#constructor()','~refresh() void']});
});

test('command keywords are valid inert typed member names and operation names',()=>{
  const attributes=['+link: string','+style: CSSProperties','+direction: string','-class: string','#note : string','~namespace: string'];
  const operations=['+callback(): void','+click(): void','+style (): CSSProperties'];
  const result=accept(source(`class A {\n${[...attributes,...operations].join('\n')}\n}`));
  assert.deepEqual(result.classes[0],{...node(),attributes,operations});
  assert.equal(validateClassModel({kind:'class',classes:[{...node(),attributes,operations}],relationships:[]}),true);
});

test('command-shaped member lines remain unsupported independently of keyword-named fields',()=>{
  for(const member of ['click A href "example"','style A fill:red','callback A "handler"','class A','direction LR','namespace N',
    'link A "target"','note "text"','classDef custom fill:red','cssClass "A" custom','%%{init: {}}']){
    reject(source(`class A {\n${member}\n}`));
    assert.equal(validateClassModel({kind:'class',classes:[{...node(),attributes:[member]}],relationships:[]}),false);
  }
});

test('data and file identifiers in simple typed fields and parameter lists are inert members',()=>{
  const attributes=['+data: string','+data:string','+file: File','-file:File[]'];
  const operations=['+load(file: File): Result','+get(data: Data): Result','+load(file:File):Result','+get(data:Data):Result','+put(data: Data, file: File[]): Result'];
  const result=accept(source(`class A {\n${[...attributes,...operations].join('\n')}\n}`));
  assert.deepEqual(result.classes[0],{...node(),attributes,operations});
  assert.equal(validateClassModel({kind:'class',classes:[{...node(),attributes,operations}],relationships:[]}),true);
});

test('typed data/file member exceptions do not relax real URIs or nonmember text surfaces',()=>{
  for(const member of ['+data:text/html,example','+data:text/plain,hello','+file:///tmp/value','+file:/tmp/value','+load(file:///tmp/value): Result',
    '+get(data:text/html,example): Result','+get(data:text,hello): Result','+javascript:alert(1)','+vbscript:msgbox(1)',
    '+get(data:Data, javascript:Payload): Result']){
    reject(source(`class A {\n${member}\n}`));
    const kind=member.includes('(')?'operations':'attributes';
    assert.equal(validateClassModel({kind:'class',classes:[{...node(),[kind]:[member]}],relationships:[]}),false);
  }
  for(const text of ['data: string','file: File']){
    reject(source(`class A["${text}"]`));reject(source(`class A\nclass B\nA --> B : ${text}`));
    const name=model();name.classes[0].name=text;assert.equal(validateClassModel(name),false);
    const label=model();label.relationships[0].label=text;assert.equal(validateClassModel(label),false);
  }
});

test('body annotations are exact dedicated syntax rather than HTML or members',()=>{
  for(const annotation of ['interface','abstract','enumeration'] as const){
    const result=accept(source(`class A {\n<<${annotation}>>\nVALUE\nget() String\n}`));
    assert.equal(result.classes[0].annotation,annotation);assert.deepEqual(result.classes[0].attributes,['VALUE']);assert.deepEqual(result.classes[0].operations,['get() String']);
  }
  for(const body of ['<<Interface>>','<<service>>','<<interface>>\n<<interface>>','<interface>','<<interface>> value','+<<interface>>'])reject(source(`class A {\n${body}\n}`));
});

test('all eight relations normalize semantic directions and endpoint multiplicities together',()=>{
  const cases:[string,ClassRelationshipKind,string,string][]=[
    ['<|--','inheritance','B','A'],['--|>','inheritance','A','B'],['*--','composition','A','B'],['--*','composition','B','A'],
    ['o--','aggregation','A','B'],['--o','aggregation','B','A'],['-->','association','A','B'],['<--','association','B','A'],
    ['..>','dependency','A','B'],['<..','dependency','B','A'],['..|>','realization','A','B'],['<|..','realization','B','A'],
    ['--','solid-link','A','B'],['..','dashed-link','A','B']
  ];
  for(const [arrow,kind,from,to] of cases){
    const result=accept(source(`class A\nclass B\nA "1" ${arrow} "0..*" B : uses`));
    assert.deepEqual(result.relationships,[{id:'r1',kind,from,to,fromMultiplicity:from==='A'?'1':'0..*',toMultiplicity:to==='B'?'0..*':'1',label:'uses'}]);
  }
});

test('optional multiplicity and label retain null versus explicit values',()=>{
  for(const [statement,fromMultiplicity,toMultiplicity,label] of [
    ['A --> B',null,null,null],['A "0" --> B','0',null,null],['A --> "999" B : reads',null,'999','reads'],
    ['A "0..999" --> "*" B','0..999','*',null],['A "999..999" --> "999..*" B','999..999','999..*',null]
  ] as const){
    assert.deepEqual(accept(source(`class A\nclass B\n${statement}`)).relationships[0],{...edge(),fromMultiplicity,toMultiplicity,label});
  }
  for(const value of ['','00','01','1000','-1','1.5','many','n','*..1','2..1','0..1000','01..2','1 .. 2','1...2'])reject(source(`class A\nclass B\nA "${value}" --> B`));
  reject(source('class A\nclass B\nA --> B :'));
});

test('equivalent reverse relations are duplicate semantics including attached multiplicities',()=>{
  for(const statements of [
    'A <|-- B\nB --|> A','A "1" *-- "*" B : owns\nB "*" --* "1" A : owns',
    'A "1" -- "*" B : same\nB "*" -- "1" A : same','A .. B\nB .. A', 'A --> B\nA --> B'
  ])reject(source(`class A\nclass B\n${statements}`));
  const result=accept(source('class A\nclass B\nA --> B : first\nA --> B : second\nB --> A : first\nA "1" -- "*" B\nB "1" -- "*" A'));
  assert.equal(result.relationships.length,5);assert.deepEqual(result.relationships.map(value=>value.id),['r1','r2','r3','r4','r5']);
});

test('requires unique explicit declarations before any relationship and known nonself endpoints',()=>{
  for(const body of ['','A --> B','class A\nA --> B','class A\nA --> A','class A\nclass A','class A\nclass A {\n}',
    'class A\nclass B\nA --> B\nclass C','class A\nA : +name','class A\nA','class A\nclass A["Changed"]'])reject(source(body));
  for(const id of ['1bad','bad-id','a.b','한글','a'.repeat(65),'class','namespace','click'])reject(source(`class ${id}`));
  assert.equal(accept(source(`class ${'A'.repeat(64)}`)).classes[0].id.length,64);
});

test('unsupported Mermaid commands and syntax never become classes or relations',()=>{
  for(const body of ['namespace N {\nclass A\n}','direction LR','note "hello"','class A:::styled','class A <<interface>>','<<interface>> A',
    'class A\nclick A href "https://example.test"','class A\nlink A "url"','class A\ncallback A "fn"','classDef styled fill:red',
    'style A fill:red','cssClass "A" styled','accTitle: Example','accDescr: Example','%% comment','%%{init: {}}%%','class A;class B',
    'class A~T~','class `A label`','class A { value }','class A {}','class A\n{\nvalue\n}', 'class A {\nclass B\n}',
    'class A {\nvalue\n','class A\n}', 'class A {\nvalue\n} class B'
  ])reject(source(body));
  for(const header of ['classDiagram-v2','ClassDiagram','flowchart TD','---\ntitle: X\n---\nclassDiagram'])reject(`${header}\nclass A`);
  for(const arrow of ['<|--|>','<-->','()--','--()','o--o','-->>','---','...','-*','=>'])reject(source(`class A\nclass B\nA ${arrow} B`));
});

test('rejects generics, classifiers and malformed member method parentheses',()=>{
  for(const member of ['List~Item~ values','~List~Item~ values','get() List~Item~','get()*','get() int*','get()$','field$',
    'get(','get)','get((x))','get()()','()','+()','++name','##name','~~name','+~name','value { nested }','value; other',
    'A --> B','class A','<<abstract>> trailing'])reject(source(`class A {\n${member}\n}`));
});

test('codepoint limits preserve Korean, combining marks, emoji and ZWJ/ZWNJ',()=>{
  const name='😀'.repeat(80),member='한'.repeat(160),label='가'.repeat(160);
  const result=accept(source(`class A["${name}"] {\n${member}\n}\nclass B\nA --> B : ${label}`));
  assert.equal(result.classes[0].name,name);assert.equal(result.classes[0].attributes[0],member);assert.equal(result.relationships[0].label,label);
  reject(source(`class A["${name}x"]`));reject(source(`class A {\n${member}x\n}`));reject(source(`class A\nclass B\nA --> B : ${label}x`));
  for(const text of ['이름 👩‍👩‍👧‍👦','Cafe\u0301','فارسی\u200cنام','Flag 🇰🇷'])assert.equal(accept(source(`class A["${text}"] {\n${text}\n}`)).classes[0].name,text);
});

test('unsafe markup, encodings and actual URI syntax are rejected on displayed text',()=>{
  const values=['<img src=x>','https://example.test','http://example.test','ftp://example.test','javascript:alert(1)','vbscript:msgbox(1)',
    'data:text/html,x','file:///tmp/x','mailto:user@example.test','//example.test','www.example.test','&lt;img&gt;','&#60;','#60;','%3cimg','`label`','a\\b','%%{init: {}}'];
  for(const text of values){
    reject(source(`class A["${text}"]`));reject(source(`class A {\n${text}\n}`));reject(source(`class A\nclass B\nA --> B : ${text}`));
    const value=model();value.classes[0].name=text;assert.equal(validateClassModel(value),false);
  }
  for(const text of ['','  '])reject(source(`class A["${text}"]`));
});

test('invalid XML, hidden controls and all Cf except joiners are rejected before trimming',()=>{
  const unsafe=['\0','\u0007','\u007f','\u0085','\ufffe','\ud800','\udfff','\u00ad','\u0600','\u180e','\u200b','\u2028','\u2029','\u202e','\u2066','\ufeff','\ufff9','\ufffa','\ufffb','\u{e0001}','\u{e0067}'];
  for(const character of unsafe){
    reject(`${character}classDiagram\nclass A`);reject(source(`class A${character}`));
    for(const surface of ['name','attribute','operation','label']){
      const value=model();
      if(surface==='name')value.classes[0].name='safe'+character;
      if(surface==='attribute')value.classes[0].attributes=['safe'+character];
      if(surface==='operation')value.classes[0].operations=['safe()'+character];
      if(surface==='label')value.relationships[0].label='safe'+character;
      assert.equal(validateClassModel(value),false,`${surface} ${character.codePointAt(0)}`);
    }
  }
  for(const character of ['\t','\n','\r']){const value=model();value.classes[0].name='safe'+character;assert.equal(validateClassModel(value),false);}
  reject('classDiagram\rclass A');
});

test('class and relationship cardinalities are bounded for source and direct models',()=>{
  const classes=Array.from({length:10},(_,i)=>`class C${i}`).join('\n');assert.equal(accept(source(classes)).classes.length,10);reject(source(classes+'\nclass Extra'));
  const relationships=Array.from({length:20},(_,i)=>`A --> B : relation ${i}`).join('\n');assert.equal(accept(source(`class A\nclass B\n${relationships}`)).relationships.length,20);reject(source(`class A\nclass B\n${relationships}\nB --> A`));
  assert.equal(validateClassModel({...model(),classes:Array.from({length:11},(_,i)=>node('C'+i)),relationships:[]}),false);
  assert.equal(validateClassModel({...model(),relationships:Array.from({length:21},(_,i)=>({...edge('r'+i),label:String(i)}))}),false);
});

test('member limits combine both compartments per class and across the complete diagram',()=>{
  const attributes=Array.from({length:8},(_,i)=>'field'+i),operations=Array.from({length:8},(_,i)=>'method'+i+'()');
  const body=[...attributes,...operations].join('\n');assert.equal(accept(source(`class A {\n${body}\n}`)).classes[0].operations.length,8);reject(source(`class A {\n${body}\nextra\n}`));
  const classes=Array.from({length:5},(_,i)=>({...node('C'+i),attributes:[...attributes],operations:[...operations]}));
  assert.equal(validateClassModel({kind:'class',classes,relationships:[]}),true);
  assert.equal(validateClassModel({kind:'class',classes:[...classes,{...node('Extra'),attributes:['extra']}],relationships:[]}),false);
  assert.equal(accept(source(Array.from({length:5},(_,i)=>`class C${i} {\n${body}\n}`).join('\n'))).classes.length,5);
  reject(source(Array.from({length:5},(_,i)=>`class C${i} {\n${body}\n}`).join('\n')+'\nclass Extra {\nextra\n}'));
});

test('raw source budgets apply before parsing and diagnostics stay bounded without source reflection',()=>{
  const minimal=source('class A'),exact=minimal+' '.repeat(CLASS_LIMITS.sourceBytes-Buffer.byteLength(minimal));assert.equal(accept(exact).classes.length,1);reject(exact+' ');
  reject('한'.repeat(90000));assert.equal(accept(minimal+'\n'.repeat(1022)).classes.length,1);reject(minimal+'\n'.repeat(1023));
  const result=validateClassDiagram(source('PRIVATE_BAD_INPUT\n'.repeat(100)));assert.equal(result.ok,false);assert.ok(result.issues.length<=32);assert.ok(!JSON.stringify(result).includes('PRIVATE_BAD_INPUT'));
  assert.ok(result.issues.some(issue=>issue.line===2));
  for(const input of [null,undefined,42,{},[]])reject(input as unknown as string);
});

test('direct models require exact fields, enums, canonical text and correct member compartments',()=>{
  assert.equal(validateClassModel(model()),true);
  for(const value of [null,[],{}, {...model(),kind:'uml'}, {...model(),extra:true},{...model(),classes:[]},
    {...model(),classes:[{...node(),extra:true},node('B')]},{...model(),classes:[{...node(),annotation:'service'},node('B')]},
    {...model(),classes:[{...node(),name:new String('A')},node('B')]},{...model(),classes:[{...node(),attributes:['get()']},node('B')]},
    {...model(),classes:[{...node(),operations:['field']},node('B')]},{...model(),classes:[{...node(),attributes:[' field ']},node('B')]},
    {...model(),relationships:[{...edge(),kind:'unknown'}]},{...model(),relationships:[{...edge(),extra:true}]},
    {...model(),relationships:[{...edge(),from:'unknown'}]},{...model(),relationships:[{...edge(),to:'A'}]},
    {...model(),relationships:[{...edge(),label:''}]},{...model(),relationships:[{...edge(),fromMultiplicity:'01'}]},
    {...model(),relationships:[edge(),{...edge(),label:'other'}]}
  ])assert.equal(validateClassModel(value),false);
  for(const key of ['kind','classes','relationships']){const value:Record<string,unknown>={...model()};delete value[key];assert.equal(validateClassModel(value),false);}
  for(const key of ['id','name','annotation','attributes','operations']){const value:Record<string,unknown>={...node()};delete value[key];assert.equal(validateClassModel({...model(),classes:[value,node('B')]}),false);}
  for(const key of ['id','kind','from','to','fromMultiplicity','toMultiplicity','label']){const value:Record<string,unknown>={...edge()};delete value[key];assert.equal(validateClassModel({...model(),relationships:[value]}),false);}
});

test('direct AST semantic duplicates are rejected even with distinct relation IDs',()=>{
  assert.equal(validateClassModel({...model(),classes:[node(),node()]}),false);
  assert.equal(validateClassModel({...model(),relationships:[edge(),edge('r2')]}),false);
  assert.equal(validateClassModel({...model(),relationships:[{...edge(),kind:'solid-link',fromMultiplicity:'1',toMultiplicity:'*'},{...edge('r2'),kind:'solid-link',from:'B',to:'A',fromMultiplicity:'*',toMultiplicity:'1'}]}),false);
});

test('accessors, prototypes, sparse arrays and serialization hooks are rejected without executing them',()=>{
  let called=0;const getter=()=>{called++;throw new Error('PRIVATE_GETTER');};
  const top=model();Object.defineProperty(top,'classes',{enumerable:true,get:getter});assert.equal(validateClassModel(top),false);
  const nested=model();Object.defineProperty(nested.classes[0],'name',{enumerable:true,get:getter});assert.equal(validateClassModel(nested),false);
  const relation=model();Object.defineProperty(relation.relationships[0],'label',{enumerable:true,get:getter});assert.equal(validateClassModel(relation),false);
  const accessorArray=model();Object.defineProperty(accessorArray.classes,'0',{enumerable:true,get:getter});assert.equal(validateClassModel(accessorArray),false);
  const array=model();Object.defineProperty(array.classes,'toJSON',{value:getter});assert.equal(validateClassModel(array),false);
  const extra=model();Object.defineProperty(extra.classes,'extra',{value:true});assert.equal(validateClassModel(extra),false);
  const symbol=model();Object.defineProperty(symbol,Symbol('private'),{value:true});assert.equal(validateClassModel(symbol),false);
  const hidden=model();Object.defineProperty(hidden,'kind',{value:'class',enumerable:false});assert.equal(validateClassModel(hidden),false);
  assert.equal(validateClassModel({...model(),classes:new Array(1)}),false);assert.equal(validateClassModel(Object.assign(Object.create({toJSON:getter}),model())),false);
  class CustomArray<T> extends Array<T>{toJSON(){called++;return [];}}
  assert.equal(validateClassModel({...model(),classes:new CustomArray(node(),node('B'))}),false);
  const cyclic=model();(cyclic.classes as unknown[]).push(cyclic);assert.equal(validateClassModel(cyclic),false);
  assert.equal(called,0);
});

for(const field of ['classes','relationships','attributes','operations'] as const)test(`null-prototype ${field} arrays fail before layout uses array methods`,async()=>{
  const value=model(),array=field==='classes'?value.classes:field==='relationships'?value.relationships:value.classes[0][field];
  Object.setPrototypeOf(array,null);
  assert.equal(validateClassModel(value),false);
  const {layoutClassDiagram}=await import('../web/visualization/uml-class-layout.ts');
  assert.throws(()=>layoutClassDiagram(value),/^Error: INVALID_CLASS_DIAGRAM$/);
});

test('parsing and validation are deterministic and detached without mutating a direct model',()=>{
  const input=source('class A {\n+name: String\nget() String\n}\nclass B\nA --> B'),first=accept(input),second=accept(input);
  assert.deepEqual(first,second);first.classes[0].attributes[0]='mutated';assert.equal(second.classes[0].attributes[0],'+name: String');
  const before=structuredClone(second);assert.equal(validateClassModel(second),true);assert.deepEqual(second,before);
});
