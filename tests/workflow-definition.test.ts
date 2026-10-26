import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowDefinition } from '../shared/workflows.ts';
import { AppError } from '../server/errors.ts';
import { normalizeWorkflowDefinition,workflowStepOrder } from '../server/workflow-definition.ts';

const step=(id:string,dependsOn:string[]=[],commandId='test')=>({id,commandId,dependsOn});
const definition=():WorkflowDefinition=>({name:'  Local verification  ',steps:[step('lint',[],'lint'),step('test',['lint']),step('build',['test'],'build')]});
const invalid=(value:unknown)=>value instanceof AppError&&value.message==='INVALID_WORKFLOW_DEFINITION'&&value.status===400;
const rejects=(value:unknown)=>assert.throws(()=>normalizeWorkflowDefinition(value),invalid);

test('normalizes name and returns deeply frozen independent definition without mutating input',()=>{
  const input=definition(),before=structuredClone(input),result=normalizeWorkflowDefinition(input);
  assert.deepEqual(result,{...before,name:'Local verification'});assert.deepEqual(input,before);
  assert.notEqual(result,input);assert.notEqual(result.steps,input.steps);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.steps));
  for(let index=0;index<result.steps.length;index++){
    assert.notEqual(result.steps[index],input.steps[index]);assert.notEqual(result.steps[index].dependsOn,input.steps[index].dependsOn);
    assert.ok(Object.isFrozen(result.steps[index])&&Object.isFrozen(result.steps[index].dependsOn));
  }
  input.name='changed';input.steps[0].commandId='changed';input.steps[1].dependsOn.push('changed');input.steps.push(step('extra'));
  assert.deepEqual(result,{...before,name:'Local verification'});
  assert.throws(()=>{result.steps[0].dependsOn.push('changed');},TypeError);
});

test('deterministic topological order uses declaration priority for every currently available step',()=>{
  const input:WorkflowDefinition={name:'Order',steps:[step('after',['first']),step('first'),step('other'),step('last',['after','other'])]},before=structuredClone(input);
  assert.deepEqual(workflowStepOrder(input),['first','after','other','last']);assert.deepEqual(input,before);
  const order=workflowStepOrder(input);order.reverse();assert.deepEqual(workflowStepOrder(input),['first','after','other','last']);
  assert.deepEqual(workflowStepOrder({name:'Roots',steps:[step('third'),step('first'),step('second')]}),['third','first','second']);
});

test('reverse declarations and multiple prerequisites remain valid without sorting or rewriting dependencies',()=>{
  const input={name:'Reverse',steps:[step('finish',['second','first']),step('second',['start']),step('first',['start']),step('start')]};
  const normalized=normalizeWorkflowDefinition(input);assert.deepEqual(normalized.steps[0].dependsOn,['second','first']);
  assert.deepEqual(workflowStepOrder(normalized),['start','second','first','finish']);
});

test('exact size boundaries accept twelve steps, 64-character IDs and a 120-character trimmed name',()=>{
  const id='x'.repeat(64),input={name:' '+ '한'.repeat(120)+' ',steps:[step(id,[],'c'.repeat(64)),...Array.from({length:11},(_,index)=>step('s'+index,[index===0?id:'s'+(index-1)]))]};
  const result=normalizeWorkflowDefinition(input);assert.equal(result.name.length,120);assert.equal(result.steps.length,12);assert.equal(workflowStepOrder(result).length,12);
  rejects({...input,name:'x'.repeat(121)});rejects({...input,steps:[...input.steps,step('thirteenth')]});rejects({name:'none',steps:[]});
  rejects({name:'long id',steps:[step('x'.repeat(65))]});rejects({name:'long command',steps:[step('one',[],'c'.repeat(65))]});
});

test('rejects missing/self/duplicate dependencies, duplicate step IDs and cycles including disconnected cycles',()=>{
  for(const steps of [[step('one',['absent'])],[step('one',['one'])],[step('one'),step('two',['one','one'])],
    [step('same'),step('same')],[step('one',['two']),step('two',['one'])],
    [step('root'),step('one',['two']),step('two',['one'])]]){
    const input={name:'Invalid DAG',steps};rejects(input);assert.throws(()=>workflowStepOrder(input),invalid);
  }
});

test('name control characters and known credential patterns in every public string are rejected with fixed errors',()=>{
  for(const name of ['', '   ', 'line\nname', '\tName', 'bad\0name','bad\u001bname','bad\u007fname','api_key=fixturetoken','Bearer fixturetoken','glpat-fixturetoken'])rejects({...definition(),name});
  for(const sensitive of ['sk-fixturetoken','glpat-fixturetoken','ghp_fixturetoken']){
    rejects({name:sensitive,steps:[step('one')]});rejects({name:'Safe',steps:[step(sensitive)]});
    rejects({name:'Safe',steps:[step('one',[],sensitive)]});rejects({name:'Safe',steps:[step('one',[sensitive])]});
  }
});

test('step and command IDs are exact safe ASCII references rather than commands or paths',()=>{
  for(const value of ['', ' padded', 'padded ', '../outside', '/bin/test','C:\\tool','npm test','node.exe','--test','$(command)','a;b','한글','a\nnext','a\0b']){
    rejects({name:'Safe',steps:[step(value)]});rejects({name:'Safe',steps:[step('one',[],value)]});rejects({name:'Safe',steps:[step('one',[value])]});
  }
  assert.deepEqual(workflowStepOrder({name:'Safe identifiers',steps:[step('constructor',[],'toString'),step('hasOwnProperty',['constructor'],'build_1-OK')]}),['constructor','hasOwnProperty']);
});

test('rejects arbitrary prototypes and unknown authority, executable, path, or environment fields',()=>{
  for(const input of [null,42,'text',[],{},Object.assign(Object.create({inherited:true}),definition()),
    {...definition(),projectId:'forged'},{...definition(),approved:true},{...definition(),steps:[{...step('one'),command:'node'}]},
    {...definition(),steps:[{...step('one'),cwd:'private-path'}]},{...definition(),steps:[{...step('one'),env:{PRIVATE:'value'}}]},
    {...definition(),steps:[Object.assign(Object.create({inherited:true}),step('one'))]}])rejects(input);
  const plain=Object.assign(Object.create(null),{name:'Null prototype',steps:[Object.assign(Object.create(null),step('one'))]});
  assert.equal(normalizeWorkflowDefinition(plain).name,'Null prototype');
});

test('getters, serialization hooks and sparse/accessor arrays are rejected without invoking them',()=>{
  let invoked=0;const top=definition();Object.defineProperty(top,'name',{enumerable:true,get(){invoked++;throw new Error('PRIVATE_VALUE');}});rejects(top);
  const nested=step('one');Object.defineProperty(nested,'commandId',{enumerable:true,get(){invoked++;return 'test';}});rejects({name:'Safe',steps:[nested]});
  const source=definition();Object.defineProperty(source,'toJSON',{value(){invoked++;throw new AppError('PRIVATE_VALUE',500);}});rejects(source);
  const steps=[step('one')];Object.defineProperty(steps,'0',{get(){invoked++;return step('one');}});rejects({name:'Safe',steps});
  const dependencies=['one'];Object.defineProperty(dependencies,'0',{get(){invoked++;return 'one';}});rejects({name:'Safe',steps:[step('one'),step('two',dependencies)]});
  rejects({name:'Sparse',steps:new Array(2)});rejects({name:'Sparse dependencies',steps:[step('one'),step('two',new Array(1))]});
  assert.equal(invoked,0);
});

test('arrays must have only contiguous data entries and the ordinary Array prototype',()=>{
  const extra=[step('one')];Object.defineProperty(extra,'extra',{value:'private'});rejects({name:'Safe',steps:extra});
  const symbol=[step('one')];Object.defineProperty(symbol,Symbol('private'),{value:true});rejects({name:'Safe',steps:symbol});
  class CustomArray<T> extends Array<T>{}
  rejects({name:'Safe',steps:new CustomArray(step('one'))});rejects({name:'Safe',steps:[step('one'),step('two',new CustomArray('one'))]});
  const depends=['one'];Object.defineProperty(depends,'extra',{value:true});rejects({name:'Safe',steps:[step('one'),step('two',depends)]});
  for(const dependsOn of [null,'one',[null],[42],Array.from({length:13},()=> 'one')])rejects({name:'Safe',steps:[step('one'),{id:'two',commandId:'test',dependsOn}]});
});
