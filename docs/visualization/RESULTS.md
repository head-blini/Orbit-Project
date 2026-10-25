# Visualization results — 2026-10-25

Independent implementation is ready for integration review, with build and integration blockers below. **This is not a completed application integration or a verified PPTX generator.**

Branch: `parallel/visualization`. Base and unchanged HEAD: `641d01c21ae11a9dad1a16d93a08b2902bbcbf4c`. Worktree was initially clean. All deliverables remain uncommitted. No merge, push, deployment, shared Git metadata writes, external API calls, credential reads, permission changes, or edits to another worktree were performed.

## Implemented

- Restricted Mermaid validation/parsing and architecture generation, with explicit graph topology validation and inert SVG preview.
- Standalone Studio editor with source validation, generated Mermaid view, Artifact selection/history, optimistic-revision save callback, project reset, and optional export callback. Missing integrations are visibly disabled.
- In-memory project-scoped Artifact repository with exact original source, UUID, SHA-256, server timestamp/revision, immutable kind, detached revisions and metadata, input/path/authority-injection rejection.
- Editable presentation intermediate format with text, shape and endpoint-linked connector elements and an injected byte-export boundary. **편집 가능한 PPTX 생성 기반만 구현.** No actual `.pptx` serialization or download implementation.
- Read-only run timeline and workspace diff display, duplicate/reordered events, uncertainty/gap detection, workspace-switch reload, neutral unknown kinds, cancellation-aware reload lifecycle and explicit failure retry. Agent completion remains separate from verification.
- 17 Visualization tests, including pure helper/server behaviors, in-memory JSX transform plus server rendering, reload lifecycle primitives, and exporter dispatch boundary. Separate browser bundle verification script.

All new files are under `web/visualization/`, `server/visualization/`, `tests/visualization.test.ts`, `tests/fixtures/visualization/`, or `docs/visualization/`. Existing tracked files are unchanged.

## Environment and verification

Windows NT `10.0.19045.0`; Node `v24.22.1`; npm `11.19.1`; Git `2.56.0.windows.3`; `codex.cmd --version` reports `codex-cli 0.164.0` with a sandbox home/PATH-alias warning. No Codex inference or authentication probe ran. Bare `codex --version` selected `codex.ps1` and failed PowerShell execution policy; `.cmd` was used without changing policy. Other provider availability was not checked or required.

| Command/check | Exit/result |
|---|---|
| `npm.cmd ci --offline --no-audit --no-fund` | 0; 11 lockfile packages installed from cache. npm warned that esbuild's install script was not covered by allowScripts; no approval or policy change was made. |
| Baseline `npm.cmd run verify` | 1 overall. Typecheck succeeded; **56/56** existing tests passed; production build failed on sandbox ancestor-directory access. |
| Initial `node --test tests/visualization.test.ts` | 1; tests could not load the not-yet-created module. This was an absence check, not a behavioral RED for every test. |
| Subsequent targeted RED checks | 1 as expected for prototype event-key lookup, invalid URI acceptance, and connector geometry. New UI/lifecycle tests also initially failed because their implementation was absent. An early source-string expectation was corrected to reflect intentional safe-ID remapping. |
| `node --test tests/visualization.test.ts` after first UI implementation | 0; **13/13**. Independent reviewer also ran this command, 0 and 13/13. |
| `npm.cmd test` before review fixes | 0; **69/69**, including the original 56 tests. |
| `node --test tests/visualization.test.ts` after lifecycle/connector fixes | 0; **15/15**. |
| `npm.cmd run typecheck` | 0, including independent UI modules and tests. |
| **Final `npm.cmd run verify`** | **1 overall**; typecheck succeeded, **73/73 tests passed (56 original + 17 Visualization)**, production build failed with the same baseline directory-access error. |
| `node tests/fixtures/visualization/verify-ui-build.mjs` | **1**; independent browser entry also failed on the same denied ancestor-directory read. No bundle emitted (`write:false`). |
| `git diff --check` | 0 for tracked diff (there is no tracked diff; new deliverables are untracked). |

Exact build diagnostic: `Cannot read directory "../../../../..": Access is denied.` Then esbuild cannot resolve `./web/main.tsx` (production) or `./web/visualization/index.tsx` (independent UI). An explicit absolute-entry/`tsconfigRaw` diagnostic also failed with that directory-access error. A first inline diagnostic had a PowerShell quoting syntax failure (exit 1); it was corrected with stdin JavaScript, after which the same sandbox failure reproduced. No sandbox workaround, alternative executable, parent-directory change, or elevated execution was attempted.

Tests use synthetic graph/event/Artifact inputs. Existing repository integration tests use their own disposable repositories and loopback HTTP fixtures. No product server was launched. The JSX rendering tests transform in memory without resolving filesystem ancestors and exercise rendered output, not a bundled browser app. Tests cover cancellation/setup-cleanup-setup at the reload lifecycle helper boundary, not a mounted React StrictMode browser session.

## Independent review and fixes

The execution contract explicitly required a read-only reviewer. `/root/visualization_review` inspected actual new code and tests, reran 13 tests, and reported no critical security/ownership issue. Two important findings were fixed:

1. React StrictMode cleanup suppressed reload failure reporting; queued callbacks could also dispatch after cleanup. The effect now uses a cancellation-aware lifecycle helper, keeps its reload key stable, and routes explicit retry through the same effect. Regression checks cover setup-cleanup-setup, stale queued dispatch, old in-flight failures, and retry.
2. Same-row connectors entered the target rectangle and had obscured arrowheads. Endpoints now use the facing rectangle boundaries. Rendered-geometry regression verifies the default sample's visible side-to-side connector.

The reviewer also identified an integration requirement: timeline replay needs a stable authoritative snapshot cursor, rather than the existing app's continuously advanced cursor. This is explicitly documented in `INTEGRATION-CONTRACT.md`. Dense-graph layout and browser pixel validation remain limitations rather than claims of full diagram-layout support.

## Blockers, rulings, and unverified work

- `shared/parallel.ts` and its contract tests were absent. The integration owner must provide them. This implementation does not create replacement named common contracts; function inputs are structural and outputs inferred. Shared-type compatibility remains unverified and must be resolved before integration.
- Existing and independent builds remain blocked by sandbox directory access, including at the baseline before changes. No build success is claimed. Independent modules were implemented/tested despite that environmental baseline blocker because their unit/type/render checks could run within the authorized scope; no product launch was attempted.
- `TASK.md` requests `docs/PARALLEL-visualization-RESULTS.md`, outside the contract's allowed paths, and explicitly says not to modify conflicting portions. This report is therefore `docs/visualization/RESULTS.md`. Integration can copy/aggregate it into the main report and `PARALLEL-STATUS.md`; neither unowned path was modified here.
- No HTTP endpoints, SQLite persistence, application mounting, real SSE reconnect, browser interactions/screenshots, durable download, actual PPTX ZIP/XML structure, or PowerPoint editability was verified or implemented. No extra dependency was added.
- Mermaid support is intentionally a documented subset and fixed-grid preview, not the full Mermaid validator or layout engine. URL/scheme rejection is conservative; labels containing scheme-like `word:` text may be rejected even when intended as prose.
- The Artifact repository is an in-memory implementation, not a security/authentication or cross-process concurrency service. Host-side project authorization, CSRF, transactions, quotas and stale-response checks are required.

See [INTEGRATION-CONTRACT.md](INTEGRATION-CONTRACT.md) for precise callback shapes, source grammar/limits, persistence requirements, replay cursor handling and export responsibilities. Awaiting integration-owner review; no commit was made.
