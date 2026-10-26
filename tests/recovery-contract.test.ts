import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRecoveryRelease} from '../shared/recovery.ts';

// These are trusted-fact fixtures, not actual OS/runtime qualification evidence.
const fixture = () => {
  const scope = {operationId:'op-1',requestId:'request-1',runtimeId:'runtime-1',ownerIncarnation:'owner-1',generation:3,nativeSessionId:'session-1',nativeTurnId:'turn-1'};
  const environment = {runtimeId:'runtime-1',runtimeVersion:'1.2.3',os:'darwin-arm64',authMode:'subscription',policyFingerprint:'policy-1',configurationFingerprint:'config-1'};
  const resource = {repositoryId:'repository-1',commonGitDir:'/canonical/repo/.git',targetBranch:'main',worktreeId:'/canonical/worktree',accountSlot:'account-1',baseRevision:'base-1',sourceFingerprint:'source-1'};
  const process = {handleId:'owned-child-1',pid:123,bootId:'boot-1',startId:'start-1'};
  return {
    now:10000,managerIncarnation:'owner-1',route:'automatic',level:'assisted',
    operation:{scope,environment,resource,process,startedAt:1000,recoveryRevision:2,dispatch:'dispatched',state:'quarantined'},
    profile:{environment:{...environment},qualification:{status:'qualified',evidenceId:'qualification-1',qualifiedAt:500,expiresAt:20000},safety:'qualified',
      requirements:{processClosed:true,sessionTerminal:true,sessionStates:['terminal'],descendants:'all_stopped'},
      freshness:{proofMaxAgeMs:10000,checkMaxAgeMs:1000,manualMaxAgeMs:1000},manual:{allowed:true,replaceable:['process_closed','session_terminal','descendants_stopped','owner_stopped']}},
    persistence:{intent:'durable',recovery:'durable'},
    ownership:{scope:{...scope},identity:'matched',ownerLiveness:'stopped',checkedAt:9900},
    workspaceCheck:{scope:{...scope},resource:{...resource},identity:'verified',conflictingWriter:'clear',checkedAt:9900},
    liveness:{process:'stopped',session:'terminal',descendants:'stopped'},
    proofs:{
      process:{kind:'owned_child_close',scope:{...scope},observedAt:9000,observerIncarnation:'owner-1',process:{...process}},
      session:{kind:'authoritative_terminal',scope:{...scope},observedAt:9000,state:'terminal'},
      descendants:{kind:'authoritative_all_stopped',scope:{...scope},observedAt:9000,childIds:['child-1']}
    },
    nonProofs:[] as string[],manual:null as null | Record<string,unknown>
  };
};
type Facts = ReturnType<typeof fixture>;
const withoutProofs = (facts:Facts) => {
  Object.assign(facts.proofs,{process:null,session:null,descendants:null});
  Object.assign(facts.liveness,{process:'unknown',session:'unknown',descendants:'unknown'});
};
const manualFixture = () => {
  const f=fixture(); f.route='manual'; withoutProofs(f); f.ownership.ownerLiveness='unknown';
  const unresolved=['process_closed','session_terminal','descendants_stopped','owner_stopped'];
  const binding={scope:structuredClone(f.operation.scope),resource:structuredClone(f.operation.resource),recoveryRevision:2,unresolved};
  f.manual={preview:{id:'preview-1',...structuredClone(binding),createdAt:9800,expiresAt:10500},
    attestation:{actorId:'local-human-1',kind:'human_attestation',action:'release_quarantine',previewId:'preview-1',...structuredClone(binding),attestedAt:9900}};
  return f;
};
const deny = (f:unknown,code:string) => assert.deepEqual(evaluateRecoveryRelease(f),{allowed:false,code});

test('exact qualified process, session and descendant facts allow only a machine release basis',()=>{
  const f=fixture();const before=structuredClone(f);const decision=evaluateRecoveryRelease(f);
  assert.equal(decision.allowed,true);
  if(decision.allowed){assert.equal(decision.basis.kind,'machine');assert.deepEqual(decision.basis.proofs,['process_closed','session_terminal','descendants_stopped']);}
  assert.deepEqual(f,before,'evaluation does not mutate operation or dispatch');
  assert.equal('execute' in decision,false);assert.equal('success' in decision,false);
});

test('PID observation, absence, lease expiry, interrupt acknowledgement and transport EOF never substitute for stop proof',()=>{
  for(const nonProof of ['pid_observed','pid_absent','lease_expired','interrupt_ack','transport_eof','kill_requested','kill_error','deadline_elapsed','manager_exited','terminal_ui_text']){
    const f=fixture();withoutProofs(f);f.nonProofs=[nonProof];deny(f,'TERMINATION_UNPROVEN');
  }
});

test('PID reuse and boot/start/owned-handle mismatches deny even if numeric PID is identical',()=>{
  for(const field of ['handleId','bootId','startId'] as const){const f=fixture();f.proofs.process.process[field]='unrelated';deny(f,'PROCESS_IDENTITY_MISMATCH');}
  const f=fixture();f.proofs.process.process.pid=456;deny(f,'PROCESS_IDENTITY_MISMATCH');
});

test('foreign operation, request, runtime, owner, generation, session or turn proof never releases another operation',()=>{
  for(const proof of ['process','session','descendants'] as const){
    for(const field of ['operationId','requestId','runtimeId','ownerIncarnation','nativeSessionId','nativeTurnId'] as const){
      const f=fixture();f.proofs[proof].scope[field]='other';deny(f,'EVIDENCE_SCOPE_MISMATCH');
    }
    const f=fixture();f.proofs[proof].scope.generation++;deny(f,'EVIDENCE_SCOPE_MISMATCH');
  }
  const f=fixture();f.proofs.process.observerIncarnation='owner-after-restart';deny(f,'PROCESS_IDENTITY_MISMATCH');
});

test('process close does not prove a disconnected native session or unknown descendants',()=>{
  for(const proof of ['session','descendants'] as const){const f=fixture();Object.assign(f.proofs,{[proof]:null});deny(f,'TERMINATION_UNPROVEN');}
  const f=fixture();f.profile.requirements.descendants='none_permitted';Object.assign(f.proofs,{descendants:null});
  f.liveness.descendants='unknown';assert.equal(evaluateRecoveryRelease(f).allowed,true);
  f.profile.qualification.status='unknown';deny(f,'PROFILE_UNQUALIFIED');
});

test('fresh canonical workspace and exact ownership are required despite terminal evidence',()=>{
  for(const field of ['repositoryId','commonGitDir','targetBranch','worktreeId','accountSlot','baseRevision','sourceFingerprint'] as const){
    const f=fixture();f.workspaceCheck.resource[field]='changed';deny(f,'WORKSPACE_CHANGED');
  }
  for(const state of ['present','unknown']){const f=fixture();f.workspaceCheck.conflictingWriter=state;deny(f,'WRITER_CONFLICT_UNRESOLVED');}
  for(const state of ['mismatch','unknown']){const f=fixture();f.ownership.identity=state;deny(f,'OWNERSHIP_UNVERIFIED');}
  const owner=fixture();owner.ownership.scope.ownerIncarnation='different';deny(owner,'OWNERSHIP_SCOPE_MISMATCH');
  const stale=fixture();stale.workspaceCheck.checkedAt=9000;deny(stale,'WORKSPACE_CHECK_STALE');
});

test('known live process, native session, child or owner blocks automatic and manual release',()=>{
  for(const make of [fixture,manualFixture]){
    for(const field of ['process','session','descendants'] as const){const f=make();f.liveness[field]='running';deny(f,'WORK_STILL_RUNNING');}
    const f=make();f.ownership.ownerLiveness='running';deny(f,'OWNER_STILL_RUNNING');
  }
});

test('missing durable intent and unrepaired recovery storage retain quarantine',()=>{
  for(const state of ['missing','unknown']){const f=fixture();f.persistence.intent=state;deny(f,'PERSISTENCE_UNRESOLVED');}
  for(const state of ['repair_required','unknown']){const f=manualFixture();f.persistence.recovery=state;deny(f,'PERSISTENCE_UNRESOLVED');}
});

test('qualification must match runtime, OS, authentication, policy and configuration without expired evidence',()=>{
  for(const field of ['runtimeId','runtimeVersion','os','authMode','policyFingerprint','configurationFingerprint'] as const){
    const f=fixture();f.profile.environment[field]=field==='authMode'?'api':'changed';deny(f,'PROFILE_SCOPE_MISMATCH');
  }
  const expired=fixture();expired.profile.qualification.expiresAt=10000;deny(expired,'PROFILE_UNQUALIFIED');
  for(const status of ['unknown','blocked']){const f=manualFixture();f.profile.safety=status;deny(f,'SAFETY_UNQUALIFIED');}
  const old=fixture();old.profile.freshness.proofMaxAgeMs=1000;deny(old,'EVIDENCE_STALE');
});

test('manual release preserves exact human attestation and weaker basis without claiming successful execution',()=>{
  const f=manualFixture();const before=structuredClone(f);const result=evaluateRecoveryRelease(f);
  assert.equal(result.allowed,true);
  if(result.allowed){assert.equal(result.basis.kind,'human_attestation');assert.deepEqual(result.basis.proofs,[]);
    assert.deepEqual(result.basis.humanAttestation,f.manual?.attestation);assert.deepEqual(result.basis.attestedFacts,['process_closed','session_terminal','descendants_stopped','owner_stopped']);}
  assert.deepEqual(f,before);assert.equal('success' in result,false);assert.equal('retry' in result,false);assert.equal('autonomous' in result,false);
});

test('manual attestation cannot activate Autonomous or exceed the qualified profile recovery allowance',()=>{
  for(const level of ['autonomous','tracking']){const f=manualFixture();f.level=level;deny(f,'MANUAL_ASSISTED_ONLY');}
  const disallowed=manualFixture();disallowed.profile.manual.allowed=false;deny(disallowed,'MANUAL_NOT_QUALIFIED');
  const partial=manualFixture();partial.profile.manual.replaceable=['process_closed'];deny(partial,'MANUAL_SCOPE_NOT_QUALIFIED');
});

test('manual preview and confirmation bind current source, revision, owner, unresolved facts, identity and freshness',()=>{
  const changes:Array<[string,(manual:Record<string,any>)=>void,string]>=[
    ['preview id',m=>m.attestation.previewId='old-preview','MANUAL_PREVIEW_MISMATCH'],
    ['revision',m=>m.preview.recoveryRevision=1,'MANUAL_SCOPE_MISMATCH'],
    ['confirmation revision',m=>m.attestation.recoveryRevision=1,'MANUAL_SCOPE_MISMATCH'],
    ['source',m=>m.preview.resource.sourceFingerprint='old-source','MANUAL_SCOPE_MISMATCH'],
    ['confirmation source',m=>m.attestation.resource.sourceFingerprint='old-source','MANUAL_SCOPE_MISMATCH'],
    ['owner',m=>m.preview.scope.ownerIncarnation='old-owner','MANUAL_SCOPE_MISMATCH'],
    ['unresolved',m=>m.preview.unresolved=['process_closed'],'MANUAL_SCOPE_MISMATCH'],
    ['extra attested fact',m=>m.attestation.unresolved=['process_closed'],'MANUAL_SCOPE_MISMATCH'],
    ['expired',m=>m.preview.expiresAt=10000,'MANUAL_PREVIEW_STALE'],
    ['stale',m=>m.preview.createdAt=9000,'MANUAL_PREVIEW_STALE'],
    ['confirmation precedes preview',m=>m.attestation.attestedAt=9700,'MANUAL_PREVIEW_STALE'],
    ['retry',m=>m.attestation.action='retry','MANUAL_ACTION_FORBIDDEN'],
    ['success',m=>m.attestation.action='mark_success','MANUAL_ACTION_FORBIDDEN'],
    ['autonomous',m=>m.attestation.action='enable_autonomous','MANUAL_ACTION_FORBIDDEN']
  ];
  for(const [label,change,code] of changes){const f=manualFixture();change(f.manual!);assert.deepEqual(evaluateRecoveryRelease(f),{allowed:false,code},label);}
});

test('strict validation rejects malformed, unknown, negative, fractional and unbounded facts without throwing',()=>{
  for(const input of [null,undefined,[],{},'facts',42])deny(input,'INVALID_RECOVERY_FACTS');
  const mutations:Array<(f:Record<string,any>)=>void>=[
    f=>f.now=NaN,f=>f.now=Infinity,f=>f.now=-1,f=>f.now=Number.MAX_SAFE_INTEGER+1,
    f=>f.operation.scope.generation=0,f=>f.operation.scope.generation=1.5,f=>f.operation.scope.operationId='',
    f=>f.operation.process.pid=0,f=>f.operation.recoveryRevision=-1,f=>f.operation.scope.nativeTurnId=undefined,
    f=>f.profile.requirements.processClosed='true',f=>f.profile.requirements.descendants='unknown',
    f=>f.profile.freshness.proofMaxAgeMs=0,f=>f.profile.freshness.checkMaxAgeMs=Infinity,
    f=>f.profile.manual.replaceable=['kill_requested'],f=>f.liveness.process='probably_stopped',
    f=>f.workspaceCheck.conflictingWriter=false,f=>f.proofs.process.kind='pid_absent',
    f=>f.nonProofs=['custom'],f=>f.ownership.identity=true,f=>f.route='retry',f=>f.level='bogus',
    f=>f.extraBrowserAssertion=true,f=>delete f.persistence.recovery,
    f=>f.proofs.session.unexpected='field',f=>f.operation.scope.nativeSessionId=null
  ];
  for(const mutate of mutations){const f=fixture();mutate(f);deny(f,'INVALID_RECOVERY_FACTS');}
});

test('manual recovery cannot substitute for unknown native, process or ownership identity',()=>{
  const process=manualFixture();Object.assign(process.operation,{process:null});deny(process,'PROCESS_IDENTITY_UNKNOWN');
  const session=manualFixture();Object.assign(session.operation.scope,{nativeSessionId:null,nativeTurnId:null});deny(session,'NATIVE_IDENTITY_UNKNOWN');
  for(const state of ['unknown','mismatch']){const f=manualFixture();f.ownership.identity=state;deny(f,'OWNERSHIP_UNVERIFIED');}
  const auth=fixture();auth.profile.environment.authMode='unknown';auth.operation.environment.authMode='unknown';deny(auth,'PROFILE_UNQUALIFIED');
});

test('pre-dispatch failure proves only no owned child, with no PID or acknowledged native session',()=>{
  const f=fixture();Object.assign(f.operation,{process:null,dispatch:'not_dispatched'});
  Object.assign(f.operation.scope,{nativeSessionId:null,nativeTurnId:null});
  f.ownership.scope={...f.operation.scope};f.workspaceCheck.scope={...f.operation.scope};
  Object.assign(f.proofs,{process:{kind:'pre_dispatch_spawn_failure',scope:{...f.operation.scope},observedAt:9000,observerIncarnation:'owner-1',process:null},session:null,descendants:null});
  f.profile.requirements.sessionTerminal=false;f.profile.requirements.sessionStates=[];f.profile.requirements.descendants='none_permitted';
  const result=evaluateRecoveryRelease(f);assert.equal(result.allowed,true);
  if(result.allowed)assert.deepEqual(result.basis.proofs,['process_closed','descendants_not_permitted_by_profile']);
  f.operation.dispatch='unknown';deny(f,'NATIVE_IDENTITY_UNKNOWN');
});

test('idle session and absence of descendants require explicit profile qualifications',()=>{
  const f=fixture();f.proofs.session.state='idle';deny(f,'SESSION_STATE_UNQUALIFIED');
  f.profile.requirements.sessionStates=['terminal','idle'];assert.equal(evaluateRecoveryRelease(f).allowed,true);
  f.profile.requirements.descendants='none_permitted';deny(f,'DESCENDANT_PROFILE_CONTRADICTION');
  Object.assign(f.proofs,{descendants:null});const result=evaluateRecoveryRelease(f);assert.equal(result.allowed,true);
  if(result.allowed)assert.deepEqual(result.basis.proofs,['process_closed','session_terminal','descendants_not_permitted_by_profile']);
});

test('stale owner, future observations, unrelated workspace scope and nonquarantine states deny release',()=>{
  const cases:Array<[(f:Record<string,any>)=>void,string]>=[
    [f=>f.ownership.checkedAt=9000,'OWNERSHIP_CHECK_STALE'],[f=>f.ownership.checkedAt=10001,'OWNERSHIP_CHECK_STALE'],
    [f=>f.workspaceCheck.checkedAt=10001,'WORKSPACE_CHECK_STALE'],[f=>f.workspaceCheck.scope.generation++,'WORKSPACE_SCOPE_MISMATCH'],
    [f=>f.proofs.process.observedAt=10001,'EVIDENCE_STALE'],[f=>f.proofs.process.observedAt=999,'EVIDENCE_STALE'],
    [f=>f.profile.qualification.qualifiedAt=1001,'PROFILE_UNQUALIFIED'],[f=>f.operation.state='released','NOT_QUARANTINED'],
    [f=>f.ownership.ownerLiveness='unknown','OWNER_LIVENESS_UNPROVEN']
  ];
  for(const [mutate,code] of cases){const f=fixture();mutate(f);deny(f,code);}
  const f=manualFixture();f.manual=null;deny(f,'MANUAL_REQUIRED');
});

test('sparse arrays, inherited values, duplicate claims and accessor facts fail strict validation',()=>{
  const f=fixture();f.nonProofs=new Array(1);deny(f,'INVALID_RECOVERY_FACTS');
  const children=fixture();children.proofs.descendants.childIds=new Array(1);deny(children,'INVALID_RECOVERY_FACTS');
  const duplicate=fixture();duplicate.profile.manual.replaceable=['process_closed','process_closed'];deny(duplicate,'INVALID_RECOVERY_FACTS');
  const getter=fixture();Object.defineProperty(getter,'now',{get(){throw new Error('must not execute fact accessors');},enumerable:true});deny(getter,'INVALID_RECOVERY_FACTS');
  const inherited=fixture();Object.setPrototypeOf(inherited,{authority:'trusted'});deny(inherited,'INVALID_RECOVERY_FACTS');
});

test('a new manager cannot use a stored handle or PID without stable OS identity for manual inspection',()=>{
  const f=manualFixture();f.managerIncarnation='owner-after-restart';
  Object.assign(f.operation.process,{bootId:null,startId:null});deny(f,'PROCESS_IDENTITY_UNKNOWN');
  Object.assign(f.operation.process,{bootId:'boot-1'});deny(f,'PROCESS_IDENTITY_UNKNOWN');
  Object.assign(f.operation.process,{startId:'start-1'});assert.equal(evaluateRecoveryRelease(f).allowed,true);
  // A previously persisted exact-child close remains evidence from its original
  // observer; restarting does not turn a current PID observation into that proof.
  const persisted=fixture();persisted.managerIncarnation='owner-after-restart';
  Object.assign(persisted.operation.process,{bootId:null,startId:null});
  Object.assign(persisted.proofs.process.process,{bootId:null,startId:null});
  assert.equal(evaluateRecoveryRelease(persisted).allowed,true);
});
