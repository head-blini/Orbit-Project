import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {parsePlanningDraft} from '../server/planning/parser.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';

const document=()=>({schema_version:'1.0',title:'Metadata fixture',goal:'Preserve design intent',
  requirements:[{id:'R1',description:'Keep local state',acceptance_criteria:['State restores']}],constraints:['No external calls'],open_questions:[],
  decisions:[{topic:'Storage',decision:'Use SQLite',rationale:'Offline operation'}],
  source:{kind:'external_web',provider_id:'user-supplied-provider',external_url:'https://example.invalid/planning',author:'Fixture Author',references:[{title:'Design record',url:'https://example.invalid/design'}]}});
const input=(value:object)=>({format:'json',source:'import',text:JSON.stringify(value)});
const approve=(studio:Studio,version:PlanningVersion)=>studio.mutate('project-a','plans',version.id,'approve',{expectedRevision:version.revision}) as PlanningVersion;
const create=(studio:Studio,value:object)=>studio.mutate('project-a','plans',undefined,undefined,{requestId:randomUUID(),input:input(value)}) as PlanningVersion;
const revise=(studio:Studio,version:PlanningVersion,value:object)=>studio.mutate('project-a','plans',version.id,'revisions',{requestId:randomUUID(),expectedRevision:version.revision,input:input(value)}) as PlanningVersion;

test('decisions and attribution survive SQLite approval, comparison, export and restart without runs or audit text',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-plan-metadata-')),path=join(root,'test.sqlite');let store=new Store(path),studio=new Studio(store);
  try{
    store.saveProject({id:'project-a',name:'fixture',path:'never-accessed',createdAt:'',writeEnabled:false});
    const original=approve(studio,create(studio,document()));
    const [oldTask]=studio.mutate('project-a','plans',original.id,'task-drafts',{}) as SavedTask[];
    assert.deepEqual(original.draft.decisions,[{topic:'Storage',decision:'Use SQLite',rationale:'Offline operation'}]);
    assert.deepEqual(original.draft.provenance,{kind:'external_web',providerId:'user-supplied-provider',externalUrl:'https://example.invalid/planning',author:'Fixture Author',references:[{title:'Design record',url:'https://example.invalid/design'}]});
    assert.match(studio.execution('project-a',oldTask.id).prompt,/Use SQLite/);
    assert.doesNotMatch(studio.execution('project-a',oldTask.id).prompt,/user-supplied-provider|Fixture Author|example.invalid/);
    const attributed=document();attributed.source.author='Revised Author';const metadataOnly=approve(studio,revise(studio,original,attributed));
    const attributionDiff=studio.comparePlanning('project-a',metadataOnly.id,original.id);
    assert.deepEqual(attributionDiff.fields.map(row=>row.field),['provenance']);assert.equal(attributionDiff.affectedTasks.length,0);
    const updated=document();updated.decisions[0].decision='Use existing SQLite adapter';const current=approve(studio,revise(studio,metadataOnly,updated));
    const comparison=studio.comparePlanning('project-a',current.id,original.id);
    assert.deepEqual(comparison.fields.map(row=>row.field),['decisions']);assert.deepEqual(comparison.affectedTasks.map(row=>row.taskId),[oldTask.id]);
    const [followup]=studio.mutate('project-a','plans',current.id,'replan',{requestId:randomUUID(),baseVersionId:original.id,expectedPreviewDigest:comparison.previewDigest,requirementLabels:['R1']}) as SavedTask[];
    assert.deepEqual(followup.replannedFrom,{planningVersionId:original.id,taskIds:[oldTask.id]});
    assert.match(studio.execution('project-a',followup.id).prompt,/Use existing SQLite adapter/);
    for(const format of ['json','markdown'] as const){
      const exported=studio.exportPlanning('project-a',original.id,original.revision,original.contentHash,format);
      assert.deepEqual(parsePlanningDraft({format,text:exported.bytes.toString('utf8'),source:'import'}),{ok:true,draft:original.draft});
    }
    const before=studio.read('project-a','plans'),tasks=studio.read('project-a','tasks'),seq=store.lastSeq();store.close();store=new Store(path);studio=new Studio(store);
    assert.deepEqual(studio.read('project-a','plans'),before);assert.deepEqual(studio.read('project-a','tasks'),tasks);assert.equal(store.lastSeq(),seq);
    assert.match(studio.execution('project-a',followup.id).prompt,/Use existing SQLite adapter/);
    assert.equal(store.runs().length,0);assert.equal(store.projects()[0].writeEnabled,false);
    assert.doesNotMatch(JSON.stringify(store.eventsAfter(0)),/Fixture Author|Revised Author|Offline operation|example.invalid|user-supplied-provider/);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('legacy stored drafts keep exact content and approval while incomplete decisions remain unapproved',()=>{
  const store=new Store(':memory:'),studio=new Studio(store);
  try{
    store.saveProject({id:'project-a',name:'fixture',path:'never-accessed',createdAt:'',writeEnabled:false});
    const legacy={...document(),decisions:[],source:{kind:'file',provider_id:null,external_url:null}};
    const old=approve(studio,create(studio,legacy)),snapshot=structuredClone(old);
    assert.equal(Object.hasOwn(old.draft,'decisions'),false);assert.equal(Object.hasOwn(old.draft,'provenance'),false);
    const [task]=studio.mutate('project-a','plans',old.id,'task-drafts',{}) as SavedTask[];
    assert.doesNotThrow(()=>studio.execution('project-a',task.id));
    const broken=document();broken.decisions[0].rationale='';const next=revise(studio,old,broken);
    assert.equal(next.state,'draft');assert.throws(()=>approve(studio,next),/INCOMPLETE_DRAFT/);
    assert.throws(()=>studio.mutate('project-a','plans',next.id,'task-drafts',{}),/NOT_APPROVED/);
    assert.deepEqual((studio.read('project-a','plans') as PlanningVersion[]).find(v=>v.id===old.id),snapshot);
    assert.equal(store.runs().length,0);
  }finally{store.close();}
});
