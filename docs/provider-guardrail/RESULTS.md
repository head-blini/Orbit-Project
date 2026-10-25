# Provider / Guardrail implementation results

Date: 2026-10-25. Branch: `parallel/provider-guardrail`.
Base and unchanged HEAD: `641d01c21ae11a9dad1a16d93a08b2902bbcbf4c`.
Changes are uncommitted for integration-owner review. No merge, push, or deployment occurred.

## Delivered

- `server/guardrails/outbound.ts`: metadata-only inspection, immutable trusted destination registry, fail-closed configuration/input validation, credential blocking, and personal-data block/mask/explicit-allow decisions.
- `server/providers/connections.ts`: four mock-only adapter identities sharing an injected transport contract. Exact server destination selection and policy checks precede every transport call. Errors contain fixed codes only.
- `tests/provider-guardrail.test.ts`: 16 synthetic tests covering all four providers, masking/overlaps, credentials under all policies, no transport on rejection, endpoint/configuration attacks, mutation/accessor defenses, bounded input, and sensitive transport failures.
- `docs/provider-guardrail/INTEGRATION-CONTRACT.md`: API usage, configuration trust boundary, precise detector/endpoint limitations, and pending integration requirements.

Only owned product/test/document paths were added. Existing tracked files, shared types, package manifests/lockfile, server entrypoints, HTTP, Controller, SQLite, RPC, and Codex files were unchanged. Dependency installation used this worktree's existing lockfile/cache; node_modules, authentication, settings, or databases were not copied or linked from another worktree. Existing integration tests used their disposable fixture repositories/databases.

## Environment and checks

Observed environment: Windows NT 10.0.19045, Node v24.22.1, npm 11.19.1, Git 2.56.0.windows.3, Codex CLI 0.164.0. This establishes installed tooling only, not authenticated/live-provider readiness. PowerShell's `.ps1` launchers were blocked by its execution policy; `.cmd` launchers worked without policy changes. `codex.cmd --version` also warned it could not create PATH aliases because it could not find a home directory; no inference or account probe was requested.

| Command / phase | Exit code | Result |
|---|---:|---|
| Initial combined environment read with `npm --version` / `codex --version` | 1 | PowerShell script-launcher restriction; subsequent `.cmd` version commands succeeded (0) |
| `npm.cmd ci --offline --ignore-scripts` | 0 | 11 packages installed from cache; no new dependency or lockfile change |
| Baseline `npm.cmd run verify` | 1 | Typecheck passed; existing 56/56 tests passed; build failed as described below |
| RED `node --test tests/provider-guardrail.test.ts` | 1 | Expected missing-module failure before implementation |
| Initial GREEN `node --test tests/provider-guardrail.test.ts` | 0 | 13/13 tests passed |
| Initial `npm.cmd run typecheck` | 0 | Passed |
| Expanded `node --test tests/provider-guardrail.test.ts` | 0 | 16/16 passed after performance/configuration regressions added |
| Final `npm.cmd run typecheck` | 0 | Passed after all implementation changes |
| Final `npm.cmd test` | 0 | 72/72 passed: all 56 prior tests plus 16 new tests |
| Final `npm.cmd run build` | 1 | Same baseline esbuild directory-access failure |
| Independent reviewer `node --test tests/provider-guardrail.test.ts` | 0 | 16/16 passed on final code |
| `git diff --check` | 0 | No tracked-file whitespace errors; additions inspected separately |

Both baseline and final builds reported `Cannot read directory "../../../../..": Access is denied.` followed by inability to resolve `./web/main.tsx`. Build success is **not verified**. No sandbox permission, build-script, or filesystem-access workaround was attempted. The normal build bundles the existing UI; these new server-only modules are exercised directly by Node tests and TypeScript checking.

Existing passing regressions include default-deny RPC approvals, MCP isolation, workspace path validation, disposable worktree isolation, reconnect/interrupt/transport-loss transitions, and keeping agent completion separate from actual verification. No live inference or browser E2E smoke was run. No external provider API was called; all new transport calls were in-memory synthetic mocks.

## Independent read-only review

The execution contract explicitly requires an independent reviewer; a separate read-only review agent inspected the code and tests and ran the focused suite. Two Important findings were corrected:

1. Unbounded email-pattern scanning caused quadratic retries on long ordinary ASCII input. Bounded local-part/domain-label scans and a 256-KiB regression resolved it. Final whole-suite measurement was approximately 130 ms under concurrent tests; independent focused measurement was approximately 56 ms, both below the generous two-second regression bound.
2. Provider-prefixed credential assignments were initially missed. AWS secret/session tokens, OpenAI keys, and LiteLLM keys now have synthetic blocking coverage across policies.

The reviewer reported no remaining Critical/Important code findings and confirmed ownership boundaries. The report/integration documentation was written after that review and was not independently reviewed.

## Pending / unsupported / conflicts

- `shared/parallel.ts` and `tests/parallel-contracts.test.ts` are absent. Their ownership prevents creating replacement shared files or duplicate reserved named contracts. The independent implementation uses inferred local signatures; formal shared contract alignment remains pending.
- The planned `ProviderDescriptor`, `LaunchContext`, and `evaluateLaunch` API is not present in this checkout and was not recreated independently. Codex launch integration remains the owner's pending task; existing execution security is unchanged.
- No live Bedrock/LiteLLM/vLLM/FreeLLMAPI connection, credential registration, model discovery, networking, DNS/redirect enforcement, provider readiness, streaming/retry/cancel behavior, HTTP/UI wiring, or SQLite persistence is implemented or verified. Detection is finite and cannot guarantee complete DLP coverage. See the integration document for specific false-negative limitations and response handling.
- TASK.md requests `docs/PARALLEL-provider-guardrail-RESULTS.md`; CONTRACT.md restricts this worker's documents to `docs/provider-guardrail/**` and instructs reporting conflicting work without making that change. This owned-path report is supplied instead. The integration owner must aggregate it into the requested root report/status document.
- No additional Phase gate passage is claimed. Missing shared integration and the baseline build failure prevent claiming the full integration acceptance gate passed.
