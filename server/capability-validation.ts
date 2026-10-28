import type {CapabilityEntry,OrchestrationRegistry,RuntimeId} from '../shared/capability-orchestration.ts';
import type {Store} from './store.ts';
import {providerExecutionEvidence} from './provider-evidence.ts';
import {qualityRunEvidence} from './quality-loop-native.ts';

/** Read-only history projection. Metadata and connection state cannot increment validation. */
export function enrichCapabilityValidation<T extends OrchestrationRegistry>(registry:T,store:Store):T {
 const result=structuredClone(registry),empty=()=>({nativeRuns:0,mockRuns:0,unknownRuns:0,lastRunId:null as string|null});
 for(const provider of result.providers)for(const capability of provider.capabilities)capability.validation=empty();
 for(const run of store.runs()){
  if(run.execution!=='completed'||!run.taskId)continue;
  const runtime:RuntimeId=run.runtime??'codex',provider=result.providers.find(item=>item.runtimeId===runtime);
  if(!provider)continue;
  const evidence=providerExecutionEvidence(store,run,null);
  const bucket=evidence.source==='mock'?'mockRuns':evidence.source==='native'&&evidence.executionObserved?'nativeRuns':'unknownRuns';
  const count=(id:CapabilityEntry['id'])=>{const validation=provider.capabilities.find(item=>item.id===id)?.validation;if(validation){validation[bucket]++;validation.lastRunId=run.id;}};
  count(runtime==='codex'?'execute.code':'execute.general');
  if(qualityRunEvidence(store,run).source==='native_observed')count('model.actual');
 }
 return result;
}
