# Optional Bedrock CLI adapter

Root owns configuration, shared DTOs, ModelHubService, Controller/HTTP and integration. Native transport and UI have separate subagent owners. Reuse the Model Hub lifecycle and official AWS CLI; no SDK/framework/install or live AWS call is authorized by this implementation task.

- [x] Add strict inert server-only Bedrock configuration: explicit native CLI path, standard AWS region, project/model allowlists, credential environment references, timeout/output bound; no browser overrides, profile/endpoint/ARN/cross-region route or fallback.
- [x] Implement authorized AWS CLI 2 diagnostics and text-only Converse, bounded split output, minimal child environment, single attempt, owned process interruption. Model catalog intersects configured direct foundation IDs. Preserve HTTP transport behavior.
- [x] Keep request input out of argv/SQLite/events. Use an owned temporary input file only after outbound approval; remove after process completion. On crash or cleanup failure, show uncertainty and allow exact-owned-file cleanup only after explicit prior-process stopped attestation. No process replay or PID-based kill.
- [x] Integrate honest capability, billing/usage unknown, temporary-input and nonstreaming disclosure in Model Hub; explicit missing-runtime browser diagnostic. No keys/config editor in browser.
- [x] Run focused contracts with synthetic credentials/mock CLI responses and real local child-process tests, independent review, full types/tests/build, Windows browser E2E, then record evidence and remaining live-account limitations.

Final local gate: 405/405 tests, type/build exit0, Windows 33/33 scenarios and 41 PNG. Evidence: `C:/Users/lclk1/AppData/Local/Temp/orbit-e2e-esVqPJ`. Actual AWS calls: zero. Root verified result/cleanup and PNG41. This completes the optional adapter slice, not the entire platform goal.

Official references checked 2026-10-26:

- [AWS CLI Converse](https://docs.aws.amazon.com/cli/latest/reference/bedrock-runtime/converse.html): `bedrock:InvokeModel`, messages and maxTokens; use file input, not prompt argv.
- [Foundation model catalog](https://docs.aws.amazon.com/cli/latest/reference/bedrock/list-foundation-models.html): TEXT and ON_DEMAND selection.
- [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html): AWS CLI does not support Bedrock streaming.
- [Environment configuration](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html), [configuration variables](https://docs.aws.amazon.com/cli/latest/topic/config-vars.html), [parameter files](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-parameters-file.html).

Known environment: AWS CLI was not found on PATH or the three checked standard locations. Real AWS authentication, regional model access and billing remain unverified. A timeout/interrupt cannot establish whether AWS completed or charged a request; maxTokens is not a billing cap. Abrupt process termination can leave the approved input in its owned temporary directory until explicit cleanup; do not claim memory-only storage.
