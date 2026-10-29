import type {HttpModelProviderId} from './model-hub.ts';

export type RegistryOrigin='user'|'env'|'builtin';
export type RegistryAuth=
  | {kind:'native_session'}
  | {kind:'env_ref';env:string}
  | {kind:'aws_env_refs';accessKeyId:string;secretAccessKey:string;sessionToken:string|null}
  | {kind:'none'}
  | {kind:'declared';method:'native_session'|'browser_session'|'external'|'none'|'unknown'};
export type RegistryRuntimeAdapterId='codex'|'claude-code'|'other-cli'|'web';
export type RegistryConnection=
  | {adapterId:HttpModelProviderId;endpoint:string;locality:'loopback'|'external';auth:Extract<RegistryAuth,{kind:'env_ref'|'none'}>;projectPaths:string[];timeoutMs:number;maxOutputTokens:number}
  | {adapterId:'bedrock';cliPath:string;region:string;auth:Extract<RegistryAuth,{kind:'aws_env_refs'}>;projectPaths:string[];timeoutMs:number;maxOutputTokens:number}
  | {adapterId:'codex'|'claude-code';auth:Extract<RegistryAuth,{kind:'native_session'}>}
  | {adapterId:'other-cli'|'web';auth:Extract<RegistryAuth,{kind:'declared'}>};

export interface RegistryCost {
  kind:'subscription'|'metered_api'|'local_resource'|'unknown';
  source:'user_declared'|'provider_reported'|'unknown';
  checkedAt:string|null;sourceUrl:string|null;currency:string|null;unit:string|null;unitPrice:number|null;
}
interface RegistryMetadata {
  id:string;label:string;
  /** User declarations are metadata, never CapabilityEntry or execution permission. */
  declaredCapabilities:string[];
  cost:RegistryCost;
}
export type RegistryEntryBody=RegistryMetadata&(
  | {kind:'provider';connection:RegistryConnection}
  | {kind:'runtime';providerId:string;adapterId:RegistryRuntimeAdapterId}
  | {kind:'model';providerId:string;modelId:string}
);
export type RegistryEntry=RegistryEntryBody&{
  origin:RegistryOrigin;revision:number;enabled:boolean;createdAt:string;updatedAt:string;
};
type RegistryInput<T>=T extends RegistryEntryBody?Omit<T,'declaredCapabilities'|'cost'>&{
  origin?:'user';enabled?:boolean;declaredCapabilities?:string[];cost?:RegistryCost;
}:never;
/** Update replaces the full body; omitted metadata uses the same defaults as create. */
export type RegistryEntryInput=RegistryInput<RegistryEntryBody>;
export interface RegistryUpdate {expectedRevision:number;entry:RegistryEntryInput}
export interface RegistryDisable {expectedRevision:number}

/** Immutable evidence is current only for its revision AND effective config digest. */
export interface RegistryValidation {
  id:string;requestId:string;entryId:string;revision:number;configDigest:string;requestDigest:string;
  kind:'local'|'connection';state:'intent'|'passed'|'failed'|'unsupported'|'unknown';
  createdAt:string;finishedAt:string|null;evidenceRefs:string[];
  code:'REGISTRY_LOCAL_VALID'|'REGISTRY_CONNECTION_VERIFIED'|'REGISTRY_VALIDATION_FAILED'|'REGISTRY_ADAPTER_UNSUPPORTED'|'REGISTRY_VALIDATION_UNKNOWN'|null;
}
