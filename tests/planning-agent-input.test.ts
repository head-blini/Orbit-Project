import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const module=await import('../server/planning/agent-input.ts').catch(()=>null);
function api(){assert.ok(module,'planning input implementation required');return module;}
const proposal=()=>({schema_version:'1.0',title:'Local workspace',goal:'Plan an offline tool',requirements:[{id:'R1',description:'Preserve state',acceptance_criteria:['Restore after restart']}],constraints:['No network'],open_questions:[],decisions:[{topic:'Storage',decision:'SQLite',rationale:'Local operation'}]});

test('planning preview preserves the exact request as inert text and binds its complete instructions',()=>{
  const {buildPlanningPrompt}=api(),text='Plan a local dashboard.\n<script>fixture()</script> $(fixture)';const result=buildPlanningPrompt(text);
  assert.match(result.instructions,/planning/);assert.ok(result.instructions.includes(JSON.stringify({request:text})));
  assert.equal(result.inputDigest,createHash('sha256').update(result.instructions).digest('hex'));
  assert.notEqual(result.inputDigest,buildPlanningPrompt(text+' ').inputDigest);
  assert.doesNotThrow(()=>buildPlanningPrompt('한'.repeat(8000)));assert.throws(()=>buildPlanningPrompt('x'.repeat(8001)),/INVALID_PLANNING_INPUT/);
});
test('planning request rejects invalid input and decoded credentials or personal data before preview',()=>{
  for(const value of [null,{},'', ' ', 'x\0y', 'x\u007fy'])assert.throws(()=>api().buildPlanningPrompt(value),/INVALID_PLANNING_INPUT/);
  for(const value of ['fixture.person@example.invalid','010-1234-5678','Bearer fixture-token','api_key=fixture-secret'])assert.throws(()=>api().buildPlanningPrompt(value),/PLANNING_INPUT_BLOCKED/);
});
test('proposal schema and parsed draft preserve decisions and attach only server-owned Codex attribution',()=>{
  const {parsePlanningProposal,planningOutputSchema}=api(),result=parsePlanningProposal(JSON.stringify(proposal()));
  assert.deepEqual(result.decisions,[{topic:'Storage',decision:'SQLite',rationale:'Local operation'}]);
  assert.deepEqual(result.provenance,{kind:'in_app_agent',providerId:'codex',externalUrl:null});assert.equal(result.source,'import');
  assert.equal(planningOutputSchema.additionalProperties,false);assert.ok(Object.isFrozen(planningOutputSchema.properties));
  const incomplete=proposal();incomplete.decisions[0].rationale='';assert.equal(parsePlanningProposal(JSON.stringify(incomplete)).decisions?.[0].rationale,'');
});
test('model source, authority, malformed and oversized proposals fail without exposing raw input',()=>{
  for(const field of ['source','state','id','approvedAt','contentHash']){
    const input=JSON.stringify({...proposal(),[field]:'RAW_FORGED'});assert.throws(()=>api().parsePlanningProposal(input),error=>error instanceof Error&&error.message==='PLANNING_PROPOSAL_INVALID');
  }
  for(const input of [null,'{','```json\n{}\n```','x'.repeat(64001),JSON.stringify({...proposal(),decisions:null})])assert.throws(()=>api().parsePlanningProposal(input),/PLANNING_PROPOSAL_INVALID/);
});
test('decoded sensitive proposal fields reject instead of masking or persisting altered JSON',()=>{
  for(const field of ['title','goal','decision','rationale','question','criterion']){
    const value=proposal(),sensitive='fixture.person@example.invalid';
    if(field==='title'||field==='goal')value[field]=sensitive;
    else if(field==='decision'||field==='rationale')value.decisions[0][field]=sensitive;
    else if(field==='question')value.open_questions.push(sensitive as never);else value.requirements[0].acceptance_criteria=[sensitive];
    assert.throws(()=>api().parsePlanningProposal(JSON.stringify(value).replace('fixture','\\u0066ixture')),/PLANNING_PROPOSAL_BLOCKED/);
  }
});

test('proposal validation inspects decoded control characters before the ordinary parser trims values',()=>{
  for(const control of ['\u000b','\u000c','\u007f']){
    const value=proposal();value.decisions[0].rationale=control+'Local operation'+control;
    assert.throws(()=>api().parsePlanningProposal(JSON.stringify(value)),/PLANNING_PROPOSAL_BLOCKED/);
  }
});
