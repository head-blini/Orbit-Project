import type {NativeProbe,NativeProbeReport} from './capabilities.ts';
import type {ExtensionInventory} from './extensions.ts';

export type OrchestrationCapabilityId='execute.code'|'execute.general'|'plan'|'review.text'|'model.actual'|'skills'|'slash_commands'|'hooks'|'mcp'|'resume'|'interrupt';
export type RuntimeId='codex'|'claude-code';
export interface CapabilityEntry {
  id:OrchestrationCapabilityId;
  implementation:'implemented'|'unsupported'|'unknown';
  observation:'confirmed'|'unknown';
  policy:'allowed'|'blocked';
  evidence:string[];
}
export interface ProviderCapabilityView {
  runtimeId:RuntimeId;version:string|null;installation:NativeProbe['status'];
  connection:'ready'|'unknown';authentication:'confirmed'|'unknown';
  capabilities:CapabilityEntry[];
}
export interface OrchestrationRegistry {
  schemaVersion:1;observedAt:string|null;providers:ProviderCapabilityView[];
  actualModel:'unknown';executionAuthorized:false;
}
export interface CapabilityDiscoveryInput {
  probe:NativeProbeReport|null;codexReady:boolean;extensions?:ExtensionInventory;
}
/** Discovery describes existing adapters; it cannot launch processes or grant permission. */
export interface ProviderCapabilityAdapter {
  readonly runtimeId:RuntimeId;
  discover(input:CapabilityDiscoveryInput):ProviderCapabilityView;
}
