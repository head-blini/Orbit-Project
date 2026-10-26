# Provider connections and outbound inspection

Integration update (2026-10-25): fixed mock transport, server-owned block policies, authenticated HTTP/UI and Codex preflight/input inspection are connected. The original handoff below describes the standalone module. See [product integration results](../ORBIT-INTEGRATION-RESULTS.md). No real external adapter transport has been enabled.

This is an independently testable, mock-only server module. It does not connect to Bedrock, LiteLLM, vLLM, or FreeLLMAPI, discover credentials, configure authentication, or grant coding-agent capabilities. No new dependencies are required. Existing Controller, HTTP, SQLite, Codex RPC approvals, MCP isolation, and workspace policy remain authoritative and unchanged.

## Integration boundary

`server/guardrails/outbound.ts` exports `inspectOutbound(text)` and `createOutboundGuardrail(configuration)`. The factory exposes `evaluateOutbound(destinationId, text)` and `destination(id)`. The latter returns a frozen server policy snapshot or undefined. `evaluateOutbound` accepts only a destination ID; callers cannot pass a policy as the destination. The factory must be constructed exclusively from trusted server configuration, never from browser/import/provider input. Construct a replacement instance when configuration is revoked or changed; existing instances deliberately retain their immutable snapshots.

Configuration entries have exactly these fields:

```ts
{
  destinationId: 'review-proxy',
  providerId: 'litellm', // bedrock | litellm | vllm | freellmapi
  classification: 'external', // local | external
  endpoint: 'https://proxy.example.test/v1',
  action: 'mask' // block | mask | allow
}
```

Any malformed entry or duplicate ID invalidates the entire registry. An empty registry is valid and denies every destination. Server configuration is copied, validated, and frozen. There is no implicit provider fallback or default endpoint.

`server/providers/connections.ts` exports `createProviderAdapters(configuration, transport)` returning `bedrock`, `litellm`, `vllm`, and `freellmapi` adapters. Each has `id`, `status: 'mock_only'`, and `send(input)`. Requests must contain exactly `{destinationId, text}`; extra keys, arrays, inherited fields and accessors are rejected. The selected adapter must match the configured provider. The injected transport receives only `{destinationId, providerId, endpoint, payload}` and returns `Promise<{text:string}>`. It receives the exact configured endpoint and the already checked/masked payload. Rejections never call transport. Success returns `{ok:true, text}`; failure returns `{ok:false, code}` with no raw exception, stack, input, or response. The implementation has no logging calls.

Transport is a trusted server dependency, not a sandbox for arbitrary JavaScript. Only synthetic in-memory mock implementations have been tested. There is no HTTP/SDK serialization, retry, cancellation, streaming, model selection, or authentication implementation. A successful mock response does not mean a provider is connected, a coding run completed, or verification passed. Provider response text is returned as content, not diagnostic text; it must never be logged as a safe audit record or treated as executable markup.

## Policy semantics

Credentials matching the documented patterns are always blocked, including under `allow` and for local destinations. With personal data, `block` rejects, `mask` replaces all detected spans with `[REDACTED]`, and an explicitly configured `allow` permits the text. Clean text passes all three actions. Overlapping and adjacent spans are merged before replacement. Neither diagnostics nor denials include matched values. Inspection locations are half-open UTF-16 string offsets, not UTF-8 byte offsets.

Input and response text are limited to 256 KiB UTF-8. `evaluateOutbound` rejects invalid and oversized input with fixed codes. Direct `inspectOutbound` calls outside its string/size contract throw only `INVALID_INSPECTION_INPUT`. Inspection returns `{kind,start,end}[]`. Error codes are `INVALID_CONFIGURATION`, `UNKNOWN_DESTINATION`, `INVALID_PAYLOAD`, `PAYLOAD_TOO_LARGE`, `CREDENTIAL_DETECTED`, `PERSONAL_DATA_BLOCKED`, `INVALID_REQUEST`, `PROVIDER_MISMATCH`, and `PROVIDER_ERROR`.

Endpoints use a deliberately narrow syntax: an explicit http(s) scheme, host, optional nonzero valid port, and an optional ASCII path containing letters, digits, slash, dot, underscore, tilde, or hyphen. Credentials in URLs, queries, fragments, percent escapes, whitespace, backslashes and parser-normalized alternate IP forms are rejected. Local destinations require literal `127.0.0.1` or `[::1]`. External destinations require HTTPS and a syntactically valid dotted DNS host; IP literals and localhost/local/internal suffixes are rejected. No endpoint is inferred from text. This validates syntax and classification only: DNS resolution, private-address resolution, redirects, proxy behavior, TLS, and Bedrock region/host ownership are unverified. A future network transport must independently enforce destination and redirect/DNS restrictions and receive separate authorization.

## Detector coverage and limits

Synthetic tests cover:

- ASCII email local parts (up to 64 characters) and DNS-style domain labels.
- Korean mobile numbers beginning `010`, `011`, `016`, `017`, `018`, or `019`, including `+82`; North American `+1` numbers. Optional spaces/hyphens and North American area-code parentheses are supported.
- Korean national-ID-shaped 13-digit values, optionally separated after six digits, and US SSN-shaped values. No validity/checksum inference is made.
- Key/value assignments for API keys, access/refresh/session tokens, secret/secret-key/secret-access-key, password and authorization. One optional alphanumeric provider prefix is supported, including `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `OPENAI_API_KEY`, and `LITELLM_API_KEY`; JSON quote syntax is supported.
- Bearer tokens; `sk-` keys; AWS `AKIA`/`ASIA` access-key shapes; common GitHub token prefixes; `eyJ` JWT shapes; PEM private-key headers.

This is heuristic defense in depth, not comprehensive DLP. Names, addresses, arbitrary unlabelled secrets, most international phone formats, Unicode/quoted email formats, encoding/obfuscation, split messages, and arbitrary proprietary credentials can be missed. Pattern-shaped ordinary values may be false positives. No decoding or cross-request secret reconstruction occurs. A passing scan does not establish that content is free of confidential information. Common maximum-size ASCII input has a regression bound to prevent the email detector's earlier quadratic scan.

## Missing owner-supplied contracts and integration requests

`shared/parallel.ts` and `tests/parallel-contracts.test.ts` were absent at implementation time. The ownership contract forbids independently creating those files or duplicate named shared contracts. Consequently this implementation uses locally inferred function signatures, does not declare the reserved `ConnectionProviderId`, `DestinationPolicy`, or `ProviderTransport` names, and does not claim shared-contract conformance has been tested.

The integration owner must supply the common types and contract tests, reconcile these structural signatures with them, and then implement/import the planned `ProviderDescriptor`, `LaunchContext`, and `evaluateLaunch` boundary. Those Codex preflight contracts are absent from the current checkout and were not independently recreated. Existing Codex execution/security tests remain unchanged.

The owner must also provide trusted configuration lifecycle/authorization, any HTTP/DB/UI wiring, and audit records limited to fixed codes and non-sensitive metadata. Do not route browser-supplied policies into either factory. No product entrypoint imports this module yet. No new UI, API, persistence, real provider support, or Phase gate passage is claimed by this change.

TASK.md requests `docs/PARALLEL-provider-guardrail-RESULTS.md`, but CONTRACT.md permits only `docs/provider-guardrail/**` and TASK.md says to leave conflicting work unchanged and report it. Results therefore live at `docs/provider-guardrail/RESULTS.md`; the integration owner can aggregate them in the root parallel status report.
