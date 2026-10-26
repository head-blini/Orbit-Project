import type {VerificationCommandPreview} from './verification.ts';

export interface VerificationSetupCandidate {
  profileId:'node-test-v1';label:string;sourceDigest:string;baseSha:string;tests:string[];
  command:VerificationCommandPreview;previewDigest:string;
}
export interface VerificationSetupView {
  projectId:string;workspaceId:string;revision:number;lastRequestId:string|null;
  source:'none'|'host'|'preset';commands:VerificationCommandPreview[];
  candidate:VerificationSetupCandidate|null;
  issue:'NO_NODE_TEST_FILES'|'HOST_CONFIGURATION'|'SOURCE_UNAVAILABLE'|'TOO_MANY_TEST_FILES'|null;
  scope:string;
}
export interface ConfigureVerificationInput {
  requestId:string;profileId:'node-test-v1';expectedPreviewDigest:string;confirmed:boolean;
}
export interface VerificationSetupReceipt {
  requestId:string;projectId:string;workspaceId:string;revision:number;profileId:'node-test-v1';createdAt:string;
}
