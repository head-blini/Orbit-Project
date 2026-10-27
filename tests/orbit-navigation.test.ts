import test from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from '../shared/types.ts';
import { pages,parsePage,resolveProject,workspaceMatchesProject,readPreference,writePreference,projectPreferenceKey } from '../web/navigation.ts';

const projects=[{id:'a',name:'A',path:'a',writeEnabled:true,createdAt:''},{id:'b',name:'B',path:'b',writeEnabled:false,createdAt:''}];
const state:Snapshot={provider:'ready',issue:null,threadId:null,workspace:'fixture',readOnly:false,runs:[],lastSeq:0,selectedWorkspaceId:'wa',projects,workspaces:[{id:'wa',projectId:'a',path:'fixture',branch:'a',baseSha:'sha',createdAt:'',status:'ready'}]};
test('the beginner start page is the default while all advanced page URLs survive refresh',()=>{
  assert.equal(pages.length,13);assert.equal(new Set(pages.map(page=>page.id)).size,13);
  for(const page of pages)assert.equal(parsePage('#/'+page.id),page.id);
  for(const hash of ['','#/not-a-page','#/%FF','#/../../agents','#/agents?run=true'])assert.equal(parsePage(hash),'start');
});
test('project preference survives a new read without editing unrelated settings',()=>{
  const values=new Map([['existing-setting','keep']]);
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
  writePreference(storage,projectPreferenceKey,'b');
  assert.equal(resolveProject(projects,readPreference(storage,projectPreferenceKey),state),'b');
  assert.equal(values.get('existing-setting'),'keep');
  assert.equal(resolveProject(projects,'deleted-project',state),'a');
  assert.equal(resolveProject([],'deleted-project',null),'');
});
test('browser storage refusal does not prevent in-memory navigation',()=>{
  const blocked={getItem:()=>{throw new Error('SecurityError');},setItem:()=>{throw new Error('QuotaExceeded');}};
  assert.equal(readPreference(blocked,projectPreferenceKey),'');
  assert.doesNotThrow(()=>writePreference(blocked,projectPreferenceKey,'b'));
});
test('selected planning project cannot connect or submit in a foreign or unready worktree',()=>{
  assert.equal(workspaceMatchesProject(state,'a'),true);
  assert.equal(workspaceMatchesProject(state,'b'),false);
  assert.equal(workspaceMatchesProject({...state,workspaces:state.workspaces!.map(workspace=>({...workspace,status:'failed'}))},'a'),false);
  assert.equal(workspaceMatchesProject(state,''),false);
  assert.equal(workspaceMatchesProject(null,''),false);
});
test('registered planning-only projects do not remove access to the existing read-only test session',()=>{
  const readOnly={...state,selectedWorkspaceId:null,readOnly:true};
  const selected=resolveProject(projects,'__readonly__',readOnly);
  assert.equal(selected,'');
  assert.equal(workspaceMatchesProject(readOnly,selected),true);
  assert.equal(resolveProject(projects,'__readonly__',state),'a','a preference cannot pretend to switch the authoritative server workspace');
});
