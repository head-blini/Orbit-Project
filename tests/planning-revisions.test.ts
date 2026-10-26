import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {PlanningComparison} from '../shared/planning-revisions.ts';

const input=(next=false)=>({format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Revision fixture',goal:'Keep historical evidence',requirements:next?[{id:'R1',description:'Changed requirement',acceptance_criteria:['New check']},{id:'R3',description:'Added requirement',acceptance_criteria:['Added check']}]:[{id:'R1',description:'Original requirement',acceptance_criteria:['Old check']},{id:'R2',description:'Removed requirement',acceptance_criteria:['Removed check']}],constraints:['No external execution'],open_questions:[],decisions:[]})});
function fixture(path=':memory:'){
  const store=new Store(path),studio=new Studio(store);
  for(const id of ['project-a','project-b'])if(!store.projects().some(p=>p.id===id))store.saveProject({id,name:id,path:'never-accessed',createdAt:new Date().toISOString(),writeEnabled:false});
  const create=(project='project-a')=>studio.mutate(project,'plans',undefined,undefined,{requestId:randomUUID(),input:input()}) as PlanningVersion;
  const approve=(v:PlanningVersion)=>studio.mutate(v.projectId,'plans',v.id,'approve',{expectedRevision:v.revision}) as PlanningVersion;
  const tasks=(v:PlanningVersion)=>studio.mutate(v.projectId,'plans',v.id,'task-drafts',{}) as SavedTask[];
  const revise=(v:PlanningVersion,source=input(true))=>studio.mutate(v.projectId,'plans',v.id,'revisions',{requestId:randomUUID(),expectedRevision:v.revision,input:source}) as PlanningVersion;
  const compare=(target:PlanningVersion,base:PlanningVersion)=>studio.comparePlanning(target.projectId,target.id,base.id) as PlanningComparison;
  const body=(view:PlanningComparison,labels=['R1'])=>({requestId:randomUUID(),baseVersionId:view.base.id,expectedPreviewDigest:view.previewDigest,requirementLabels:labels});
  const replan=(target:PlanningVersion,data:object)=>studio.mutate(target.projectId,'plans',target.id,'replan',data as Record<string,unknown>) as SavedTask[];
  return {store,studio,create,approve,tasks,revise,compare,body,replan};
}
test('planning comparison and selected follow-up preserve old records and partial tasks survive all-task generation',()=>{
  const f=fixture();try{
    const base=f.approve(f.create()),old=f.tasks(base),snapshot=structuredClone(old),next=f.revise(base),draft=f.compare(next,base);
    assert.equal(draft.canReplan,false);assert.equal(draft.affectedTasks.length,2);assert.deepEqual(draft.availableLabels,['R1','R3']);
    assert.throws(()=>f.replan(next,f.body(draft)),/NOT_APPROVED/);
    const approved=f.approve(next),view=f.compare(approved,base);assert.equal(view.canReplan,true);assert.equal(view.targetCurrent,true);
    const created=f.replan(approved,f.body(view));assert.equal(created.length,1);assert.equal(created[0].description,'Changed requirement');assert.equal(created[0].state,'draft');assert.equal(created[0].verification,'not_run');assert.deepEqual(created[0].replannedFrom,{planningVersionId:base.id,taskIds:[old[0].id]});
    assert.notEqual(created[0].id,old[0].id);assert.deepEqual((f.studio.read('project-a','tasks') as SavedTask[]).filter(t=>t.planningVersionId===base.id),snapshot);
    const all=f.tasks(approved);assert.equal(all.length,2);assert.deepEqual(all.find(t=>t.id===created[0].id),created[0]);assert.equal(new Set(all.map(t=>t.id)).size,2);
    assert.deepEqual(f.tasks(approved),all);assert.equal(f.store.runs().length,0);assert.equal(f.store.projects()[0].writeEnabled,false);
    assert.throws(()=>f.studio.execution('project-a',old[0].id),/PLANNING_VERSION_STALE/);assert.equal(f.studio.execution('project-a',created[0].id).planningVersionId,approved.id);
    assert.doesNotMatch(JSON.stringify(f.store.eventsAfter(0)),/Changed requirement|Original requirement/);
  }finally{f.store.close();}
});
test('replan rejects stale previews, foreign versions, invalid selections and unresolved questions',()=>{
  const f=fixture();try{
    const base=f.approve(f.create());f.tasks(base);const next=f.approve(f.revise(base)),view=f.compare(next,base);
    for(const labels of [[],['R1','R1'],['R2'],['foreign'],Array(101).fill('R1'),['R1',4]])assert.throws(()=>f.replan(next,f.body(view,labels as string[])),/INVALID_FIELDS|INVALID_REQUIREMENT_SELECTION/);
    assert.throws(()=>f.replan(next,{...f.body(view),expectedPreviewDigest:'0'.repeat(64)}),/PLANNING_PREVIEW_STALE/);
    assert.throws(()=>f.compare(next,f.create('project-b')),/VERSION_NOT_FOUND/);
    assert.throws(()=>f.compare(next,f.create()),/PLANNING_COMPARISON_SCOPE/);
    f.replan(next,f.body(view));assert.throws(()=>f.replan(next,f.body(view,['R3'])),/PLANNING_PREVIEW_STALE/);
    const refreshed=f.compare(next,base);assert.deepEqual(refreshed.existingLabels,['R1']);const added=f.replan(next,f.body(refreshed,['R3']));assert.deepEqual(added[0].replannedFrom,{planningVersionId:base.id,taskIds:[]});
    const newer=f.revise(next);assert.equal(f.compare(next,base).targetCurrent,false);assert.throws(()=>f.replan(next,f.body(f.compare(next,base))),/PLANNING_VERSION_STALE/);
    const questions=JSON.parse(input(true).text);questions.open_questions=['Needs decision'];const pending=f.approve(f.revise(newer,{...input(true),text:JSON.stringify(questions)}));
    assert.equal(f.compare(pending,base).canReplan,false);assert.throws(()=>f.replan(pending,f.body(f.compare(pending,base))),/UNRESOLVED_QUESTIONS/);
  }finally{f.store.close();}
});
test('replan receipt returns the same tasks after restart and canonical property order without a new audit',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-replan-'));let f=fixture(join(root,'test.sqlite'));
  try{
    const base=f.approve(f.create());f.tasks(base);const next=f.approve(f.revise(base)),body=f.body(f.compare(next,base),['R3','R1']),result=f.replan(next,body),seq=f.store.lastSeq();
    f.store.close();f=fixture(join(root,'test.sqlite'));
    assert.deepEqual(f.replan(next,{requirementLabels:['R1','R3'],expectedPreviewDigest:body.expectedPreviewDigest,baseVersionId:body.baseVersionId,requestId:body.requestId}),result);
    assert.equal(f.store.lastSeq(),seq);assert.equal((f.studio.read('project-a','tasks') as SavedTask[]).length,4);assert.equal(f.store.runs().length,0);
    assert.throws(()=>f.replan(next,{...body,requirementLabels:['R1']}),/IDEMPOTENCY_CONFLICT/);
  }finally{f.store.close();rmSync(root,{recursive:true,force:true});}
});
test('replan task failure rolls back task records, receipts and audit, and retry keeps old task IDs',()=>{
  const f=fixture();try{
    const base=f.approve(f.create()),old=f.tasks(base),next=f.approve(f.revise(base)),body=f.body(f.compare(next,base)),seq=f.store.lastSeq();
    f.store.db.exec("CREATE TRIGGER fail_replan BEFORE INSERT ON planning_tasks BEGIN SELECT RAISE(ABORT,'synthetic replan failure'); END;");
    assert.throws(()=>f.replan(next,body),/synthetic replan failure/);assert.equal(f.store.lastSeq(),seq);assert.deepEqual(f.studio.read('project-a','tasks'),old);assert.equal(f.store.db.prepare('SELECT request_id FROM studio_requests WHERE request_id=?').get(body.requestId),undefined);
    f.store.db.exec('DROP TRIGGER fail_replan');assert.equal(f.replan(next,body).length,1);assert.equal(f.store.lastSeq(),seq+1);
  }finally{f.store.close();}
});
test('new predecessor tasks invalidate a preview even when unchanged requirements have no impact rows',()=>{
  const f=fixture();try{
    const base=f.approve(f.create()),next=f.approve(f.revise(base,input(false))),view=f.compare(next,base);
    assert.equal(view.affectedTasks.length,0);f.tasks(base);
    assert.throws(()=>f.replan(next,f.body(view)),/PLANNING_PREVIEW_STALE/);
    const refreshed=f.compare(next,base);assert.notEqual(refreshed.previewDigest,view.previewDigest);
    const created=f.replan(next,f.body(refreshed));assert.equal(created[0].replannedFrom?.taskIds.length,1);
  }finally{f.store.close();}
});
