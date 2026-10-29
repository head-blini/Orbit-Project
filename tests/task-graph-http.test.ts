import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHttpServer} from '../server/http.ts';
import type {SavedTask} from '../shared/parallel.ts';
import {claudeFixture,planningInput} from './claude-task-fixture.ts';

async function fixture(){
  const f=claudeFixture(),server=createHttpServer(f.controller,'.');
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
  catch(error){await f.close();throw error;}
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const response=await fetch(origin+'/api/session'),cookie=response.headers.get('set-cookie')!.split(';')[0],{csrfToken}=await response.json() as {csrfToken:string};
  const headers={cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrfToken};
  const get=(path:string)=>fetch(origin+path,{headers});
  const post=(path:string,data:object,extra:Record<string,string>={})=>fetch(origin+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data)});
  return {...f,get,post,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}};
}

test('HTTP task graph saves revisions, reads history and derives state without marking anything done',async()=>{
  const f=await fixture();try{
    const multi={...planningInput,text:JSON.stringify({...JSON.parse(planningInput.text),requirements:[{id:'R1',description:'collect',acceptance_criteria:['a']},{id:'R2',description:'write',acceptance_criteria:['b']}]})};
    const {version}=f.plan(multi),tasks=f.studio.read(f.project.id,'tasks') as SavedTask[];
    const [first,second]=tasks.filter(task=>task.planningVersionId===version.id);
    const base=`/api/projects/${f.project.id}/task-graphs/${version.id}`;
    const graph={contentHash:version.contentHash,expectedRevision:0,nodes:[{taskId:first.id},{taskId:second.id}],edges:[{taskId:second.id,dependsOn:first.id}]};
    assert.equal((await f.post(base+'/revisions',graph,{'X-CSRF-Token':''})).status,403);
    const smuggled=await f.post(base+'/revisions',{...graph,planningVersionId:'other'});assert.equal(smuggled.status,400);
    const saved=await f.post(base+'/revisions',graph);assert.equal(saved.status,200);assert.equal((await saved.json() as {revision:number}).revision,1);
    assert.equal((await f.post(base+'/revisions',graph)).status,409,'stale expectedRevision');
    const cycle=await f.post(base+'/revisions',{...graph,expectedRevision:1,edges:[...graph.edges,{taskId:first.id,dependsOn:second.id}]});
    assert.equal(cycle.status,400);assert.deepEqual(await cycle.json(),{error:'TASK_GRAPH_CYCLE'});
    assert.equal(((await (await f.get(base)).json()) as {revision:number}).revision,1);
    assert.equal(((await (await f.get(base+'/history')).json()) as unknown[]).length,1);
    assert.equal((await f.get(base+'?revision=0')).status,400);
    const seq=f.store.lastSeq();
    const state=await (await f.get(base+'/state')).json() as {stale:boolean;nodes:{taskId:string;state:string}[]};
    assert.equal(state.stale,false);
    assert.deepEqual(state.nodes.map(node=>node.state),['ready','waiting']);
    assert.ok(state.nodes.every(node=>node.state!=='done'),'no done until the quality gate defines it');
    assert.equal(f.store.lastSeq(),seq,'GET is read-only');
    f.studio.mutate(f.project.id,'plans',version.id,'revisions',{requestId:randomUUID(),expectedRevision:version.revision,input:planningInput});
    const stale=await (await f.get(base+'/state')).json() as {stale:boolean;nodes:{state:string}[]};
    assert.equal(stale.stale,true);assert.ok(stale.nodes.every(node=>node.state==='stale'));
  }finally{await f.close();}
});
