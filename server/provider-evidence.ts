import {createHash} from 'node:crypto';
import type {Run} from '../shared/types.ts';
import type {ProviderExecutionEvidence} from '../shared/provider-evidence.ts';
import type {QualityLoopRecord} from '../shared/quality-loop-record.ts';
import type {Store} from './store.ts';

export function providerExecutionEvidence(store:Store,run:Run|null|undefined,quality:QualityLoopRecord|null):ProviderExecutionEvidence {
 const event=(kind:string)=>{const row=run&&store.db.prepare('SELECT data FROM events WHERE run_id=? AND kind=? ORDER BY seq DESC LIMIT 1').get(run.id,kind);return row?JSON.parse(String(row.data)):null;};
 const origin=event('run.runtime_source'),outcome=event('run.runtime_outcome');
 const source=origin?.source==='mock'||outcome?.source==='mock'?'mock':origin?.source==='native'&&(origin.interface!=='claude.print'||outcome?.source==='native')?'native':'unknown';
 const providerInterface=origin?.interface==='codex.app_server'?'codex.app_server':origin?.interface==='claude.print'?'claude.print':'unknown';
 const executionObserved=!!run&&(providerInterface==='codex.app_server'?!!run.turnId:providerInterface==='claude.print'&&outcome?.dispatch==='started'&&outcome?.exit==='observed');
 const status=quality?.result.status;
 const qualityStatus=!quality?'not_started':status==='passed'?'passed':status==='blocked'?'blocked':status==='reviewing'||status==='repairing'?'running':'failed';
 const aiSteps=quality?.steps.filter(step=>step.kind==='review'||step.kind==='repair')??[];
 return {source,interface:providerInterface,executionObserved,
  responseDigest:executionObserved&&run?.response?createHash('sha256').update(run.response).digest('hex'):null,
  quality:qualityStatus,livePipelineVerified:source==='native'&&executionObserved&&run?.execution==='completed'&&qualityStatus==='passed'&&quality?.verification.status==='passed'&&!quality.recoveryRequired&&quality.producer.evidenceSource==='native'&&aiSteps.some(step=>step.kind==='review')&&aiSteps.every(step=>step.state==='completed'&&step.evidence?.evidenceSource==='native'),costUsd:null,remainingQuota:null};
}
