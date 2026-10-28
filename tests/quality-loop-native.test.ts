import {CodexModelTracker} from '../server/codex-model-attribution.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from './temp.ts';
import {Store} from '../server/store.ts';
import {Projects} from '../server/projects.ts';
import {createQualityNativePorts,qualityModelEvidence,qualityRunEvidence,qualityVerifyGeneral,type QualityNativeOptions} from '../server/quality-loop-native.ts';
import type {QualityStepContext,QualityStep} from '../shared/quality-loop-record.ts';
import type {ClaudeOutcome,ClaudeEvent} from '../server/runtimes/claude-code.ts';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-quality-native-')),store=new Store(':memory:');
  const projects=new Projects(store,join(dir,'workspaces'),[],join(dir,'projects'));
  const {project}=projects.createProject({requestId:crypto.randomUUID(),name:'Research',kind:'general'});
  writeFileSync(join(project.path,'report.md'),'# Report\nEvidence verified.');
  const run=store.createRun(crypto.randomUUID(),'a'.repeat(64),'write report',undefined,{runtime:'claude-code',projectId:project.id,taskId:'task',planningVersionId:'version',planningContentHash:'b'.repeat(64)});
  store.updateRun(run.id,{execution:'completed'},'run.completed');
  const context:QualityStepContext={loopId:'loop',stepId:'step',sourceRun:store.getRun(run.id)!,signal:new AbortController().signal,artifact:{id:project.id,digest:''},
    version:{id:'version',projectId:project.id,revision:1,contentHash:'b'.repeat(64),state:'approved',draft:{schemaVersion:'1.0',title:'Report',goal:'Write report',requirements:[{label:'R1',description:'Report',acceptanceCriteria:['Evidence present']}],constraints:[],openQuestions:[],source:'manual'}},
    task:{id:'task',projectId:project.id,title:'Report',description:'Report',acceptanceCriteria:['Evidence present'],planningVersionId:'version',requirementLabels:['R1'],state:'draft',verification:'not_run',createdAt:new Date().toISOString()}};
  const response=JSON.stringify({verdict:'approve',baseline_respected:true,criteria:[{criterion:'Evidence present',status:'met',evidence:'Report includes evidence.'}],findings:[]});
  const outcome:ClaudeOutcome={status:'completed',sessionId:'review-session',exit:'observed',exitCode:0,signal:null,forced:false,ignoredLines:0,response,
    identity:{providerId:'anthropic',modelId:'model-b',sessionId:'review-session',executionId:null,modelEvidence:'assistant_message'}};
  let calls=0,interrupts=0,prompt='';
  let events:ClaudeEvent[]=[{kind:'session',sessionId:'review-session',model:'alias',permissionMode:'plan',auth:'subscription',tools:[]}];
  const options:QualityNativeOptions={store,projects,factory:()=>{throw Error('NATIVE_FORBIDDEN');},guard:()=>{},repair:async()=>{throw Error('NOT_EXPECTED');},verify:async()=>({status:'unknown',checkIds:[],issue:null}),findExecutable:()=>'/fake/claude',
    claudeFactory:config=>{assert.equal(config.mode,'read');assert.equal(config.textOnly,true);assert.equal(config.resume,undefined);assert.equal(config.model,'model-b');return {async start(text,onEvent){calls++;prompt=text;for(const event of events)onEvent(event);return outcome;},interrupt(){interrupts++;return 'requested';}};}};
  const ports=createQualityNativePorts(options);
  const review=()=>{const artifact=ports.snapshot(context.sourceRun).artifact;context.artifact=artifact;return ports.review({baseline:{id:'version',digest:'b'.repeat(64),criteria:context.task.acceptanceCriteria},artifact,reviewer:{id:'reviewer',modelKey:'anthropic/model-b'},signal:new AbortController().signal},context,{id:'reviewer',providerId:'anthropic',modelId:'model-b'});};
  return {dir,store,project,run,context,outcome,options,ports,review,setEvents:(value:ClaudeEvent[])=>{events=value;},get calls(){return calls;},get interrupts(){return interrupts;},get prompt(){return prompt;},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('general project native bridge uses frozen artifacts, observed identity and fresh read sessions',async()=>{
  const f=fixture();try{assert.equal(f.ports.snapshot(f.context.sourceRun).producer.source,'unknown');const result=await f.review();assert.equal(result.evidence.source,'native_observed');assert.equal(result.evidence.modelId,'model-b');assert.equal(result.evidence.runId,'step');assert.equal(result.review.criteria.length,1);assert.match(f.prompt,/Evidence verified/);assert.match(f.prompt,/도구를 사용하지/);assert.equal(f.calls,1);}finally{f.close();}
});
test('native review preserves every approved criterion verbatim beyond summary length and count limits',async()=>{
  const f=fixture();try{
    const criteria=['가'.repeat(600),'Keep  multiple   spaces','Keep first line\nand second line',...Array.from({length:21},(_,i)=>`Additional criterion ${i+1}`)];
    f.context.task.acceptanceCriteria=criteria;f.context.version.draft.requirements[0].acceptanceCriteria=criteria;
    f.outcome.response=JSON.stringify({verdict:'approve',baseline_respected:true,criteria:criteria.map(criterion=>({criterion,status:'met',evidence:'Verified against frozen report.'})),findings:[]});
    const result=await f.review();
    assert.ok(f.prompt.includes(JSON.stringify(criteria)));assert.match(f.prompt,/모든 원문 문자열을 criterion으로 정확히/);
    assert.deepEqual(result.review.criteria.map(item=>item.criterion),criteria);assert.equal(f.calls,1);
  }finally{f.close();}
});
test('requested model and session metadata do not manufacture actual producer evidence',()=>{
  const f=fixture();try{f.store.append('run.identity',f.run.id,{providerId:'anthropic',modelId:'requested',sessionId:'s',executionId:f.run.id,modelEvidence:'unknown'});assert.equal(qualityRunEvidence(f.store,f.run).modelId,null);f.store.append('run.identity',f.run.id,{providerId:'anthropic',modelId:'actual',sessionId:'s',executionId:f.run.id,modelEvidence:'assistant_message'});assert.equal(qualityRunEvidence(f.store,f.run).modelId,'actual');}finally{f.close();}
});
test('quota rejection and permission denial interrupt native review without accepting its output',async()=>{
  for(const [events,issue] of [
    [[{kind:'quota',status:'rejected',windows:[]}],'QUOTA_EXHAUSTED'],
    [[{kind:'session',sessionId:'s',model:null,permissionMode:'plan',auth:'api_key',tools:[]}],'QUALITY_PERMISSION_DENIED'],
    [[{kind:'tool',name:'Read'}],'QUALITY_REVIEW_TOOLS_DENIED'],
  ] as [ClaudeEvent[],string][]){const f=fixture();try{f.setEvents(events);await assert.rejects(f.review(),new RegExp(issue));assert.equal(f.interrupts,1);}finally{f.close();}}
});
test('unknown actual reviewer model remains unknown and lost process exit is never accepted',async()=>{
  const f=fixture();try{delete f.outcome.identity;const result=await f.review();assert.equal(result.review.modelKey,'unknown');assert.equal(result.evidence.source,'unknown');f.context.stepId='lost-step';f.outcome.exit='not_observed';await assert.rejects(f.review(),/QUALITY_PROCESS_STOP_UNCONFIRMED/);}finally{f.close();}
});
test('artifact mutation and sensitive input block before any model dispatch',async()=>{
  const f=fixture();try{const artifact=f.ports.snapshot(f.context.sourceRun).artifact;writeFileSync(join(f.project.path,'report.md'),'Changed');await assert.rejects(f.ports.review({baseline:{id:'version',digest:'b'.repeat(64),criteria:['Evidence present']},artifact,reviewer:{id:'reviewer',modelKey:'anthropic/model-b'},signal:new AbortController().signal},f.context,{id:'reviewer',providerId:'anthropic',modelId:'model-b'}),/QUALITY_ARTIFACT_CHANGED/);assert.equal(f.calls,0);writeFileSync(join(f.project.path,'report.md'),'sk-abcdefghijklmnopqrstuv');assert.throws(()=>f.ports.snapshot(f.context.sourceRun),/QUALITY_ARTIFACT_CHANGED/);assert.equal(f.calls,0);}finally{f.close();}
});
test('general local checks persist format evidence and numeric mismatches without claiming semantic proof',async()=>{
  const f=fixture();try{
    f.context.artifact=f.ports.snapshot(f.context.sourceRun).artifact;
    const first=await qualityVerifyGeneral(f.store,f.options.projects,f.context);assert.equal(first.status,'passed');
    const saved=f.store.db.prepare('SELECT body FROM quality_artifact_checks WHERE id=?').get(f.context.stepId)!;
    assert.equal(JSON.parse(String(saved.body)).scope,'format_and_numeric_source_only');
    assert.deepEqual(await qualityVerifyGeneral(f.store,f.options.projects,f.context),first);
    mkdirSync(join(f.project.path,'inputs'));writeFileSync(join(f.project.path,'inputs','source.csv'),'name,value\na,1');
    writeFileSync(join(f.project.path,'report.md'),'| name | value |\n| a | 9 |');
    f.context.stepId='second';f.context.artifact=f.ports.snapshot(f.context.sourceRun).artifact;
    const result=await qualityVerifyGeneral(f.store,f.options.projects,f.context);assert.equal(result.status,'failed');assert.equal(result.failures?.length,1);assert.match(result.failures![0].evidence,/9/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM quality_artifact_checks').get()!.count,2);
  }finally{f.close();}
});
test('code bridge consumes the existing workspace snapshot and refuses unsupported binary artifacts',async()=>{
  const f=fixture();try{
    f.context.sourceRun={...f.context.sourceRun,workspaceId:'workspace'};
    const files=[{path:'report.md',mode:'100644',presence:'present' as const,bytes:Buffer.from('A frozen code-project report')}];
    const projects={writable:()=>({path:f.project.path,projectId:f.project.id}),snapshot:()=>({sourceDigest:'c'.repeat(64),files})} as unknown as Projects;
    const ports=createQualityNativePorts({...f.options,projects});const snapshot=ports.snapshot(f.context.sourceRun);
    assert.equal(snapshot.artifact.id,'workspace');assert.equal(snapshot.artifact.digest,'c'.repeat(64));
    const result=await ports.review({baseline:{id:'version',digest:'b'.repeat(64),criteria:['Evidence present']},artifact:snapshot.artifact,reviewer:{id:'reviewer',modelKey:'anthropic/model-b'},signal:new AbortController().signal},f.context,{id:'reviewer',providerId:'anthropic',modelId:'model-b'});
    assert.equal(result.review.criteria[0].status,'met');assert.match(f.prompt,/frozen code-project/);
    files[0].bytes=Buffer.from([0,1]);assert.throws(()=>ports.snapshot(f.context.sourceRun),/QUALITY_ARTIFACT_FORMAT_UNSUPPORTED/);
  }finally{f.close();}
});
test('native receipts recover completed and stopped-failed reviews without another dispatch',async()=>{
  const f=fixture();try{
    const result=await f.review();
    const step:QualityStep={id:f.context.stepId,index:0,kind:'review',state:'intent',requestDigest:'d'.repeat(64),startedAt:new Date().toISOString(),finishedAt:null,issue:null,evidence:null,result:null};
    assert.deepEqual(await f.ports.recover!(step,f.context),{result:result.review,evidence:result.evidence});
    await assert.rejects(f.review(),/QUALITY_DISPATCH_ALREADY_RECORDED/);assert.equal(f.calls,1);
    f.context.stepId='quota-step';f.setEvents([{kind:'quota',status:'rejected',windows:[]}]);await assert.rejects(f.review(),/QUOTA_EXHAUSTED/);
    assert.deepEqual(await f.ports.recover!({...step,id:f.context.stepId},f.context),{failureIssue:'QUOTA_EXHAUSTED',processStopped:true});assert.equal(f.calls,2);
    assert.equal(await f.ports.recover!({...step,id:'unobserved'},f.context),null);
  }finally{f.close();}
});
test('Codex model observation gap blocks before spending quota; injected protocol fixtures still remain unknown',async()=>{
  const f=fixture();try{
    const artifact=f.ports.snapshot(f.context.sourceRun).artifact;f.context.artifact=artifact;
    const request={baseline:{id:'version',digest:'b'.repeat(64),criteria:['Evidence present']},artifact,reviewer:{id:'reviewer',modelKey:'openai/model-c'},signal:new AbortController().signal};
    await assert.rejects(f.ports.review(request,f.context,{id:'reviewer',providerId:'openai',modelId:'model-c'}),/QUALITY_MODEL_OBSERVATION_UNSUPPORTED/);assert.equal(f.calls,0);
    let calls=0;f.context.stepId='codex-fixture';
    const ports=createQualityNativePorts({...f.options,codexReview:async()=>{calls++;return {execution:'completed',threadId:'thread',turnId:'turn',response:f.outcome.response,issue:null,processStopped:true,identity:{providerId:'openai',modelId:'unknown',sessionId:'thread',executionId:'turn',modelEvidence:'unknown'}};}});
    const result=await ports.review(request,f.context,{id:'reviewer',providerId:'openai',modelId:'model-c'});assert.equal(result.evidence.source,'unknown');assert.equal(result.review.modelKey,'unknown');assert.equal(calls,1);
  }finally{f.close();}
});


test('persisted Codex settings remain unknown and override stale claimed actual identity',()=>{
  const f=fixture();try{
    const tracker=new CodexModelTracker((runId,value)=>f.store.saveCodexModelAttribution(runId,value));
    tracker.connect('thread/resume',{thread:{id:'thread',sessionId:'session'},model:'configured-model',modelProvider:'openai'});
    tracker.begin(f.run.id);tracker.acknowledge(f.run.id,{turn:{id:'turn'}});tracker.finish(f.run.id,'interrupted');
    f.store.append('run.identity',f.run.id,{providerId:'openai',modelId:'claimed-model',sessionId:'old-session',executionId:'old-turn',modelEvidence:'assistant_message'});
    const evidence=qualityRunEvidence(f.store,f.run);
    assert.equal(evidence.modelId,null);assert.equal(evidence.source,'unknown');
    assert.equal(evidence.sessionId,'session');assert.equal(evidence.executionId,'turn');
    assert.equal(evidence.codex?.serverModelId,'configured-model');assert.equal(evidence.codex?.resumed,true);
    assert.equal(evidence.codex?.actualModelId,'unknown');
    const native=qualityModelEvidence({providerId:'openai',modelId:'claimed-model',sessionId:'session',executionId:'turn',modelEvidence:'assistant_message',codex:evidence.codex},'step');
    assert.equal(native.modelId,null);assert.equal(native.source,'unknown');assert.deepEqual(native.codex,evidence.codex);
  }finally{f.close();}
});
