import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AppError} from '../server/errors.ts';
import {ClaudeTaskService} from '../server/claude-task-service.ts';
import {outboundDenial} from '../server/providers/policy.ts';
import {repairPiiInspectionText} from '../server/repair-pii.ts';
import {claudeFixture,outcome,session,tick} from './claude-task-fixture.ts';

// Known digest containing the national-id-like run 8351692182046.
const BAD='3cb51b163060ad2e739df665332862c2b6a6130cd5c54cf8351692182046e5a2';
const RUN='8351692182046';
const UUID='5f0e8a1c-8351-4692-9182-0466a1b2c3d4';
// Same shape as Controller.repairQuality: JSON.stringify({baseline,failures}).
const repairPrompt=(evidence='Missing citation for the reported total.',criterion='Cite evidence')=>JSON.stringify({
  baseline:{id:UUID,digest:BAD,criteria:[criterion]},
  failures:[{reviewerId:UUID,criterion,evidence,status:'not_met'}]});
const error=(code:string)=>(e:unknown)=>e instanceof AppError&&e.message===code;

test('repair inspection text blanks only UUID/digest identifier values',()=>{
  const prompt=repairPrompt();
  assert.equal(outboundDenial(prompt),'PERSONAL_DATA_BLOCKED','fixture digest no longer trips PII');
  assert.equal(outboundDenial(repairPiiInspectionText(prompt)),null);
  assert.equal(repairPiiInspectionText(prompt).includes(BAD),false);
  for(const bad of [repairPrompt(`Total ${RUN} is wrong`),repairPrompt('x',`Cite ${RUN}`),repairPrompt(`see ${BAD}`)])
    assert.equal(outboundDenial(repairPiiInspectionText(bad)),'PERSONAL_DATA_BLOCKED');
  // Identifier-named fields elsewhere, non-identifier values, and non-JSON stay inspected.
  assert.equal(outboundDenial(repairPiiInspectionText(JSON.stringify({baseline:{id:`x ${RUN}`},failures:[]}))),'PERSONAL_DATA_BLOCKED');
  assert.equal(outboundDenial(repairPiiInspectionText(JSON.stringify({other:{id:BAD}}))),'PERSONAL_DATA_BLOCKED');
  assert.equal(repairPiiInspectionText(`digest ${BAD}`),`digest ${BAD}`);
});

test('Claude repair launches with a PII-shaped digest; free-text runs and credentials still block; prompt bytes unchanged',async()=>{
  const f=claudeFixture(),service=new ClaudeTaskService(f.store,f.projects,f.dependencies);
  try{
    const {task}=f.plan(),source=service.submit(f.project.id,task.id,randomUUID());
    f.runners[0].finish(outcome('completed',{identity:{providerId:'anthropic',modelId:'observed-model',sessionId:session.sessionId,executionId:null,modelEvidence:'assistant_message'}}));await tick();
    for(const [prompt,code] of [[repairPrompt(`Total ${RUN} is wrong`),'PERSONAL_DATA_BLOCKED'],[repairPrompt('x',`Cite ${RUN}`),'PERSONAL_DATA_BLOCKED'],
      [repairPrompt('key sk-abcdefghijklmnopqrstuvwx'),'CREDENTIAL_LIKE_INPUT'],[JSON.stringify({baseline:{id:'sk-abcdefghijklmnopqrstuvwx'},failures:[]}),'CREDENTIAL_LIKE_INPUT']] as const)
      assert.throws(()=>service.repair(source.id,randomUUID(),prompt),error(code));
    assert.equal(f.runners.length,1);
    const prompt=repairPrompt(),run=service.repair(source.id,randomUUID(),prompt);
    assert.equal(f.runners.length,2);
    assert.ok(run.prompt.endsWith('\n'+prompt));assert.ok(run.prompt.includes(BAD));
    f.runners[1].finish();await tick();
  }finally{await service.close();await f.close();}
});
