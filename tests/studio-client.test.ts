import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioMutator,mergeStudioRecords,acceptSnapshot } from '../web/studio-client.ts';
import type { Snapshot } from '../shared/types.ts';

test('uncertain Studio save retains request ID across retry and reload without persisting document text',async()=>{
  const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
  const calls:Record<string,unknown>[]=[];let fail=true;
  const post=async(_path:string,data:Record<string,unknown>)=>{calls.push(data);if(fail)throw new Error('uncertain response');return {id:'saved'};};
  const payload={input:{text:'private planning content'}};
  await assert.rejects(createStudioMutator(post,storage)('/plans',payload));
  assert.equal(JSON.stringify([...values]).includes('private planning content'),false);
  fail=false;await createStudioMutator(post,storage)('/plans',payload);
  assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(values.size,0);
  await createStudioMutator(post,storage)('/plans',payload);assert.notEqual(calls[1].requestId,calls[2].requestId);
});

test('a delayed Studio reload cannot erase an acknowledged create or newer revision',()=>{
  const loaded=[{id:'a',revision:1,source:'old'}];
  const acknowledged=[{id:'a',revision:2,source:'saved'},{id:'b',revision:1,source:'new'}];
  assert.deepEqual(mergeStudioRecords(acknowledged,loaded),acknowledged);
  assert.equal(mergeStudioRecords(loaded,acknowledged)[0].source,'saved');
  assert.deepEqual(mergeStudioRecords([{id:'task-new'}],[{id:'task-old'}]),[{id:'task-new'},{id:'task-old'}]);
});

test('late connection snapshots cannot restore an old workspace or regress streamed state',()=>{
  const current:Snapshot={provider:'ready',issue:null,threadId:null,workspace:'new',readOnly:true,runs:[],lastSeq:10};
  assert.equal(acceptSnapshot(current,{...current,workspace:'old',lastSeq:9},true),current);
  assert.equal(acceptSnapshot(current,{...current,workspace:'old',lastSeq:11},false),current);
  assert.equal(acceptSnapshot(current,{...current,lastSeq:11},true)?.lastSeq,11);
});
