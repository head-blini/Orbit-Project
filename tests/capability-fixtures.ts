import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.ts';
import {Studio} from '../server/studio.ts';
import {CapabilityRoutingService} from '../server/capability-routing.ts';
import {discoverCapabilities} from '../server/capability-adapters.ts';
import type {PlanningVersion,SavedTask} from '../shared/parallel.ts';
export function fixture(kind:'code'|'general'='general',path=':memory:'){
 const store=new Store(path);store.saveProject({id:'p',kind,name:'Project',path:'unused',createdAt:'',writeEnabled:false});
 const studio=new Studio(store),input={format:'json',source:'manual',text:JSON.stringify({schema_version:'1.0',title:'Report',goal:'Research',requirements:[{id:'R1',description:'Collect sources',acceptance_criteria:['Cite sources']}],constraints:[],open_questions:[]})};
 const draft=studio.mutate('p','plans',undefined,undefined,{requestId:randomUUID(),input}) as PlanningVersion;
 const plan=studio.mutate('p','plans',draft.id,'approve',{expectedRevision:1}) as PlanningVersion;
 const task=(studio.mutate('p','plans',plan.id,'task-drafts',{}) as SavedTask[])[0];
 const registry=discoverCapabilities({codexReady:true,probe:{checkedAt:new Date().toISOString(),codex:{status:'found',version:'0.162.1'},claude:{status:'found',version:'2.1.0'}}});
 return {store,studio,task,plan,registry,service:new CapabilityRoutingService(store)};
}
