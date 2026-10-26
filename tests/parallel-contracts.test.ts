import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArchitectureGraph,ArtifactRecord,DestinationPolicy,LaunchContext,PlanningParseResult,PlanningVersion,ProviderTransport,TaskDraft,TimelineView } from '../shared/parallel.ts';
import { parsePlanningDraft } from '../server/planning/parser.ts';
import { InMemoryPlanningRepository } from '../server/planning/repository.ts';
import { ArtifactRepository } from '../server/visualization/artifacts.ts';
import { generateArchitectureMermaid } from '../web/visualization/mermaid.ts';
import { buildTimeline } from '../web/visualization/timeline.ts';
import { createProviderAdapters } from '../server/providers/connections.ts';
import { evaluateLaunch } from '../server/providers/policy.ts';

test('common contracts bind all three existing module interfaces',()=>{
  const parsed:PlanningParseResult=parsePlanningDraft({format:'markdown',source:'manual',text:'# Plan'});assert.equal(parsed.ok,true);
  const repo=new InMemoryPlanningRepository();const version:PlanningVersion=repo.create('p',{format:'markdown',source:'manual',text:'# Plan'});assert.equal(version.state,'draft');
  const tasks:(project:string,id:string)=>TaskDraft[]=repo.toTasks.bind(repo);assert.throws(()=>tasks('p',version.id),/NOT_APPROVED/);
  const graph:ArchitectureGraph={nodes:[{id:'a',label:'A',kind:'service'}],edges:[]};
  const artifact:ArtifactRecord=new ArtifactRepository().create('p',{kind:'mermaid',source:generateArchitectureMermaid(graph),metadata:{}});assert.equal(artifact.revision,1);
  const timeline:TimelineView=buildTimeline({provider:'disconnected',issue:null,threadId:null,workspace:'test',readOnly:true,runs:[],lastSeq:0},[]);assert.equal(timeline.lastSeq,0);
  const policy:DestinationPolicy={destinationId:'mock',providerId:'vllm',classification:'local',endpoint:'http://127.0.0.1:1',action:'block'};
  const transport:ProviderTransport={async send(){return {text:'mock'};}};assert.equal(createProviderAdapters([policy],transport).vllm.status,'mock_only');
});

test('launch preflight denies unvalidated capabilities and preserves read-only zero-workspace flow',()=>{
  const context:LaunchContext={provider:{id:'codex',status:'ready',capabilities:{patch:false,shell:false,approvals:'deny',mcp:'disabled'}},expectedWorkspaceId:null,selectedWorkspaceId:null,workspaceValidated:true,writeEnabled:false,policyValidated:true,mcpIsolated:true};
  assert.deepEqual(evaluateLaunch(context),{allowed:true});
  for(const key of ['workspaceValidated','policyValidated','mcpIsolated'] as const)assert.equal(evaluateLaunch({...context,[key]:false}).allowed,false);
  assert.equal(evaluateLaunch({...context,expectedWorkspaceId:'foreign'}).allowed,false);
  assert.equal(evaluateLaunch({...context,selectedWorkspaceId:'w',expectedWorkspaceId:'w'}).allowed,false);
  assert.equal(evaluateLaunch({...context,provider:{...context.provider,status:'error'}}).allowed,false);
});
