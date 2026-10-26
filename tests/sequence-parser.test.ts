import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMermaid,parseMermaid,parseMermaidDocument} from '../web/visualization/mermaid.ts';
import {parseSequence,validateSequence,validateSequenceDiagram} from '../web/visualization/sequence.ts';
import {SEQUENCE_LIMITS} from '../shared/sequence.ts';
import type {SequenceDiagram,SequenceEvent} from '../shared/sequence.ts';

const source=`sequenceDiagram
actor User as 사용자
participant API as API server
autonumber
User->>+API: 요청
API->>API: Validate
Note over User,API: Locally stored
alt valid
API-->>User: Accepted
else invalid
API-->>User: Rejected
end
API-->>-User: Done`;

test('Mermaid validator accepts the bounded sequence grammar',()=>{
  assert.deepEqual(validateMermaid(source),{ok:true,issues:[]});
});

test('legacy flowchart parse results remain exact',()=>{
  assert.deepEqual(parseMermaid('flowchart LR\n a["Alpha"]\n b["Beta"]\n a -->|Call| b'),{
    nodes:[{id:'a',label:'Alpha',kind:'component'},{id:'b',label:'Beta',kind:'component'}],
    edges:[{from:'a',to:'b',label:'Call'}],direction:'LR'
  });
  assert.throws(()=>parseMermaid(source),/^Error: INVALID_MERMAID$/);
});

const basic=(body='A->>B: Request')=>`sequenceDiagram\nparticipant A\nparticipant B\n${body}`;
const message:SequenceEvent={type:'message',from:'A',to:'B',arrow:'solid',text:'Request'};
const base:SequenceDiagram={kind:'sequence',participants:[{id:'A',label:'A',kind:'participant'},{id:'B',label:'B',kind:'participant'}],autonumber:false,events:[message]};
const invalid=(value:string)=>{
  assert.equal(validateSequence(value).ok,false,value);
  assert.throws(()=>parseSequence(value),/^Error: INVALID_MERMAID$/);
};

test('parses ordered actors, aliases, numbering and normalized shorthand activation',()=>{
  const parsed=parseSequence(source);
  assert.deepEqual(parsed.participants,[{id:'User',label:'사용자',kind:'actor'},{id:'API',label:'API server',kind:'participant'}]);
  assert.equal(parsed.autonumber,true);
  assert.deepEqual(parsed.events.slice(0,4),[
    {type:'message',from:'User',to:'API',arrow:'solid',text:'요청'},
    {type:'activation',participant:'API',action:'activate'},
    {type:'message',from:'API',to:'API',arrow:'solid',text:'Validate'},
    {type:'note',placement:'over',participants:['User','API'],text:'Locally stored'}
  ]);
  assert.deepEqual(parsed.events.slice(-2),[
    {type:'message',from:'API',to:'User',arrow:'dashed',text:'Done'},
    {type:'activation',participant:'API',action:'deactivate'}
  ]);
  assert.equal(validateSequenceDiagram(parsed),true);
  assert.deepEqual(parseMermaidDocument(source),parsed);
  assert.deepEqual(parseMermaidDocument('flowchart TD\n a["A"]'),{kind:'flowchart',graph:parseMermaid('flowchart TD\n a["A"]')});
});

test('preserves self calls, both line styles and left/right/over notes',()=>{
  const parsed=parseSequence(basic('A-->>A: Self\nNote left of A: Left\nnote right of B: Right\nNote over A: One\nNote over B,A: Both'));
  assert.deepEqual(parsed.events,[
    {type:'message',from:'A',to:'A',arrow:'dashed',text:'Self'},
    {type:'note',placement:'left',participants:['A'],text:'Left'},
    {type:'note',placement:'right',participants:['B'],text:'Right'},
    {type:'note',placement:'over',participants:['A'],text:'One'},
    {type:'note',placement:'over',participants:['B','A'],text:'Both'}
  ]);
  assert.equal(validateSequence(basic('Note over A: Documentation')).ok,true);
});

test('normalizes CRLF and surrounding whitespace only for parsing',()=>{
  assert.deepEqual(parseSequence(`\n ${basic()}\n `.replaceAll('\n','\r\n')),base);
  invalid(basic().replace('\n','\r'));
});

test('requires explicit unique safe declarations before events',()=>{
  for(const input of [
    'sequenceDiagram\nA->>B: Implicit',
    basic('A->>C: Unknown'),basic('Note over A,C: Unknown'),basic('activate C\nA->>B: Hi\ndeactivate C'),
    basic('participant A\nA->>B: Duplicate'),basic('A->>B: First\nparticipant C'),
    'sequenceDiagram\nparticipant end\nend->>end: Reserved',
    'sequenceDiagram\nparticipant 1A\n1A->>1A: Invalid',
    `sequenceDiagram\nparticipant ${'A'.repeat(65)}\n${'A'.repeat(65)}->>${'A'.repeat(65)}: Long`,
    basic('Note left of A,B: Bad placement'),basic('Note over A,A: Duplicate'),
    'sequenceDiagram', 'sequenceDiagram\nparticipant A',
    'sequenceDiagram\nparticipant A\nactivate A\ndeactivate A'
  ])invalid(input);
});

test('allows bare numbering only once before useful events',()=>{
  assert.equal(parseSequence('sequenceDiagram\nautonumber\nparticipant A\nA->>A: One').autonumber,true);
  for(const body of ['autonumber\nautonumber\nA->>B: Twice','A->>B: First\nautonumber','autonumber 2\nA->>B: Start','autonumber off\nA->>B: Off'])invalid(basic(body));
});

test('matches nested fragments and only permits their correct branch keywords',()=>{
  const parsed=parseSequence(basic('loop Retry\nalt Good\nA->>B: One\nelse\nopt Maybe\nA-->>B: Two\nend\nend\npar First\nA->>B: Three\nand Second\nB->>A: Four\nend\nend'));
  const starts=parsed.events.filter(event=>event.type==='fragment-start');
  assert.deepEqual(starts.map(event=>event.kind),['loop','alt','opt','par']);
  assert.equal(new Set(starts.map(event=>event.id)).size,4);
  const alt=starts.find(event=>event.kind==='alt')!,par=starts.find(event=>event.kind==='par')!;
  assert.deepEqual(parsed.events.find(event=>event.type==='fragment-branch'&&event.kind==='else'),{type:'fragment-branch',id:alt.id,kind:'else',text:''});
  assert.deepEqual(parsed.events.find(event=>event.type==='fragment-branch'&&event.kind==='and'),{type:'fragment-branch',id:par.id,kind:'and',text:'Second'});
  assert.equal(validateSequenceDiagram(parsed),true);
  for(const body of ['else Bad\nA->>B: Hi','and Bad\nA->>B: Hi','end\nA->>B: Hi','alt X\nA->>B: Hi','opt X\nelse Y\nA->>B: Hi\nend','par X\nelse Y\nA->>B: Hi\nend','alt X\nand Y\nA->>B: Hi\nend'])invalid(basic(body));
});

test('balances stacked activations globally in source order',()=>{
  const body='activate A\nA->>+A: Nested\nalt Success\nA-->>-A: Inner return\nelse Failure\nA-->>B: Notice\nend\ndeactivate A';
  assert.equal(validateSequence(basic(body)).ok,true);
  for(const body of ['deactivate A\nA->>B: Underflow','activate A\nA->>B: Unclosed','A-->>-B: Wrong sender','A->>+B: Start\nB-->>-A: End\ndeactivate B'])invalid(basic(body));
  assert.equal(validateSequence(basic(`${'activate A\n'.repeat(4)}A->>B: At limit\n${'deactivate A\n'.repeat(4)}`)).ok,true);
  invalid(basic(`${'activate A\n'.repeat(5)}A->>B: Too deep\n${'deactivate A\n'.repeat(5)}`));
});

test('rejects unsafe text and unsupported execution, styling and extended syntax',()=>{
  const text=['<script>','<br/>','https://example.test','javascript:alert(1)','//example.test','www.example.test','&lt;img&gt;','&#60;','&#x3c;','#60;','#x3c;','%3Cscript','%% comment','# comment','Done; A->>B: Injected','`code`','[link]','{config}','a\\b','"quoted"','bad\u0000','bad\u000b','bad\u007f','bad\ufffe','bad\ud800'];
  for(const label of text){
    invalid(basic(`A->>B: ${label}`));
    invalid(`sequenceDiagram\nparticipant A as ${label}\nA->>A: Hi`);
    invalid(basic(`Note over A: ${label}`));
    invalid(basic(`loop ${label}\nA->>B: Hi\nend`));
  }
  for(const statement of ['%%{init: {}}%%','%% comment','click A callback','link A: Web @ https://example.test','links A: {}','properties A: {}','create participant C','destroy A','rect blue','critical Section','break Stop','box Team','A->B: Unsupported arrow','A-)B: Async','A-xB: Cross','A<<->>B: Bidirectional','A->>()B: Center'])invalid(basic(statement));
});

test('bounds text in Unicode code points while rejecting empty or malformed text',()=>{
  const label='😀'.repeat(SEQUENCE_LIMITS.text);
  const parsed=parseSequence(basic(`A->>B: ${label}`));
  assert.equal(parsed.events[0].type==='message'&&parsed.events[0].text,label);
  invalid(basic(`A->>B: ${label}x`));
  invalid(basic('A->>B:    '));
  invalid('sequenceDiagram\nparticipant A as    \nA->>A: Hi');
  assert.equal(validateSequenceDiagram({...base,events:[{...message,text:label}]}),true);
  assert.equal(validateSequenceDiagram({...base,events:[{...message,text:label+'x'}]}),false);
});

test('enforces participant and normalized event limits at their boundaries',()=>{
  const declarations=Array.from({length:10},(_,i)=>`participant P${i}`).join('\n');
  assert.equal(validateSequence(`sequenceDiagram\n${declarations}\nP0->>P9: Hi`).ok,true);
  invalid(`sequenceDiagram\n${declarations}\nparticipant P10\nP0->>P9: Hi`);
  assert.equal(validateSequence(basic(Array.from({length:120},()=> 'A->>B: Hi').join('\n'))).ok,true);
  invalid(basic(Array.from({length:121},()=> 'A->>B: Hi').join('\n')));
  assert.equal(validateSequence(basic('A->>+B: Hi\nB-->>-A: Bye\n'.repeat(30))).ok,true);
  invalid(basic('A->>+B: Hi\nB-->>-A: Bye\n'.repeat(31)));
});

test('enforces note, fragment count and nesting limits independently',()=>{
  assert.equal(validateSequence(basic('Note over A: Note\n'.repeat(24))).ok,true);
  invalid(basic('Note over A: Note\n'.repeat(25)));
  assert.equal(validateSequence(basic('loop Iteration\nA->>B: Hi\nend\n'.repeat(16))).ok,true);
  invalid(basic('loop Iteration\nA->>B: Hi\nend\n'.repeat(17)));
  assert.equal(validateSequence(basic('loop X\n'.repeat(4)+'A->>B: Hi\n'+'end\n'.repeat(4))).ok,true);
  invalid(basic('loop X\n'.repeat(5)+'A->>B: Hi\n'+'end\n'.repeat(5)));
});

test('enforces byte and line limits and bounds fixed diagnostics',()=>{
  const exact=basic()+' '.repeat(SEQUENCE_LIMITS.sourceBytes-Buffer.byteLength(basic()));
  assert.equal(validateSequence(exact).ok,true);
  invalid(exact+' ');
  invalid(basic(`A->>B: ${'한'.repeat(90000)}`));
  assert.equal(validateSequence(basic()+'\n'.repeat(1020)).ok,true);
  invalid(basic()+'\n'.repeat(1021));
  const diagnostics=validateSequence(basic(Array.from({length:100},(_,i)=>`unsafe-sensitive-${i}`).join('\n')));
  assert.equal(diagnostics.ok,false);
  assert.ok(diagnostics.issues.length>0&&diagnostics.issues.length<=32);
  assert.equal(JSON.stringify(diagnostics).includes('sensitive'),false);
  assert.ok(diagnostics.issues.every(issue=>/^[A-Z_]+$/.test(issue.code)&&(!issue.line||Number.isSafeInteger(issue.line))));
  assert.equal(validateSequence(null as unknown as string).ok,false);
});

test('validates AST exact keys, data types and all text surfaces without mutation',()=>{
  const snapshot=JSON.stringify(base);
  assert.equal(validateSequenceDiagram(base),true);
  const bad:unknown[]=[null,[],{}, {...base,extra:true},{...base,autonumber:'yes'},{...base,kind:'flowchart'},
    {...base,participants:[{...base.participants[0],extra:true}]},{...base,participants:[{id:'A',label:'A',kind:'node'}]},
    {...base,participants:[{id:'A',label:'<img>',kind:'actor'}]}, {...base,events:[{...message,extra:true}]},
    {...base,events:[{...message,from:'C'}]},{...base,events:[{...message,arrow:'async'}]},
    {...base,events:[{...message,text:'%3Cscript'}]}, {...base,events:[{type:'activation',participant:'A',action:'bad'}]},
    {...base,events:[{type:'note',placement:'left',participants:['A','B'],text:'Bad'}]},
    {...base,events:[{type:'note',placement:'over',participants:['A','A'],text:'Bad'}]},
    {...base,events:[{type:'note',placement:'over',participants:['A'],text:'bad\udfff'}]},
    {...base,events:[{type:'fragment-start',id:'f0',kind:'alt',text:'<img>'},message,{type:'fragment-end',id:'f0'}]},
    {...base,events:[{type:'fragment-start',id:'f0',kind:'alt',text:'Good'},message,{type:'fragment-branch',id:'f0',kind:'else',text:'bad;script'},{type:'fragment-end',id:'f0'}]},
    {...base,events:[{type:'message',from:'A',to:'B',arrow:'solid'}]},
    {...base,events:[{type:'unknown'}]}, {...base,events:[]}
  ];
  for(const value of bad)assert.equal(validateSequenceDiagram(value),false,JSON.stringify(value));
  assert.equal(JSON.stringify(base),snapshot);
  const symbol=Symbol('extra');assert.equal(validateSequenceDiagram({...base,[symbol]:true}),false);
});

test('AST validation independently enforces references, stack identity and budgets',()=>{
  const start:SequenceEvent={type:'fragment-start',id:'f0',kind:'alt',text:'Case'};
  const end:SequenceEvent={type:'fragment-end',id:'f0'};
  const bad:unknown[]=[
    {...base,participants:[base.participants[0],base.participants[0]]},
    {...base,events:[start,message,{...end,id:'wrong'}]},
    {...base,events:[start,message,end,start,message,end]},
    {...base,events:[start,{type:'fragment-branch',id:'f0',kind:'and',text:'Bad'},message,end]},
    {...base,events:[{type:'activation',participant:'A',action:'deactivate'},message]},
    {...base,events:[{type:'activation',participant:'A',action:'activate'},message]},
    {...base,events:Array.from({length:121},()=>message)},
    {...base,events:Array.from({length:25},()=>({type:'note',placement:'over',participants:['A'],text:'Note'}))}
  ];
  for(const value of bad)assert.equal(validateSequenceDiagram(value),false);
});

test('returns detached deterministic ASTs and bounded source line diagnostics',()=>{
  const first=parseSequence(source),second=parseSequence(source);
  assert.deepEqual(first,second);
  first.participants[0].label='Changed';first.events.pop();
  assert.deepEqual(parseSequence(source),second);
  const result=validateSequence(basic('A->>Unknown: Hi'));
  assert.equal(result.ok,false);
  assert.ok(result.issues.some(issue=>issue.line===4));
});

test('rejects coercible enum objects and sparse or extended AST arrays',()=>{
  const sparseNote={type:'note',placement:'over',participants:new Array(1),text:'Sparse'};
  assert.equal(validateSequenceDiagram({...base,events:[sparseNote]}),false);
  assert.equal(validateSequenceDiagram({...base,events:[{type:'note',placement:new String('over'),participants:['A'],text:'Coerced'}]}),false);
  assert.equal(validateSequenceDiagram({...base,events:[{type:'fragment-start',id:'f0',kind:new String('alt'),text:'Coerced'},message,{type:'fragment-end',id:'f0'}]}),false);
  const extraParticipants=Object.assign([...base.participants],{extra:true});
  const extraEvents=Object.assign([...base.events],{extra:true});
  const extraNoteParticipants=Object.assign(['A'],{extra:true});
  assert.equal(validateSequenceDiagram({...base,participants:extraParticipants}),false);
  assert.equal(validateSequenceDiagram({...base,events:extraEvents}),false);
  assert.equal(validateSequenceDiagram({...base,events:[{type:'note',placement:'over',participants:extraNoteParticipants,text:'Extended'}]}),false);
});
