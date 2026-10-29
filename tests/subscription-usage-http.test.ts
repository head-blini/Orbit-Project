import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {createHttpServer} from '../server/http.ts';
import type {Controller} from '../server/controller.ts';
import type {ProjectProgress} from '../shared/project-progress.ts';
import type {PlanningVersion} from '../shared/parallel.ts';

test('progress shows quota headroom only from a fresh observation; stale rejection still blocks; usage GET is read-only',async()=>{
  const store=new Store(':memory:'),studio=new Studio(store);
  store.saveProject({id:'project-a',name:'A',path:'never-opened',createdAt:'',writeEnabled:false,kind:'general'});
  const plan=studio.mutate('project-a','plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Report',goal:'Compare',requirements:[{id:'R1',description:'Collect',acceptance_criteria:['Cited']}],constraints:[],open_questions:[]})}}) as PlanningVersion;
  const approved=studio.mutate('project-a','plans',plan.id,'approve',{expectedRevision:1}) as PlanningVersion;studio.mutate('project-a','plans',approved.id,'task-drafts',{});
  let freshness='fresh',claudeQuota:unknown={kind:'quota',status:'allowed',windows:[{id:'five_hour',utilization:0.2,resetsAt:null,status:'allowed'}]};
  const subscriptionUsage={snapshot:()=>[{observation:{runtimeId:'claude-code',freshness},connected:true}]};
  const controller={store,snapshot:()=>({provider:'disconnected',soloRecoveryRequired:false}),usageSnapshot:()=>null,claudeQuota:()=>claudeQuota,subscriptionUsage} as unknown as Controller;
  const server=createHttpServer(controller,'unused');await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try{
    const cookie=(await fetch(origin+'/api/session')).headers.get('set-cookie')!.split(';')[0];
    const progress=async()=>await (await fetch(origin+'/api/projects/project-a/progress',{headers:{cookie}})).json() as ProjectProgress;
    const seq=store.lastSeq();
    assert.equal((await progress()).tasks[0].stage,'not_started');
    const usage=await fetch(origin+'/api/usage/subscriptions',{headers:{cookie}});assert.equal(usage.status,200);assert.equal((await usage.json() as unknown[]).length,1);
    assert.equal((await fetch(origin+'/api/usage/subscriptions?refresh=1',{headers:{cookie}})).status,400);
    freshness='stale';
    assert.deepEqual((await progress()).blockers,[],'stale headroom is unknown, not available');
    claudeQuota={kind:'quota',status:'rejected',windows:[{id:'five_hour',utilization:1,resetsAt:null,status:'rejected'}]};
    const blocked=await progress();
    assert.deepEqual(blocked.blockers.map(b=>b.code),['QUOTA_EXHAUSTED'],'a stale rejection still blocks');assert.equal(blocked.tasks[0].stage,'quota_wait');
    assert.equal(store.lastSeq(),seq,'GETs append no events');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});
