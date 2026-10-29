# FE5-CQG6BCTL — 2026-10-30

## Scope and resume evidence

- Worktree: `.worktrees/codex-fe5-cqg6bctl`; branch `codex/fe5-cqg6bctl`; clean initial HEAD `14fa8f7`.
- Approval: main repository `docs/ORBIT-DECISION-2026-10-30-APPROVALS.md`, row 4, read without editing that repository.
- The worktree's `ORBIT-STATUS.md` still names integration HEAD `ea59619` and lists these tasks as awaiting approval. Actual HEAD and the user's current approval supersede those historical statements. The integration owner remains the sole writer of that summary; this file records the worker handoff.
- Darwin arm64, Git 2.50.1 (Apple Git-155); default Node 26.12.1 was not used for tests. Installed Node 24.22.1 was selected explicitly. No `graphify-out/graph.json` exists in this worktree, so no Graphify query was applicable.

## Changes and contract

The project input fingerprint remains compared against the approved batch. Worker inputs are checked separately because the scheduler intentionally copies them with read-only permissions. `WorkerSpaces.assertInputs` loads the space and handoff from SQLite using the fenced reservation and attempt. It compares the pinned manifest with the exact union of current approved project files and stored predecessor paths/SHA-256 values, then verifies the complete worker input digest. No prefix exclusion is used. Missing handoff records, modified bytes, extra files, and caller-forged metadata fail admission. Existing scheduler predecessor completion, integration, ancestry, and dispatch checks remain active.

Codex failed turn completion now stores `RUNTIME_ERROR` as the run response and `{reason:'RUNTIME_ERROR'}` as the failure event. Unknown completion status uses the same fail-closed code. The existing generic code is used without inferring auth/quota causes from arbitrary provider prose. Launch context refusal uses `LAUNCH_CONTEXT_CHANGED`. Successful/interrupted output behavior is unchanged. `web/main.tsx` refreshes the authoritative snapshot on `run.failed`, since reason-only events intentionally omit the inline Run payload. No existing database rows are migrated or cleaned. Prior streaming message events remain outside this failed-event change.

P8 now verifies both uploaded-material dispatch and dependent dispatch combining uploaded material with predecessor inputs. Regression tests cover tampered handoff bytes, extra files, changed copied/original user material, missing stored handoff, forged caller manifest/digest, failed/unknown Codex completion, and launch-context refusal.

## Verification

All Node commands use:

```sh
export PATH=/Users/DKLEE/.local/share/fnm/node-versions/v24.22.1/installation/bin:$PATH
npx tsc --noEmit
node --test tests/worker-scheduler.test.ts tests/worker-http.test.ts tests/controller.test.ts tests/product-e2e.test.ts tests/cqg-6b-ancestry.test.ts tests/cqg-6b-code.test.ts tests/integration-queue.test.ts tests/failure-intelligence.test.ts tests/failure-index.test.ts tests/codex.test.ts tests/run-telemetry.test.ts
node --test --test-name-pattern='CQG-6B-CTL|normalized failure|P8 general uploaded|P8 general dependent|pointer moves before' tests/worker-scheduler.test.ts tests/controller.test.ts tests/product-e2e.test.ts tests/harness-codex-injection.test.ts
```

Importer discovery began with `rg -l '(import|export).*server/(controller|worker-spaces)\.ts' tests` and additionally followed relative imports through test fixtures. The resulting 76 test files were run with `node --test --test-concurrency=4` (via `xargs` and `/tmp/fe5-importer-tests.txt`):

```sh
node --test --test-concurrency=4 tests/app-preview-http.test.ts tests/bedrock-http.test.ts tests/brief-pii.test.ts tests/capability-execution-http.test.ts tests/capability-execution.test.ts tests/capability-invocation-http.test.ts tests/capability-routing-http.test.ts tests/claude-planning.test.ts tests/claude-recovery.test.ts tests/claude-task-http.test.ts tests/claude-task-service.test.ts tests/codex-model-controller.test.ts tests/control-plane-http.test.ts tests/controller-repair-pii.test.ts tests/controller.test.ts tests/cqg-6b-code.test.ts tests/cqg-evidence.test.ts tests/cqg-operational.test.ts tests/deliverable-versions.test.ts tests/deliverables-http.test.ts tests/deliverables-route.test.ts tests/development-results-http.test.ts tests/extensions-controller.test.ts tests/failure-index-http.test.ts tests/folder-isolation.test.ts tests/general-acceptance.test.ts tests/general-planning-http.test.ts tests/general-planning-routes.test.ts tests/general-planning.test.ts tests/goals-http.test.ts tests/handoff-history.test.ts tests/handoff-http.test.ts tests/harness-codex-injection.test.ts tests/harness-http.test.ts tests/harness-injection.test.ts tests/http-keepalive.test.ts tests/http.test.ts tests/integration-queue.test.ts tests/merge-http.test.ts tests/model-hub-http.test.ts tests/model-registry-http.test.ts tests/model-registry-model-hub.test.ts tests/native-connection-controller.test.ts tests/native-readiness-http.test.ts tests/planning-agent-http.test.ts tests/planning-handoff-http.test.ts tests/planning-revisions-http.test.ts tests/product-e2e.test.ts tests/project-analytics-http.test.ts tests/project-analytics.test.ts tests/project-creation-http.test.ts tests/project-general.test.ts tests/project-progress-http.test.ts tests/quality-loop-controller.test.ts tests/quality-loop-http.test.ts tests/quality-progress.test.ts tests/repair-pii.test.ts tests/review-http.test.ts tests/run-metrics-controller.test.ts tests/source-graph-http.test.ts tests/studio-integration.test.ts tests/subscription-usage-http.test.ts tests/subscription-usage-store.test.ts tests/task-completion-wiring.test.ts tests/task-graph-http.test.ts tests/task-runs.test.ts tests/tool-controller.test.ts tests/tool-http.test.ts tests/usage-controller.test.ts tests/verification-http.test.ts tests/verification-setup-http.test.ts tests/worker-http.test.ts tests/worker-scheduler.test.ts tests/worker-spaces.test.ts tests/workflows-http.test.ts tests/workspace-controller.test.ts
```

Final requested suite: **223 tests, 222 pass, 1 fail, 0 cancelled, 0 skip; exit 1** (915650.617 ms). The only failure is `HTTP workers enforce session, Origin, CSRF and exact fields; GET never dispatches or appends` at `tests/worker-http.test.ts:65`, caused by sandbox `listen EPERM: operation not permitted 127.0.0.1`. Additional 70-file importer suite: **410 tests, 298 pass, 112 fail, 0 cancelled, 0 skip; exit 1** (80496.367125 ms). Failure details follow below. Focused final regression: 12 tests, 12 pass, 0 fail, 0 skip, exit 0. Typecheck: exit 0. Initial corrected RED regression: 7 tests, 3 pass, 4 fail, 0 skip, exit 1 (expected contract failures). An earlier fixture attempt failed because its inputs directory did not yet exist; the fixture was corrected before implementation.

Listener diagnostic:

```sh
node --test --test-reporter=tap --test-name-pattern='HTTP workers enforce session' tests/worker-http.test.ts
```

1 test, 0 pass, 1 fail, 0 skip, exit 1: `listen EPERM: operation not permitted 127.0.0.1`. No permission escalation or listener bypass was attempted.

Supplementary verification:

```sh
node --test --test-name-pattern='CQG-6B-CTL' tests/worker-scheduler.test.ts
node --test --test-name-pattern='P8 code' tests/product-e2e.test.ts
node --import /tmp/fe5-trace.mjs --test --test-name-pattern='same-batch dependent' tests/cqg-6b-code.test.ts
```

- Final strengthened gate assertions: 7 tests, 7 pass, 0 fail/skip, exit 0. Tampered bytes and extra-file fixtures restore read-only permissions before admission.
- Isolated P8 code verification: 3 tests (including one subtest), 3 pass, 0 fail/skip, exit 0.
- Diagnostic CQG first test: 1 test, 1 pass, 0 fail/skip, exit 0. The temporary preload logged Git invocation boundaries without changing arguments, results, gates, or assertions.
- An earlier overlapping requested-suite run was interrupted after 374 seconds while slow Git-based files were still active: 165 tests, 161 pass, 2 fail, 2 cancelled, 0 skip; exit 1. Failures were the same listener restriction and P8 native-shaped code dispatch (`SUBMIT_UNCERTAIN`, expected 1 dispatch, observed 0). An unnecessary additional code-space identity read was removed before isolated P8 verification; the dispatch failure did not recur in the final requested suite. This does not establish its cause.
- The initial 76-file importer run was interrupted (exit 130), with no final test totals. Its replacement runs the 70 files not already included in the completed requested suite. No test was deleted or marked skipped.
- `node --test --test-reporter=tap --test-timeout=60000 tests/cqg-6b-code.test.ts` was manually interrupted before completed test results (exit 1). Subsequent tracing showed slow synchronous Git work rather than proof of a deadlock.

Independent read-only review found no confirmed defect. Its requested caller-metadata and launch-refusal regressions were added and pass in the focused run.

## Limits and integration handoff

No full `npm run verify`, live provider calls, paid APIs, installations, push, merge, deployment, credential access, or existing DB cleanup. Tests use fake/native-shaped fixtures and disposable projects; this is not live provider acceptance. The integration owner must run listener-dependent checks in a permitted environment and perform its full verification before integration.

## Local commit limitation

`git add server/controller.ts server/worker-spaces.ts tests/controller.test.ts tests/worker-scheduler.test.ts tests/product-e2e.test.ts tests/harness-codex-injection.test.ts docs/ORBIT-CQG-6B.md docs/ORBIT-FE5-CQG6BCTL.md` returned exit 128: the sandbox denied creation of `/Users/DKLEE/Documents/GitHub/Orbit-Project/.git/worktrees/codex-fe5-cqg6bctl/index.lock`. Git metadata is outside the writable worktree. No commit SHA exists for this change; no alternate index/object store or permission bypass was used. The later UI caller change also remains unstaged. An integration owner with normal repository write access must stage the explicit changed paths (including `web/main.tsx`) and create the requested conventional commit, e.g. `fix: validate worker handoffs and normalize Codex failures`.

## Additional importer verification command

The six overlapping importer files are covered by the requested suite. Remaining 70 files (executed via `xargs`, with the same Node 24 PATH):

```sh
node --test --test-concurrency=4 --test-reporter=tap tests/app-preview-http.test.ts tests/bedrock-http.test.ts tests/brief-pii.test.ts tests/capability-execution-http.test.ts tests/capability-execution.test.ts tests/capability-invocation-http.test.ts tests/capability-routing-http.test.ts tests/claude-planning.test.ts tests/claude-recovery.test.ts tests/claude-task-http.test.ts tests/claude-task-service.test.ts tests/codex-model-controller.test.ts tests/control-plane-http.test.ts tests/controller-repair-pii.test.ts tests/cqg-evidence.test.ts tests/cqg-operational.test.ts tests/deliverable-versions.test.ts tests/deliverables-http.test.ts tests/deliverables-route.test.ts tests/development-results-http.test.ts tests/extensions-controller.test.ts tests/failure-index-http.test.ts tests/folder-isolation.test.ts tests/general-acceptance.test.ts tests/general-planning-http.test.ts tests/general-planning-routes.test.ts tests/general-planning.test.ts tests/goals-http.test.ts tests/handoff-history.test.ts tests/handoff-http.test.ts tests/harness-codex-injection.test.ts tests/harness-http.test.ts tests/harness-injection.test.ts tests/http-keepalive.test.ts tests/http.test.ts tests/merge-http.test.ts tests/model-hub-http.test.ts tests/model-registry-http.test.ts tests/model-registry-model-hub.test.ts tests/native-connection-controller.test.ts tests/native-readiness-http.test.ts tests/planning-agent-http.test.ts tests/planning-handoff-http.test.ts tests/planning-revisions-http.test.ts tests/project-analytics-http.test.ts tests/project-analytics.test.ts tests/project-creation-http.test.ts tests/project-general.test.ts tests/project-progress-http.test.ts tests/quality-loop-controller.test.ts tests/quality-loop-http.test.ts tests/quality-progress.test.ts tests/repair-pii.test.ts tests/review-http.test.ts tests/run-metrics-controller.test.ts tests/source-graph-http.test.ts tests/studio-integration.test.ts tests/subscription-usage-http.test.ts tests/subscription-usage-store.test.ts tests/task-completion-wiring.test.ts tests/task-graph-http.test.ts tests/task-runs.test.ts tests/tool-controller.test.ts tests/tool-http.test.ts tests/usage-controller.test.ts tests/verification-http.test.ts tests/verification-setup-http.test.ts tests/worker-spaces.test.ts tests/workflows-http.test.ts tests/workspace-controller.test.ts
```

## Additional importer failures

Every one of the 112 failures reports `listen EPERM: operation not permitted 127.0.0.1`; no non-listener failure was observed in this final run. These checks remain unverified under the sandbox.

| Test location | Test | Observed error |
|---|---|---|
| `tests/app-preview-http.test.ts:32:1` | authenticated preview API uses selected real workspace and does not dispatch native work | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/app-preview-http.test.ts:51:1` | preview API rejects auth, CSRF, unexpected fields/query and other workspace | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/bedrock-http.test.ts:13:1` | Bedrock temporary-input cleanup requires exact session/project/stopped consent and never replays lost work | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/capability-execution-http.test.ts:16:36` | mock provider vertical HTTP execution: unknown identity stays blocked | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/capability-execution-http.test.ts:16:36` | mock provider vertical HTTP execution: independent evidence reaches verified quality | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/capability-invocation-http.test.ts:24:1` | invocation HTTP requires session/CSRF and exact approval; rejects forged provider and target | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/capability-invocation-http.test.ts:44:1` | natural target result route returns existing sanitized response and persisted GET is inert | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/capability-invocation-http.test.ts:61:36` | interrupt HTTP is idempotent and request does not falsely confirm stop | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/capability-invocation-http.test.ts:61:36` | interrupt HTTP is idempotent and uncertain outcome stays unknown | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/capability-routing-http.test.ts:10:1` | capability HTTP reads are inert; discovery and routing require session/CSRF and reject forged grants | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/claude-recovery.test.ts:100:1` | HTTP recover route enforces session, CSRF and exact fields; progress GET exposes recovery without mutating | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/claude-task-http.test.ts:21:1` | HTTP general task uses requestId only, replays the same Run, refuses a second owner and routes interrupt to Claude | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/claude-task-http.test.ts:39:1` | HTTP general dispatch preserves session/CSRF checks and rejects workspace, digest, prompt and path fields | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/claude-task-http.test.ts:54:1` | HTTP general dispatch rejects stale baseline and reports missing Claude before creating any Run | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/claude-task-http.test.ts:64:1` | HTTP code project still requires a workspace and validates the acceptance digest before dispatch | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/codex-model-controller.test.ts:56:1` | model identity HTTP read requires session, rejects query and never dispatches | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/control-plane-http.test.ts:6:1` | policy GET requires local session and exposes no execution or trusted-facts input route | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/deliverables-http.test.ts:13:1` | deliverables HTTP lists and previews only the general project folder, read-only | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/deliverables-http.test.ts:39:1` | download authentication, origin, exact IDs, attachment headers, history and explicit observation CSRF | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/development-results-http.test.ts:35:1` | result endpoint is authenticated, strictly scoped and does not execute or leak Run content | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/extensions-controller.test.ts:118:1` | HTTP inventory needs a session, exact current scope and explicit Origin/CSRF; GET and restart never perform native reads | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/failure-index-http.test.ts:25:1` | failure index GET is authenticated, exact, read-only, splits mock and leaks nothing | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/failure-index-http.test.ts:44:1` | failure case create/delete need CSRF, exact fields, confirmation; create is idempotent and project-scoped | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/general-planning-http.test.ts:18:1` | HTTP AI preferences GET/POST enforce CSRF, CAS, validation and inert defaults | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/general-planning-http.test.ts:39:1` | HTTP general planning permits omitted/null workspace and creates a draft only after explicit save | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/goals-http.test.ts:10:1` | goal HTTP is project scoped, explicitly mutated, receipt-safe and incapable of runtime launch or achieved state | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/handoff-history.test.ts:50:1` | GET handoff-history is authenticated, query-free, 404 for unknown task and never mutates | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/handoff-http.test.ts:11:47` | GET task handoff is authenticated, query-free and inert for general projects | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/handoff-http.test.ts:11:47` | GET task handoff is authenticated, query-free and inert for code projects | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/harness-http.test.ts:67:1` | harness GET is authenticated, exact, project-scoped and read-only | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/harness-http.test.ts:83:1` | harness writes need CSRF, exact fields and confirmation; proposals are idempotent and AX06-checked | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/harness-http.test.ts:109:1` | without an injected runner evaluation is refused and nothing can be promoted | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/harness-http.test.ts:122:1` | a fake runner evaluation stays unverified; approval and promotion are refused | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/harness-http.test.ts:137:1` | promotion only through a fresh recorded approval; explicit rollback to v0 | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/harness-http.test.ts:170:1` | suite cases: user registers a verified passed run over CSRF with exact fields; GET shows counts read-only; removal appends | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/http-keepalive.test.ts:10:1` | idle keep-alive connections outlive the synchronous stalls observed in the server process | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/http.test.ts:27:1` | persisted Solo quarantine denies HTTP dispatch and probes while preserving state and request replay | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/http.test.ts:52:1` | capability reads are inert; native version probes require exact body, session, Origin and CSRF | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/http.test.ts:74:1` | capability probe reports current connection after awaiting version diagnosis | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/http.test.ts:93:1` | loopback API requires session and rejects cross-origin, forged Host and CSRF before mutation | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/http.test.ts:107:1` | project/workspace endpoints require CSRF, exact fields and identifiers, never browser sandbox overrides | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/http.test.ts:123:1` | large SSE backlog drains in order without closing or crashing the server | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/http.test.ts:133:1` | unknown path/CLI override keys and oversized body are rejected | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/http.test.ts:143:1` | operation identity history is an inert authenticated read and cannot be supplied by the browser | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/http.test.ts:160:1` | state reload does not start a turn; SSE replays only events after cursor | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/http.test.ts:170:1` | top-level navigation may arrive from another site, but cross-site API reads are rejected | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/merge-http.test.ts:16:1` | actual disposable Git HTTP flow verifies, approves, snapshots and explicitly fast-forwards while preserving source/index/ignored files | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/model-hub-http.test.ts:14:1` | Model Hub HTTP requires exact consent and CSRF, then returns actual local text and unknown cost | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/model-registry-http.test.ts:19:1` | HTTP registry: CSRF, create disabled, local check bound to revision, server-mapped project, disable, no credential echo | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/native-readiness-http.test.ts:12:47` | readiness HTTP mock discovery/auth: 2.1.259 | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/native-readiness-http.test.ts:12:47` | readiness HTTP mock discovery/auth: 2.0.0 | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/native-readiness-http.test.ts:12:47` | readiness HTTP mock discovery/auth: not installed | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/planning-agent-http.test.ts:63:1` | planning HTTP preview is authenticated and inert in a selected workspace whose project is read-only | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/planning-agent-http.test.ts:86:1` | planning routes enforce session, Origin, CSRF, exact fields, methods, query and selected workspace before RPC | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/planning-agent-http.test.ts:107:1` | 8000 Korean characters preview and launch through HTTP, with explicit consent, stale protection and one durable request receipt | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/planning-agent-http.test.ts:123:1` | validated suggestion saves only by explicit request as one unapproved draft and preserves source, HEAD and index | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/planning-agent-http.test.ts:159:1` | active planning blocks concurrent controller work and interruption stops only the selected suggestion | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/planning-agent-http.test.ts:171:1` | uncertain closure quarantines launch paths until explicit recovery and cannot create a draft | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/planning-agent-http.test.ts:185:1` | reopening durable running state records lost work without replaying inference or raw input | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/planning-handoff-http.test.ts:27:1` | authenticated planning download binds immutable content, roundtrips formats, and rejects ownership/hash/query overrides | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/planning-handoff-http.test.ts:40:1` | feedback preview is an explicit CSRF-protected project request and writes no questions or execution | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/planning-revisions-http.test.ts:11:1` | planning diff is authenticated and inert; replan requires exact CSRF consent and creates only selected drafts | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/project-analytics-http.test.ts:9:1` | project analytics GET is authenticated, exact, readonly and usable disconnected without workspace access | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/project-creation-http.test.ts:25:1` | browser can prepare a new named repository and isolated workspace without host allowlist or AI execution | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/project-creation-http.test.ts:42:1` | creation is authenticated, exact and cannot accept browser paths, commands or capability overrides | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/project-creation-http.test.ts:55:1` | duplicate HTTP delivery returns one project and one workspace; conflicting input cannot allocate another | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/project-creation-http.test.ts:66:1` | uncertain existing execution blocks creation before allocating files or project records | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/project-creation-http.test.ts:74:1` | hosts without a creation root do not expose project creation or create folders implicitly | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/project-creation-http.test.ts:83:1` | general project HTTP supports planning, artifacts and goals without Git or workspace allocation | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/project-creation-http.test.ts:123:1` | general HTTP creation keeps strict optional kind and credential-name validation | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/project-creation-http.test.ts:133:1` | F02-REG: an allowlisted folder registers over HTTP, materials can be replaced as a new version, and inputs/ is the only write | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/project-progress-http.test.ts:12:1` | progress HTTP is authenticated, project scoped, read-only and reflects observed blockers | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/quality-loop-http.test.ts:7:1` | quality HTTP requires session/CSRF, scopes reads and never dispatches on GET | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/quality-progress.test.ts:163:1` | HTTP GET exposes quality without executing providers or changing stored evidence | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/review-http.test.ts:18:1` | native review HTTP uses explicit source consent, a separate mock readonly session, interruption and restart recovery without verification or replay | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/source-graph-http.test.ts:37:1` | source graph HTTP derives real files, exports a bound artifact, and retains stale evidence across restart | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/source-graph-http.test.ts:74:1` | source graph HTTP keeps path and execution boundaries, hides credentials, and rejects unsupported source | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:31:1` | class diagrams retain exact source and immutable editable exports through project isolation and restart | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:51:1` | class unsupported syntax and geometry overflow leave history and audit untouched | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:67:1` | C4 Artifact preserves exact source, project ownership and editable historical exports through restart | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:91:1` | C4 invalid boundaries, self relationships and unsafe text cannot create an artifact or event | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:103:1` | C4 layout overflow leaves existing revisions and audit sequence untouched | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:118:1` | saved Artifact exports real PPTX and exact Markdown with immutable revision and ownership gates | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:137:1` | sequence Artifact persists exact revisions and exports paginated editable slides after restart | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:159:1` | Artifact export revalidates stored source integrity before returning Markdown or PPTX | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:171:1` | planning HTTP persists approval and idempotent task drafts across restart without running an agent | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:199:1` | Studio routes enforce authentication, CSRF, ownership, exact fields and revision conflicts | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:212:1` | Artifact HTTP saves validated immutable history and restores it after restart | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:230:1` | mock provider endpoint blocks PII and policy overrides and records only fixed metadata | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:244:1` | Studio accepts escaped 256 KiB documents but rejects oversized decoded text and unsafe Artifact metadata | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:257:1` | failed task persistence rolls back records and events; event listeners see committed data | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:272:1` | competing revisions have one winner and replay survives reopening the database | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/studio-integration.test.ts:291:1` | version quota prevents new content but never blocks approval or idempotent task recovery | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/subscription-usage-http.test.ts:11:1` | progress shows quota headroom only from a fresh observation; stale rejection still blocks; usage GET is read-only | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/task-graph-http.test.ts:20:1` | HTTP task graph saves revisions, reads history and derives state without marking anything done | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/task-runs.test.ts:127:1` | approved task executes its authoritative brief once and preserves the link across uncertain response and restart | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/task-runs.test.ts:142:1` | Task baseline is explicitly previewed, stored before dispatch and rejects stale or missing approval | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/task-runs.test.ts:164:1` | real checks accept implementation changes but reject weakened tests and cannot replace an original baseline | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/task-runs.test.ts:191:1` | baseline persistence failure rolls back Run intent and makes zero native dispatches | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/task-runs.test.ts:201:1` | protected file change after dispatching a Check invalidates actual exit-zero evidence | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/task-runs.test.ts:216:1` | task execution rejects unresolved, stale, foreign, injected and wrong-workspace requests before dispatch | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/task-runs.test.ts:232:1` | task and free-prompt requests cannot reuse each other idempotency identities | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/tool-http.test.ts:8:59` | tool HTTP listener: session, Origin, CSRF, exact fields and read-only GET | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/usage-controller.test.ts:56:1` | HTTP cached usage is inert; refresh requires session Origin CSRF and empty body | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/verification-http.test.ts:36:1` | real worktree HTTP verification records exit and approval, then invalidates changed source without modifying original | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/verification-http.test.ts:53:1` | verification HTTP gates reject CSRF, field injection, source races, active workspaces and sensitive filenames | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/verification-setup-http.test.ts:36:1` | a discovered preset configures both consumers and runs real passing and failing Node checks without host environment edits | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/verification-setup-http.test.ts:50:1` | setup preserves auth and exact fields and refuses foreign workspace and command overrides | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/verification-setup-http.test.ts:63:1` | source changes reject stale setup and replayed registration neither creates another revision nor executes checks | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/verification-setup-http.test.ts:74:1` | unknown Solo execution and lost checks in another workspace block project command updates | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/verification-setup-http.test.ts:85:1` | the configured preset binds protected tests before a Task and later registration cannot rewrite its baseline | 'listen EPERM: operation not permitted 127.0.0.1' |
| `tests/workflows-http.test.ts:15:1` | workflow HTTP approves immutable commands and source, executes real steps, preserves repositories and restores without replay | 'listen EPERM: operation not permitted 127.0.0.1' |

Final changed paths: `server/controller.ts`, `server/worker-spaces.ts`, `web/main.tsx`, `tests/controller.test.ts`, `tests/worker-scheduler.test.ts`, `tests/product-e2e.test.ts`, `tests/harness-codex-injection.test.ts`, `docs/ORBIT-CQG-6B.md`, and this report. `git diff --check` passed (exit 0); the final `npx tsc --noEmit` passed (exit 0). Existing tests were not skipped or deleted.
