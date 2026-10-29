import type {NativeProbe,NativeProbeReport} from './capabilities.ts';
import type {ExtensionInventory} from './extensions.ts';
import type {ToolAggregate} from './tool-capabilities.ts';

export type OrchestrationCapabilityId='execute.code'|'execute.general'|'plan'|'review.text'|'model.actual'|'skills'|'slash_commands'|'hooks'|'mcp'|'resume'|'interrupt'|'status'|'result'|'subagents';
export type RuntimeId='codex'|'claude-code';
export type CapabilitySupport='implemented'|'unsupported'|'unknown';
export interface CapabilityEntry {
  id:OrchestrationCapabilityId;
  /** Current Orbit adapter support, not proof a native operation succeeded. */
  discovery:CapabilitySupport;invocation:CapabilitySupport;verification:CapabilitySupport;
  implementation:'implemented'|'unsupported'|'unknown';
  observation:'confirmed'|'unknown';
  policy:'allowed'|'blocked';
  evidence:string[];
  /** Historical completed task runs; never a permission or model identity assertion. */
  validation?:{nativeRuns:number;mockRuns:number;unknownRuns:number;lastRunId:string|null};
}
export interface ProviderCapabilityView {
  runtimeId:RuntimeId;version:string|null;installation:NativeProbe['status'];
  connection:'ready'|'unknown';authentication:'confirmed'|'unknown';
  capabilities:CapabilityEntry[];
}
export interface OrchestrationRegistry {
  schemaVersion:1;observedAt:string|null;providers:ProviderCapabilityView[];
  actualModel:'unknown';executionAuthorized:false;
  /** Independent per-item tool states; permission never implies native verification. */
  tools?:ToolAggregate;
}
export interface CapabilityDiscoveryInput {
  probe:NativeProbeReport|null;codexReady:boolean;extensions?:ExtensionInventory;
}
/** Discovery describes existing adapters; it cannot launch processes or grant permission. */
export interface ProviderCapabilityAdapter {
  readonly runtimeId:RuntimeId;
  discover(input:CapabilityDiscoveryInput):ProviderCapabilityView;
}
