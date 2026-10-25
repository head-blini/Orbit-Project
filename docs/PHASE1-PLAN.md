# Phase 1 first browser slice — implementation plan

Spec: user's 2026-10-25 Phase 1 request, AGENTS.md, docs/PHASE0-RESULTS.md, docs/02-TECH-DESIGN.md.

## Scope and decisions

The user explicitly authorized this slice despite the broader Phase 0 gate remaining partial. Preserve that distinction. Stay on the dedicated `phase1/codex-web-slice` branch in this checkout; all agent execution targets a newly created disposable repository, never this source checkout.

Use Node 24 + TypeScript, React, a small esbuild bundle, Node HTTP and built-in SQLite. One origin at `127.0.0.1`, no separate Vite dev server, no runtime cloud SDK. SQLite stores a single session, runs and normalized events; credentials remain owned by Codex. UI does not accept a filesystem path, CLI arguments, model/provider override or shell command.

## Tasks

- [x] 1. Verify Phase 0 tests; sanitize account metrics; commit baseline (`06ae30f`). Exclude local evidence, generated schemas, data and dependencies. Git identity was absent, so use commit-local `Codex <codex@local.invalid>` without changing global config.
- [x] 2. Supplement live POC in a disposable repository: normal completion, a harmless explicit approval request denied by default, native App Server crash/restart/resume. Record exact scope and failures. No credentials in output.
- [x] 3. Write failing tests then implement TypeScript RPC transport, persistent run/event store, read-only workspace policy, single-flight connect/start, idempotency and LOST recovery. Preserve verification=`not_run`.
- [x] 4. Write HTTP security/integration tests; implement exact Host/Origin checks, SameSite HttpOnly session cookie + CSRF token, bounded JSON, SSE cursor replay, server-owned workspace and static assets.
- [x] 5. Implement React prompt/response/state/event view. Explicit connect/resume, submit, interrupt; refresh only reads state and subscribes. Pending client submission IDs survive refresh without automatic replay.
- [x] 6. Run typecheck/build/offline tests and real browser tests. Review security and recovery using a fresh reviewer as required by executing-plans; fix substantive findings. Write README and PHASE1-RESULTS. See explicit failures and unverified limits in that report; checked does not mean universal platform/tool support.

## Shared interfaces

`Controller.snapshot()` returns provider status, current thread ID, runs and last event sequence. `connect()` loads the persisted thread without starting a turn. `submit({requestId,prompt})` deduplicates before sending; `interrupt(runId)` records a request and waits for a terminal event. `Store.eventsAfter(seq)` supplies durable normalized events. `GET /api/state`, `GET /api/events?after=N`, `POST /api/connect`, `POST /api/runs`, `POST /api/runs/:id/interrupt` are the only browser API routes (plus bootstrap session).

## Review focus

- Timeout after upstream accepted a prompt: never silently retry; preserve run as LOST.
- Simultaneous tabs and refresh: unique request ID, request body digest, one active turn.
- Split secret-looking text across deltas: sanitize accumulated message before any UI/persistence boundary.
- Disconnect while interrupting or submitting: terminal state cannot regress; reconnect never resubmits.
- Host/Origin mismatch, forged cookie/CSRF, oversized body and SSE cursor: reject before mutation.

## Progress and rulings

- Baseline tests: 11 passed, exit 0. Worktree left in place per task scope, no source checkout delegated to Codex.
- Narrow scope takes precedence over the broader Phase 1 prompt document: planning importer, approvals granting, arbitrary projects, diff/test runner and full Phase 1 are not part of this slice.

## Recovery continuation — 2026-10-25

- Preserve this checkout, branch, all existing source files and `.local` DB/WAL. No reset/clean, new worktree, redesign, or Phase 2 work. The user explicitly requested continuation of the approved slice.
- Previous repository-specific tool runtime (PID 25516 and its descendants) was stopped with explicit user authorization. Current-session ancestors were protected; PID 20308 was identified as the current CLI and retained. A subsequent 15-second observation found no source or previous-session-log changes.
- Recovery baseline: TypeScript check exit 0, 32 offline tests passed, exit 0.
- Remaining sequence: pre-thread MCP isolation and policy verification; RPC/recovery checks; native MCP startup sentinel test; isolated live browser test; documentation and final review; explicit source/exclusion inspection before any final commit.
- Ruling: keep the existing branch/checkout and uncommitted implementation, as requested, instead of creating a separate worktree or rerunning completed implementation tasks.
- Ruling: apply per-server `enabled=false` overrides to thread start/resume before any MCP discovery; keep a thread-scoped inventory check and fail closed when config, inventory or approval policy cannot be established. Native 0.164 includes disabled entries, so accept only known names with explicit disabled runtime status and no tools (or an empty list). No user config writes or credential copying.
- Red evidence: three new tests fail on the original continuation state: missing pre-thread MCP overrides; unreadable config still creates a thread; relaxed server policy is accepted.
- Native characterization: the first empty-inventory expectation failed because disabled entries remain visible. A failing controller regression now covers explicit disabled state, unknown names, and nonempty tools. Native marker negative/positive controls passed.
- Native no-turn resume has no saved rollout. Ruling: do not fake persistence or silently create a replacement; document the limit and prove actual persisted resume with authorized live turns instead.
- Actual Chrome proof: three runs completed/interrupted/completed; mid-stream reload preserved run count; loopback server restart restored history; same-thread resume did not replay prompts; a new post-resume prompt completed. Existing source DB/WAL/SHM hashes unchanged.
- Final fresh read-only review: no Critical/Important findings; reviewer independently passed 25 Phase 1 tests and typecheck. Final: minor (deferred): another already-open tab needs refresh to display the newly created thread ID.
- Review rulings: live behavior is supported by executor sentinel/browser evidence rather than independent live review; no-turn resume stays explicitly limited; other OS/CLI versions and write-capable projects stay outside this slice. These limits are listed in PHASE1-RESULTS; users must not infer broader support.
