import type { ProviderStatus } from './types.ts';

export type NativeProbe={status:'found'|'not_found_on_path'|'failed'|'unknown';version:string|null};
export interface NativeProbeReport {checkedAt:string;codex:NativeProbe;claude:NativeProbe}
export type CapabilityId='session'|'streaming'|'resume'|'interrupt'|'planning'|'review'|'verification'|'skills'|'mcp'|'hooks'|'plugins'|'subagents'|'teams'|'goal'|'usage';
export interface Capability {
  id:CapabilityId;label:string;
  documented:'supported'|'conditional'|'unknown';interfaces:string[];sources:string[];
  runtime:'confirmed'|'unknown';
  effective:'available'|'connection_required'|'blocked_policy'|'not_connected';
  verification:'contract_tests'|'not_tested';note:string;
}
export interface AgentCapabilities {
  id:'codex'|'claude';name:string;nativeProbe:NativeProbe;
  connection:ProviderStatus|'not_connected';authStatus:'connected'|'required'|'unknown';
  authPolicy:string;
  billing:{source:'unknown';remaining:null;resetAt:null;costUsd:null;note:string};
  capabilities:Capability[];
}
export interface CapabilityRegistry {
  schemaVersion:1;documentedAt:string;generatedAt:string;probedAt:string|null;
  providers:AgentCapabilities[];
  boundaries:string[];
}
