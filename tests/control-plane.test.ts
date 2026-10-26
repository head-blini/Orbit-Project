import test from 'node:test';
import assert from 'node:assert/strict';
import {assessAssistedAdmission,type AssistedAdmissionFacts} from '../shared/control-plane.ts';
import {controlPlaneStatus} from '../server/control-plane.ts';

const qualified=():AssistedAdmissionFacts=>({initiator:'user',billing:'subscription',quota:{state:'available',fresh:true},quotaUnknownAcknowledged:false,
  safety:'qualified',workspaceValidated:true,approvalCurrent:true,ownership:'exclusive',recovery:'clear',stop:'qualified',
  maxTurns:1,maxAttempts:1,maxDurationMs:120000,delegation:false,automaticContinuation:false,
  hardTokenCapRequired:false,hardTokenCapEnforced:false,hardCostCapRequired:false,hardCostCapEnforced:false});

test('unknown subscription observation can admit only a separately acknowledged qualified assisted operation',()=>{
  const facts=qualified();facts.quota={state:'unknown',fresh:false};
  assert.deepEqual(assessAssistedAdmission(facts),{allowed:false,code:'QUOTA_ACK_REQUIRED'});
  facts.quotaUnknownAcknowledged=true;
  assert.deepEqual(assessAssistedAdmission(facts),{allowed:true,quota:'unknown',tokenCap:'not_enforced',costCap:'not_enforced'});
  facts.quota={state:'available',fresh:false};assert.equal(assessAssistedAdmission(facts).allowed,true);
  facts.quota={state:'exhausted',fresh:false};assert.deepEqual(assessAssistedAdmission(facts),{allowed:false,code:'QUOTA_EXHAUSTED'});
});
test('acknowledging unknown quota never overrides unknown safety, ownership, recovery, auth or requested hard caps',()=>{
  const cases:Array<[Partial<AssistedAdmissionFacts>,string]>=[
    [{initiator:'schedule'},'DIRECT_USER_ACTION_REQUIRED'],[{initiator:'automatic'},'DIRECT_USER_ACTION_REQUIRED'],
    [{billing:'api'},'SUBSCRIPTION_AUTH_REQUIRED'],[{billing:'unknown'},'SUBSCRIPTION_AUTH_REQUIRED'],
    [{safety:'unknown'},'SAFETY_UNQUALIFIED'],[{safety:'blocked'},'SAFETY_UNQUALIFIED'],
    [{workspaceValidated:false},'WORKSPACE_UNQUALIFIED'],[{approvalCurrent:false},'APPROVAL_REQUIRED'],
    [{ownership:'conflict'},'OWNER_UNQUALIFIED'],[{ownership:'unknown'},'OWNER_UNQUALIFIED'],
    [{recovery:'quarantined'},'RECOVERY_REQUIRED'],[{recovery:'unknown'},'RECOVERY_REQUIRED'],[{stop:'unknown'},'STOP_UNQUALIFIED'],
    [{maxTurns:2},'ASSISTED_ENVELOPE_INVALID'],[{maxAttempts:2},'ASSISTED_ENVELOPE_INVALID'],
    [{maxDurationMs:0},'ASSISTED_ENVELOPE_INVALID'],[{maxDurationMs:120001},'ASSISTED_ENVELOPE_INVALID'],
    [{maxDurationMs:NaN},'ASSISTED_ENVELOPE_INVALID'],[{delegation:true},'ASSISTED_ENVELOPE_INVALID'],
    [{automaticContinuation:true},'ASSISTED_ENVELOPE_INVALID'],[{hardTokenCapRequired:true},'HARD_TOKEN_CAP_UNAVAILABLE'],
    [{hardCostCapRequired:true},'HARD_COST_CAP_UNAVAILABLE'],
  ];
  for(const [change,code] of cases)assert.deepEqual(assessAssistedAdmission({...qualified(),quota:{state:'unknown',fresh:false},quotaUnknownAcknowledged:true,...change}),{allowed:false,code},code);
});
test('malformed admission facts fail closed without treating absent values as safe',()=>{
  for(const input of [null,{}, {...qualified(),quota:null},{...qualified(),quota:{state:'available',fresh:'yes'}},
    {...qualified(),safety:true},{...qualified(),delegation:undefined},{...qualified(),quotaUnknownAcknowledged:'yes'},
    {...qualified(),hardTokenCapRequired:undefined},{...qualified(),maxDurationMs:1.5}]){
    assert.equal(assessAssistedAdmission(input as unknown as AssistedAdmissionFacts).allowed,false);
  }
});
test('runtime connection cannot promote policy attestation or pure budget contracts into qualified autonomous execution',()=>{
  for(const provider of ['ready','disconnected','error'] as const){
    const status=controlPlaneStatus(provider);
    assert.equal(status.levels.tracking,'available');assert.equal(status.levels.assisted,'qualification_pending');assert.equal(status.levels.autonomous,'disabled');
    assert.equal(status.policies.find(p=>p.id==='native-isolation')?.owner,'runtime');
    assert.equal(status.policies.find(p=>p.id==='native-isolation')?.status,provider==='ready'?'attested':'unknown');
    assert.equal(status.policies.find(p=>p.id==='token-cap')?.status,'unknown');
    assert.equal(status.policies.find(p=>p.id==='cross-manager-ownership')?.status,'unknown');
    assert.equal(status.policies.find(p=>p.id==='http-admission')?.status,'enforced');
  }
});
