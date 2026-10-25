import { connectionProviderIds, createOutboundGuardrail, MAX_OUTBOUND_BYTES, readDataRecord } from '../guardrails/outbound.ts';

/** Mock transport boundary only. No network implementation, auth discovery, or execution capabilities. */
export function createProviderAdapters(configuration: readonly unknown[], transport: {
  send(request: {
    destinationId:string;
    providerId:typeof connectionProviderIds[number];
    endpoint:string;
    payload:string;
  }): Promise<{text:string}>;
}) {
  const guardrail = createOutboundGuardrail(configuration);
  function adapter(providerId: typeof connectionProviderIds[number]) {
    return Object.freeze({
      id:providerId,
      status:'mock_only' as const,
      async send(input: unknown) {
        let request: Record<string, unknown> | null;
        try { request = readDataRecord(input, ['destinationId', 'text']); }
        catch { return {ok:false as const, code:'INVALID_REQUEST' as const}; }
        if (!request) return {ok:false as const, code:'INVALID_REQUEST' as const};
        const decision = guardrail.evaluateOutbound(request.destinationId, request.text);
        if (!decision.allowed) return {ok:false as const, code:decision.code};
        // Evaluation has established that this exact destination exists in the private snapshot.
        const destination = guardrail.destination(request.destinationId as string)!;
        if (destination.providerId !== providerId) return {ok:false as const, code:'PROVIDER_MISMATCH' as const};
        try {
          const response = await transport.send(Object.freeze({
            destinationId:destination.destinationId, providerId,
            endpoint:destination.endpoint, payload:decision.payload,
          }));
          const data = readDataRecord(response, ['text']);
          if (!data || typeof data.text !== 'string' || Buffer.byteLength(data.text, 'utf8') > MAX_OUTBOUND_BYTES)
            return {ok:false as const, code:'PROVIDER_ERROR' as const};
          return {ok:true as const, text:data.text};
        } catch {
          // No raw exception, cause, stack, endpoint, input, or provider response in errors or logs.
          return {ok:false as const, code:'PROVIDER_ERROR' as const};
        }
      },
    });
  }
  return Object.freeze({
    bedrock:adapter('bedrock'), litellm:adapter('litellm'),
    vllm:adapter('vllm'), freellmapi:adapter('freellmapi'),
  });
}
