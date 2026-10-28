import type {CodexModelAttribution} from '../../shared/codex-model-attribution.ts';
import {containsCredential} from '../privacy.ts';

/** IDs from native protocol metadata, never inferred from a requested model or prose. */
export interface NativeIdentity {
  providerId:string;modelId:string;sessionId:string|null;executionId:string|null;
  modelEvidence:'assistant_message'|'unknown';
  codex?:CodexModelAttribution;
}
export function nativeModelId(value:unknown):string|null {
  return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value)&&value!=='unknown'&&!containsCredential(value)?value:null;
}
