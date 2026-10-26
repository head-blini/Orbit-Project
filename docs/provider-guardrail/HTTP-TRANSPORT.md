# Native HTTP provider transport

Date: 2026-10-25. Module: `server/providers/http-transport.ts`. This is an opt-in native HTTP transport boundary, not an enabled product connection. Existing mock adapters, Controller, HTTP routes, Store, provider policy and package dependencies are unchanged. No external model service or user credential was used to build or test it.

Output-token request-cap update: 2026-10-26. The new optional cap preserves existing callers with a default of 1,024. Its implementation/tests change only this transport boundary; product configuration and UI integration remain the integration owner's responsibility.

## Server-owned integration contract

`createHttpProviderTransport(config)` returns a frozen object with:

```ts
listModels(options?: {signal?: AbortSignal}): Promise<string[]>
chat(
  input: {model: string; messages: readonly HttpChatMessage[]},
  options?: {signal?: AbortSignal}
): AsyncIterable<HttpChatEvent>
```

The exported configuration and event types are local to this module; existing shared contracts are not replaced.

```ts
interface HttpChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
interface HttpTransportConfig {
  providerId: 'openai-compatible' | 'litellm' | 'vllm' | 'freellmapi' | 'local';
  endpoint: string; // API base, for example http://127.0.0.1:8000/v1
  approved: boolean;
  locality: 'loopback' | 'external';
  requireCredential: boolean; // Explicit server decision, including unauthenticated servers
  credential(): string | undefined;
  models: readonly string[]; // Explicit nonempty allowlist
  authorize(request: Readonly<{
    providerId: HttpTransportConfig['providerId'];
    endpoint: string;
    operation: 'models' | 'chat';
    model?: string;
    messages?: readonly HttpChatMessage[];
  }>): {allowed: false} | {allowed: true; messages?: readonly HttpChatMessage[]}
    | Promise<{allowed: false} | {allowed: true; messages?: readonly HttpChatMessage[]}>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxOutputTokens?: number; // Default 1024; integer 1..8192
}
type HttpChatEvent = {type: 'text'; text: string} | {
  type: 'done';
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    source: 'provider' | 'unknown';
  };
};
```

Construct this factory only from validated server configuration. Never forward a browser/import/model object as its configuration, callbacks, endpoint, model allowlist or approval. Construction performs no DNS, credential discovery or network operation. A diagnostic request is an explicit `listModels()` call and requires approval and authorization just like chat.

For each call the module checks `approved`, then invokes the required `authorize` callback with a copied/frozen request. That callback is the integration point for the server's current project/destination/outbound policy. Chat requires an explicit returned sanitized `messages` array; `{allowed:true}` alone fails closed. All system, user and assistant messages must be checked or masked by the callback. Only the returned messages are serialized. The transport has no unchecked raw-send method and does not infer an allow policy. Credential attachment and DNS/socket work occur after authorization.

Configuration, model lists, input messages and authorization results are copied before subsequent asynchronous work. Callbacks are trusted server code; they must not perform their own unapproved network requests. Replace the transport when configuration changes or is revoked, and have `authorize` consult current revocation/policy state on each operation. Mutating the original configuration intentionally does not mutate an existing instance.

Credentials remain in operation memory and the native Authorization header. No environment/auth files are read, no credential persistence or logging occurs, and raw callback/network/provider errors are not returned. The getter supplies only an optional bearer-header value; this module does not test whether an actual credential is valid. HTTP control characters and oversized header values are rejected. Local endpoints may explicitly omit credentials. The module does not obtain credentials, perform OAuth, sign AWS requests or load SDKs. **Bedrock is outside this module's scope.**

## Protocol and result semantics

The base endpoint receives `GET /models` or `POST /chat/completions` appended to its path. Chat sends only `{model,messages,stream:true,stream_options:{include_usage:true},max_tokens:maxOutputTokens}`. Every chat request includes the server-owned output-token cap. The selected model must already be in the configured allowlist. `listModels()` returns the intersection of that allowlist with the provider's valid `data[].id`, without trusting provider-supplied URLs, metadata or arbitrary model choices. Model discovery still requires approval/authorization before credential, DNS or socket work; adding a chat cap does not authorize discovery.

`maxOutputTokens` is optional only at construction: omission/undefined normalizes to 1,024 in the copied/frozen configuration. Explicit values must be integers from 1 through 8,192; null, strings, nonfinite numbers, fractions and out-of-range values fail before operations. A browser/input object cannot override it through `chat()`. Existing instances retain their approved snapshot if the caller later mutates its original configuration.

This cap is a **provider request parameter**, not a measured token counter or enforced spending ceiling. A deployment may reject, ignore or interpret `max_tokens` differently; compatibility and actual enforcement by any remote service are unverified. Input/prompt tokens are not covered. The transport does not infer API cost, change billing routes, promise refunds, or guarantee that disconnecting stops remote generation or charges. Hosts must display the requested cap and unknown cost without presenting them as verified provider compliance.

Chat supports text-only OpenAI-compatible SSE, LF/CRLF event boundaries, comment lines, fragmented JSON, fragmented UTF-8 characters, the `[DONE]` terminator and optional token usage. Tool/function chunks, malformed JSON/usage, invalid UTF-8, missing DONE, unsupported media types and compressed bodies are rejected. There is no automatic retry, provider fallback, tool execution, model routing or coding-agent capability in this module. Protocol similarity does not prove compatibility with a particular deployment.

**Text events are cumulative replacement snapshots, not deltas.** Replace the previous displayed value with `event.text`; do not append it. Raw fragments stay private until known credential patterns and an exact echo of the operation's bearer value have been removed. An unfinished trailing token is withheld until a delimiter or final DONE. Persist/emit only these snapshots, never wire chunks. The existing `safeText` patterns remain heuristic, not comprehensive DLP. A `done` event means the HTTP stream completed, not that code changed or verification passed.

Usage is copied only from nonnegative safe integer provider fields. Missing values stay `null`/`unknown`; totals, costs and quotas are not estimated. Valid partial usage may have source `provider` while individual absent fields remain null.

If any received usage event reports `completion_tokens` greater than the requested cap, the stream fails with fixed `PROVIDER_OUTPUT_LIMIT` and never emits `done`, even if a later wire event would report a smaller value. Equality is accepted. Missing completion usage stays unknown; prompt/total counts and output character length are not converted into estimated completion tokens. This is conservative after-the-fact response validation: text snapshots may already have been delivered and provider charges may already have occurred. A passing or missing usage report is not independent proof of cap enforcement, actual billing or code verification.

Defaults: 30-second overall deadline, 256 KiB response cap, 1,024 requested output tokens, 64,000 output UTF-16 characters, 16 KiB response header cap, 256 KiB serialized request cap and at most 100 messages. Trusted overrides allow 10–120,000 milliseconds, 64 bytes–1 MiB and 1–8,192 requested output tokens. Null/invalid limits fail closed. AbortSignal and deadline cover pending authorization, DNS, response headers and the body. Cancellation closes only this operation's request; a consumer that stops iteration also releases its response. System DNS lookup itself cannot be forcibly cancelled, but a late lookup/authorization resolution cannot start a request after cancellation. The timer does not make arbitrary synchronous callback code preemptible.

## Destination and network boundary

Endpoint syntax deliberately excludes credentials, query, fragment, whitespace, escapes, backslashes, dot-segment paths and alternate normalized IP spellings. Loopback requires literal `127.0.0.1` or `[::1]`, with an explicit locality setting; `localhost` is not resolved implicitly. External endpoints require HTTPS and a dotted DNS hostname, excluding local/internal suffixes and all IP literals.

Each external call resolves IPv4 A records, rejects the entire result if any returned address is private, loopback, link-local, shared-address, documentation/benchmark, multicast, reserved or invalid, then pins the request lookup to one approved public IPv4. It preserves the original hostname for Host/SNI and explicitly requires TLS certificate validation. External IPv6 destinations, IPv4-mapped IPv6 and IPv6-only hosts are unsupported and fail closed; dual-stack hosts can use their validated A records. Local literal `::1` is supported by the implementation but was not exercised by these IPv4 fixture tests.

Requests use native `http`/`https`, a one-use agent (`agent:false`), pinned lookup and disabled address-family auto-selection. No browser-supplied proxy, agent, TLS setting, headers or DNS override is accepted, and proxy environment variables are not passed into a custom proxy agent. Redirects are always rejected before following Location, including to the same origin. Credentials are never forwarded to a redirect target. There is no connection pooling across operations.

The local HTTP tests prove real request/stream parsing. External DNS classification and pinned TLS request options are tested with mocked DNS/native HTTPS boundaries to avoid real external traffic. They do **not** prove live DNS, TLS certificate/CA interoperability, adversarial network isolation, all proxy environments or remote provider compatibility. Host operating-system routing and trusted same-process code remain outside this module's isolation boundary.

## Fixed errors

Errors are `AppError` with fixed messages and no provider response, endpoint, input, key, Authorization header, exception cause or raw error body:

| Code | HTTP status |
|---|---:|
| `INVALID_PROVIDER_CONFIGURATION`, `INVALID_PROVIDER_REQUEST` | 400 |
| `PROVIDER_NOT_APPROVED`, `PROVIDER_OUTBOUND_DENIED`, `PROVIDER_DESTINATION_REJECTED` | 403 |
| `PROVIDER_ABORTED` | 409 |
| `PROVIDER_CREDENTIAL_REQUIRED`, `PROVIDER_RATE_LIMITED` | 503 |
| `PROVIDER_TIMEOUT` | 504 |
| `PROVIDER_REQUEST_FAILED`, `PROVIDER_REDIRECT_REJECTED`, `PROVIDER_AUTH_REQUIRED`, `PROVIDER_HTTP_ERROR`, `PROVIDER_INVALID_RESPONSE`, `PROVIDER_RESPONSE_TOO_LARGE`, `PROVIDER_OUTPUT_LIMIT`, `PROVIDER_STREAM_INCOMPLETE` | 502 |

## Verification

Environment for this module's tests: Windows, Node 24.19.0. No installation, service inference, authentication file access, user DB access, package change or commit.

- Initial stub: `node --test tests/provider-http-transport.test.ts`, exit 1, 15 expected failures.
- After implementation: same command, exit 0, 15/15.
- Added null-limit regression: exit 1, 17 pass / 1 fail; null limits incorrectly selected defaults.
- Fixed strict limits: same command, exit 0, **18/18**, no skipped tests.
- Type check initially found three module/test typing errors (RequestOptions autoSelectFamily and async return), all corrected. An intermediate whole-workspace check found a concurrently added `tests/verification.test.ts` missing `server/verification.ts`; that unrelated in-progress file was not modified. The final `node ../../node_modules/typescript/bin/tsc --noEmit` passed, exit 0, after integration supplied the file.

Fixtures cover approval/authorization, config/message snapshots, model selection, exact HTTP body, SSE/UTF-8 fragments/DONE/usage, input/output limits, redirects/status codes, pending authorization/DNS/header/body timeouts, abort, malformed data, split credentials and Authorization echoes, private/mapped/IPv6 DNS rejection and pinned TLS options. Only disposable loopback servers are started and they are closed in `finally`. Existing project-wide tests are the integration owner's responsibility after concurrent work settles.

Output-token cap regression (2026-10-26): `node --test tests/provider-http-transport.test.ts` first failed with 20 pass / 4 fail (exit 1) because the default wire field and explicit cap support were absent. After implementation, **24/24 passed, exit 0**. Real loopback request-body captures verify default 1,024, boundary 1/8,192 and explicit caps across all five existing provider IDs; caller mutation cannot alter the captured cap. Tests also verify invalid config/accessors, request override rejection, usage overage without `done`, later smaller usage not recovering an overage, and unknown completion usage without token/cost inference. Existing authorization/discovery, abort/deadline, credential, DNS/TLS-option and raw-error regressions still pass. An initial `node ../../node_modules/typescript/bin/tsc --noEmit` after implementation passed (exit 0). A later concurrent check reported TS2307 in the newly added `tests/model-hub.test.ts` because `server/model-hub-service.ts` was not yet supplied by its owner; that in-progress test/module was not modified here. Whole-workspace type checking must be repeated after integration. No full suite/E2E or live external service was run for this change.

## Primary protocol references

- [OpenAI Chat API reference](https://developers.openai.com/api/reference/resources/chat): text chat streaming and optional usage contract. This module supports only its documented text subset.
- [OpenAI list models](https://developers.openai.com/api/reference/resources/models/methods/list): model-list envelope.
- [Node 24 HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html): native requests, one-use agents and optional proxy configuration.
- [Node 24 DNS](https://nodejs.org/docs/latest-v24.x/api/dns.html): family-constrained lookup.

The references explain wire/native APIs; installed-runtime fixture results, conservative destination restrictions and the explicit limitations above define the tested support level.
