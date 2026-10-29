import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const script=join(dirname(fileURLToPath(import.meta.url)),'route.mjs');
function ledger(){
  const dir=mkdtempSync(join(tmpdir(),'orbit-model-ledger-'));
  const run=(...args)=>{const r=spawnSync(process.execPath,[script,...args],{env:{...process.env,ORBIT_MODEL_LEDGER:dir},encoding:'utf8'});return {code:r.status,out:JSON.parse(r.stdout)};};
  return {run,dir,close:()=>rmSync(dir,{recursive:true,force:true})};
}
const verify=(l,...models)=>{for(const m of models)l.run('availability','--model',m,'--observed','claude-'+m,'--evidence','probe/'+m+'.json');};

test('class routing: general work to sonnet, hard work to opus; reselect keeps the model',()=>{
  const l=ledger();try{
    verify(l,'sonnet','opus');
    assert.equal(l.run('select','--task','ui-1','--class','ui','--sha','a').out.model,'sonnet');
    assert.equal(l.run('select','--task','rec-1','--class','recovery','--sha','a').out.model,'opus');
    assert.equal(l.run('select','--task','ui-1','--class','security','--sha','b').out.reused,true);
    assert.equal(l.run('select','--task','x','--class','ui','--sha','a').out.model,'sonnet');
  }finally{l.close();}
});

test('unverified model is never selected; fable used only after verification',()=>{
  const l=ledger();try{
    assert.equal(l.run('select','--task','t','--class','impl','--sha','a').code,3);
    verify(l,'sonnet','opus');
    l.run('select','--task','t','--class','impl','--sha','a');
    l.run('record','--task','t','--result','fail','--sha','a','--verify','tsc fail','--fingerprint','F1');
    assert.equal(l.run('escalate','--task','t','--reason','code_defect','--fingerprint','F1','--sha','a','--evidence','log').out.model,'opus');
    l.run('record','--task','t','--result','fail','--sha','b','--verify','test fail','--fingerprint','F1');
    const top=l.run('escalate','--task','t','--reason','code_defect','--fingerprint','F1','--sha','b','--evidence','log');
    assert.equal(top.out.escalated,false,'no fable without verification: bounded retry on opus');
    verify(l,'fable');
    assert.equal(l.run('escalate','--task','t','--reason','code_defect','--fingerprint','F1','--sha','b','--evidence','log').out.model,'fable');
  }finally{l.close();}
});

test('environment, capacity, quota and approval failures never escalate; attempts are bounded',()=>{
  const l=ledger();try{
    verify(l,'sonnet','opus','fable');
    l.run('select','--task','t','--class','test','--sha','a');
    l.run('record','--task','t','--result','fail','--sha','a','--verify','x','--fingerprint','F');
    for(const reason of ['environment','provider_capacity','quota_exhausted','approval_blocked']){
      const r=l.run('escalate','--task','t','--reason',reason,'--fingerprint','F','--sha','a','--evidence','e');
      assert.equal(r.code,3);assert.equal(r.out.error,'NOT_A_MODEL_PROBLEM');assert.equal(r.out.model,'sonnet');
    }
    assert.equal(l.run('escalate','--task','t','--reason','code_defect','--fingerprint','OTHER','--sha','a','--evidence','e').out.error,'NO_RECORDED_FAILURE_ON_CURRENT_MODEL');
    l.run('escalate','--task','t','--reason','code_defect','--fingerprint','F','--sha','a','--evidence','e');
    for(let i=0;i<3;i++)l.run('record','--task','t','--result','fail','--sha','a','--verify','x','--fingerprint','F');
    const capped=l.run('escalate','--task','t','--reason','code_defect','--fingerprint','F','--sha','a','--evidence','e');
    assert.equal(capped.out.error,'ATTEMPT_LIMIT_REACHED');
    const shown=l.run('show','--task','t').out;
    assert.ok(shown.events.some(e=>e.type==='escalation_denied'&&e.sha==='a'&&e.evidence==='e'),'denials keep sha and evidence');
  }finally{l.close();}
});
