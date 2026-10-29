import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {TaskGraphService,deriveTaskGraphState} from '../server/task-graph.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
import type {TaskGraphInput,TaskGraphFacts} from '../shared/task-graph.ts';

const input={format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Research and code',goal:'Produce checked artifacts',requirements:['Research sources','Write report','Write parser'].map((description,i)=>({id:`R${i+1}`,description,acceptance_criteria:['Check output']})),constraints:['No external calls'],open_questions:[]})};
function fixture(path=':memory:'){
  const store=new Store(path),studio=new Studio(store),service=new TaskGraphService(store);
  for(const id of ['project-a','project-b'])if(!store.projects().some(p=>p.id===id))store.saveProject({id,name:id,kind:'general',path:'never-accessed',createdAt:new Date().toISOString(),writeEnabled:false});
  const create=(projectId='project-a')=>studio.mutate(projectId,'plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
  const approve=(v:PlanningVersion)=>studio.mutate(v.projectId,'plans',v.id,'approve',{expectedRevision:v.revision}) as PlanningVersion;
  const tasks=(v:PlanningVersion)=>studio.mutate(v.projectId,'plans',v.id,'task-drafts',{}) as SavedTask[];
  const revise=(v:PlanningVersion)=>studio.mutate(v.projectId,'plans',v.id,'revisions',{requestId:randomUUID(),expectedRevision:v.revision,input}) as PlanningVersion;
  const version=approve(create()),saved=tasks(version),[a,b,c]=saved.map(t=>t.id);
  const graph:TaskGraphInput={planningVersionId:version.id,contentHash:version.contentHash,expectedRevision:0,nodes:saved.map(t=>({taskId:t.id})),edges:[{taskId:b,dependsOn:a},{taskId:c,dependsOn:b}]};
  const facts:TaskGraphFacts={verifiedDoneIds:[],blocked:[]};
  return {store,studio,service,version,saved,a,b,c,graph,facts,create,approve,tasks,revise};
}

test('rejects cycles, self edges, unknown endpoints and duplicate topology without writing revisions',()=>{
  const f=fixture();try{
    for(const [edges,code] of [
      [[...f.graph.edges,{taskId:f.a,dependsOn:f.c}],'TASK_GRAPH_CYCLE'],
      [[{taskId:f.a,dependsOn:f.a}],'TASK_GRAPH_SELF_EDGE'],
      [[{taskId:f.a,dependsOn:'missing'}],'TASK_GRAPH_UNKNOWN_TASK'],
      [[f.graph.edges[0],f.graph.edges[0]],'TASK_GRAPH_DUPLICATE_EDGE'],
    ] as const)assert.throws(()=>f.service.save('project-a',{...f.graph,edges:[...edges]}),new RegExp(code));
    assert.throws(()=>f.service.save('project-a',{...f.graph,nodes:[f.graph.nodes[0],f.graph.nodes[0]]}),/TASK_GRAPH_DUPLICATE_NODE/);
    assert.deepEqual(f.service.history('project-a',f.version.id),[]);
  }finally{f.store.close();}
});
test('rejects tasks from another version or project, unknown tasks, draft plans and mismatched hashes',()=>{
  const f=fixture();try{
    for(const v of [f.approve(f.create()),f.approve(f.create('project-b'))]){
      const foreign=f.tasks(v)[0];
      assert.throws(()=>f.service.save('project-a',{...f.graph,nodes:[{taskId:foreign.id}],edges:[]}),/TASK_GRAPH_UNKNOWN_TASK|TASK_GRAPH_TASK_SCOPE/);
    }
    assert.throws(()=>f.service.save('project-b',f.graph),/VERSION_NOT_FOUND/);
    assert.throws(()=>f.service.save('project-a',{...f.graph,nodes:[{taskId:'missing'}],edges:[]}),/TASK_GRAPH_UNKNOWN_TASK/);
    assert.throws(()=>f.service.save('project-a',{...f.graph,contentHash:'0'.repeat(64)}),/TASK_GRAPH_BASELINE_CHANGED/);
    const draft=f.create();assert.throws(()=>f.service.save('project-a',{...f.graph,planningVersionId:draft.id,contentHash:draft.contentHash,nodes:[],edges:[]}),/NOT_APPROVED/);
  }finally{f.store.close();}
});
test('expectedRevision serializes writers and old revisions remain immutable across restart',()=>{
  const root=mkdtempSync(join(tmpdir(),'orbit-tg-')),path=join(root,'test.sqlite');const f=fixture(path);
  let reopened:Store|undefined,closed=false;
  try{
    const first=f.service.save('project-a',f.graph),original=structuredClone(first);
    assert.equal(first.revision,1);
    const peerStore=new Store(path);try{
      const peer=new TaskGraphService(peerStore);
      const second=peer.save('project-a',{...f.graph,expectedRevision:1,edges:[]});assert.equal(second.revision,2);
      assert.throws(()=>f.service.save('project-a',{...f.graph,expectedRevision:1}),/REVISION_CONFLICT/);
    }finally{peerStore.close();}
    first.nodes.length=0;assert.deepEqual(f.service.read('project-a',f.version.id,1),original);
    f.store.close();closed=true;reopened=new Store(path);const service=new TaskGraphService(reopened);
    assert.deepEqual(service.history('project-a',f.version.id).map(g=>g.revision),[1,2]);
    assert.deepEqual(service.read('project-a',f.version.id,1),original);assert.equal(service.read('project-a',f.version.id).revision,2);
    assert.throws(()=>service.read('project-b',f.version.id),/TASK_GRAPH_NOT_FOUND/);
  }finally{reopened?.close();if(!closed)f.store.close();rmSync(root,{recursive:true,force:true});}
});
test('readiness uses verified ids only, reports all waiting predecessors and explicit blockers',()=>{
  const f=fixture();try{
    f.service.save('project-a',{...f.graph,edges:[...f.graph.edges,{taskId:f.c,dependsOn:f.a}]});
    assert.deepEqual(f.service.view('project-a',f.version.id,f.facts).nodes,[{taskId:f.a,state:'ready'},{taskId:f.b,state:'waiting',predecessors:[f.a]},{taskId:f.c,state:'waiting',predecessors:[f.b,f.a]}]);
    const facts={verifiedDoneIds:[f.a],blocked:[{taskId:f.b,reasonCodes:['QUOTA_WAIT','APPROVAL_REQUIRED']}]};
    assert.deepEqual(f.service.view('project-a',f.version.id,facts).nodes,[{taskId:f.a,state:'done'},{taskId:f.b,state:'blocked',reasonCodes:['QUOTA_WAIT','APPROVAL_REQUIRED']},{taskId:f.c,state:'waiting',predecessors:[f.b]}]);
    assert.deepEqual(f.service.view('project-a',f.version.id,{verifiedDoneIds:[f.a,f.b],blocked:[]}).nodes.map(n=>n.state),['done','done','ready']);
    assert.deepEqual(f.service.view('project-a',f.version.id,{verifiedDoneIds:[f.a,f.b,f.c],blocked:[]}).nodes.map(n=>n.state),['done','done','done']);
    assert.deepEqual(f.service.view('project-a',f.version.id,{verifiedDoneIds:[f.a],blocked:[{taskId:f.a,reasonCodes:['RECHECK_REQUIRED']}]}).nodes.map(n=>n.state),['blocked','waiting','waiting']);
  }finally{f.store.close();}
});
test('superseded planning head makes even verified nodes stale without rebinding or changing history',()=>{
  const f=fixture();try{
    const graph=f.service.save('project-a',f.graph);f.revise(f.version);
    assert.equal((f.studio.read('project-a','plans') as PlanningVersion[]).find(v=>v.id===f.version.id)!.state,'approved');
    const view=f.service.view('project-a',f.version.id,{verifiedDoneIds:[f.a,f.b,f.c],blocked:[]});
    assert.equal(view.stale,true);assert.ok(view.nodes.every(n=>n.state==='stale'));
    assert.deepEqual(f.service.read('project-a',f.version.id),graph);
    assert.throws(()=>f.service.save('project-a',{...f.graph,expectedRevision:1}),/TASK_GRAPH_BASELINE_CHANGED/);
    assert.deepEqual(deriveTaskGraphState(graph,{version:{...f.version,state:'superseded'},currentVersionId:f.version.id},f.facts).nodes.map(n=>n.state),['stale','stale','stale']);
    assert.equal(deriveTaskGraphState(graph,{version:{...f.version,contentHash:'0'.repeat(64)},currentVersionId:f.version.id},f.facts).stale,true);
    assert.equal(deriveTaskGraphState(graph,{version:null,currentVersionId:null},f.facts).stale,true);
  }finally{f.store.close();}
});
test('contracts and declarative impact scope roundtrip without copying task content or executing anything',()=>{
  const f=fixture();try{
    const contracts=[{id:'report-format',digest:'sha256:example'}],impactScope={files:['src/**'],resources:['reports/*']};
    const graph=f.service.save('project-a',{...f.graph,nodes:[{taskId:f.a,contracts,impactScope},{taskId:f.b}],edges:[{taskId:f.b,dependsOn:f.a,contracts,impactScope}]});
    contracts[0].digest='changed';impactScope.files.push('other/**');
    assert.equal(graph.nodes[0].contracts![0].digest,'sha256:example');assert.deepEqual(graph.edges[0].impactScope!.files,['src/**']);
    assert.deepEqual(f.service.read('project-a',f.version.id),graph);
    assert.doesNotMatch(JSON.stringify(graph),/Research sources|acceptanceCriteria|Write report/);
    const seq=f.store.lastSeq();f.service.view('project-a',f.version.id,f.facts);f.service.history('project-a',f.version.id);
    assert.equal(f.store.lastSeq(),seq);assert.deepEqual(f.store.runs(),[]);assert.deepEqual(f.studio.read('project-a','tasks'),f.saved);
  }finally{f.store.close();}
});
test('invalid payloads and unscoped facts fail closed',()=>{
  const f=fixture();try{
    for(const patch of [{expectedRevision:-1},{expectedRevision:0.5},{nodes:null},{edges:null},{extra:true},{nodes:[{taskId:f.a,title:'copied'}]},{nodes:[{taskId:f.a,contracts:[{id:'x',digest:''}]}]},{nodes:[{taskId:f.a,impactScope:{files:[4],resources:[]}}]}])assert.throws(()=>f.service.save('project-a',{...f.graph,...patch} as TaskGraphInput),/INVALID_FIELDS/);
    f.service.save('project-a',f.graph);
    for(const facts of [{verifiedDoneIds:['foreign'],blocked:[]},{verifiedDoneIds:[],blocked:[{taskId:f.a,reasonCodes:[]}]},{verifiedDoneIds:[],blocked:[{taskId:f.a,reasonCodes:['not a code']}]},{verifiedDoneIds:[],blocked:[],completedIds:[f.a]}])assert.throws(()=>f.service.view('project-a',f.version.id,facts),/TASK_GRAPH_FACTS_INVALID/);
  }finally{f.store.close();}
});
test('failed revision insertion rolls back and leaves expectedRevision usable',()=>{
  const f=fixture();try{
    const first=f.service.save('project-a',f.graph);
    f.store.db.exec("CREATE TEMP TRIGGER reject_graph BEFORE INSERT ON task_graph_revisions BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    assert.throws(()=>f.service.save('project-a',{...f.graph,expectedRevision:1,edges:[]}),/fixture failure/);
    assert.deepEqual(f.service.history('project-a',f.version.id),[first]);f.store.db.exec('DROP TRIGGER reject_graph');
    assert.equal(f.service.save('project-a',{...f.graph,expectedRevision:1,edges:[]}).revision,2);
  }finally{f.store.close();}
});
test('existing graph cannot adopt a changed hash even if stored plan is replaced under the same id',()=>{
  const f=fixture();try{
    const original=f.service.save('project-a',f.graph),replacement=f.approve(f.create());
    // Simulate a changed baseline record, not an authorized planning operation.
    const changed={...replacement,id:f.version.id,lineageId:f.version.lineageId};
    changed.draft={...changed.draft,title:'Changed baseline'};
    changed.contentHash=createHash('sha256').update(JSON.stringify(changed.draft)).digest('hex');
    f.store.db.prepare('UPDATE planning_versions SET body=? WHERE id=?').run(JSON.stringify(changed),f.version.id);
    assert.equal(f.service.view('project-a',f.version.id,f.facts).stale,true);
    assert.throws(()=>f.service.save('project-a',{...f.graph,contentHash:changed.contentHash,expectedRevision:1}),/TASK_GRAPH_BASELINE_CHANGED/);
    assert.deepEqual(f.service.history('project-a',f.version.id),[original]);
  }finally{f.store.close();}
});
