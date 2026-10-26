import { connectionProviderIds,inspectOutbound } from '../guardrails/outbound.ts';
import { createProviderAdapters } from './connections.ts';
import type { DestinationPolicy,GuardrailDecision,LaunchContext } from '../../shared/parallel.ts';

const policies:DestinationPolicy[]=connectionProviderIds.map(providerId=>({destinationId:providerId,providerId,classification:'external',endpoint:'https://mock.invalid',action:'block'}));
// No fetch, SDK, socket, credential access or injectable browser transport. Endpoint is never contacted.
const adapters=createProviderAdapters(policies,{async send(){return {text:'Synthetic mock response. No external request was sent.'};}});
export const providerConnections=connectionProviderIds.map(id=>({id,status:'mock_only' as const,externalApiEnabled:false,coding:false}));
export function sendMock(providerId:unknown,text:unknown){
  if(!connectionProviderIds.some(id=>id===providerId))return Promise.resolve({ok:false as const,code:'UNKNOWN_PROVIDER'});
  return adapters[providerId as typeof connectionProviderIds[number]].send({destinationId:providerId,text});
}
export function outboundDenial(text:string):string|null {
  const findings=inspectOutbound(text);
  return findings.some(f=>f.kind==='credential')?'CREDENTIAL_LIKE_INPUT':findings.length?'PERSONAL_DATA_BLOCKED':null;
}
export function evaluateLaunch(context:Readonly<LaunchContext>):GuardrailDecision {
  if(context.expectedWorkspaceId!==context.selectedWorkspaceId)return {allowed:false,code:'WORKSPACE_MISMATCH'};
  if(context.provider.status!=='ready')return {allowed:false,code:'NOT_CONNECTED'};
  if(!context.workspaceValidated||!context.policyValidated||!context.mcpIsolated||context.provider.capabilities.mcp!=='disabled'||context.provider.capabilities.approvals!=='deny'||context.provider.capabilities.shell!==false)return {allowed:false,code:'POLICY_MISMATCH'};
  if(context.selectedWorkspaceId&&(!context.writeEnabled||!context.provider.capabilities.patch))return {allowed:false,code:'WRITES_DISABLED'};
  return {allowed:true};
}
