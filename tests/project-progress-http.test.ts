import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {createHttpServer} from '../server/http.ts';
import type {Controller} from '../server/controller.ts';
import type {PlanningVersion} from '../shared/parallel.ts';
import type {ProjectProgress} from '../shared/project-progress.ts';
import type {CodexUsage} from '../shared/usage.ts';

test('progress HTTP is authenticated, project scoped, read-only and reflects observed blockers',async()=>{
  const store=new Store(':memory:'),studio=new Studio(store);let execution=0;
  store.saveProject({id:'project-a',name:'A',path:'never-opened',createdAt:'',writeEnabled:false,kind:'general'});
  const plan=studio.mutate('project-a','plans',undefined,undefined,{requestId:randomUUID(),input:{format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Report',goal:'Compare vendors',requirements:[{id:'R1',description:'Collect',acceptance_criteria:['Sources cited']}],constraints:[],open_questions:[]})}}) as PlanningVersion;
  const approved=studio.mutate('project-a','plans',plan.id,'approve',{expectedRevision:1}) as PlanningVersion;
  studio.mutate('project-a','plans',approved.id,'task-drafts',{});
  const usage:CodexUsage={status:'available',source:'codex_app_server',checkedAt:'2026-10-28T00:00:00.000Z',buckets:[{id:'codex',primary:{usedPercent:100,remainingPercent:0,windowDurationMins:300,resetsAt:null},secondary:null}],summary:null,daily:null,billing:'chatgpt_subscription',apiCostUsd:null};
  // General projects run on Claude Code: Codex login and Codex quota do not describe them.
  const available:CodexUsage={...usage,buckets:[{id:'codex',primary:{usedPercent:10,remainingPercent:90,windowDurationMins:300,resetsAt:null},secondary:null}]};
  let claudeQuota:unknown={kind:'quota',status:'rejected',windows:[{id:'five_hour',utilization:1,resetsAt:null,status:'rejected'}]};
  const controller={store,snapshot:()=>({provider:'auth_required',soloRecoveryRequired:false}),usageSnapshot:()=>available,claudeQuota:()=>claudeQuota,claudeRecoveries:()=>[],submit:async()=>{execution++;}} as unknown as Controller;
  const server=createHttpServer(controller,'unused');await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,path='/api/projects/project-a/progress';
  try{
    assert.equal((await fetch(origin+path)).status,401);
    const session=await fetch(origin+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(origin+path+'?run=true',{headers:{cookie}})).status,400);
    assert.equal((await fetch(origin+'/api/projects/missing/progress',{headers:{cookie}})).status,404);
    const seq=store.lastSeq();
    const response=await fetch(origin+path,{headers:{cookie}});assert.equal(response.status,200);
    const progress=await response.json() as ProjectProgress;
    assert.equal(progress.projectId,'project-a');assert.equal(progress.plan?.title,'Report');
    assert.equal(progress.totals.tasks,1);assert.equal(progress.tasks[0].stage,'quota_wait');
    assert.deepEqual(progress.blockers,[{code:'QUOTA_EXHAUSTED',scope:'project',resetsAt:null}],'Claude quota applies; Codex login does not; reset unknown');
    const future=new Date(Date.now()+3600_000).toISOString(),past=new Date(Date.now()-60_000).toISOString();
    claudeQuota={kind:'quota',status:'rejected',windows:[{id:'five_hour',utilization:1,resetsAt:future,status:'rejected'}]};
    assert.equal((await (await fetch(origin+path,{headers:{cookie}})).json() as ProjectProgress).blockers[0].resetsAt,future);
    claudeQuota={kind:'quota',status:'rejected',windows:[{id:'five_hour',utilization:1,resetsAt:past,status:'rejected'}]};
    assert.equal((await (await fetch(origin+path,{headers:{cookie}})).json() as ProjectProgress).blockers[0].resetsAt,null,'a passed reset shows as unknown');
    claudeQuota=null;
    const unknown=await (await fetch(origin+path,{headers:{cookie}})).json() as ProjectProgress;
    assert.deepEqual(unknown.blockers,[]);assert.equal(unknown.tasks[0].stage,'not_started','unobserved quota stays unknown');
    assert.equal(store.lastSeq(),seq,'GET appends no events');assert.equal(execution,0);assert.equal(store.runs().length,0);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});
