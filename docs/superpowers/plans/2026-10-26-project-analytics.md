# Project usage and execution analytics implementation plan

> **For agentic workers:** Use superpowers:executing-plans. Root owns shared contracts, SQLite, Controller and HTTP; independent native agents own the passive collector and UI. Existing full-platform authorization includes implementation, tests, review and local commits.

**Goal:** Show project-scoped execution records, measured durations, attributable token observations and actual historical verification results without provider calls or inferred costs.

**Architecture:** Read canonical SQLite records through a bounded, allowlisted projection. A passive Codex collector binds telemetry to acknowledged thread/turn ownership and persists a separate Run metrics row. The existing account usage panel remains separate.

**Tech Stack:** Existing Node 24, SQLite, TypeScript and React; no new dependencies.

**Spec:** ORBIT-GOAL J and the decisions below. These routine implementation choices are the implementer's decisions under the existing autonomous development instruction.

## Decisions and constraints

- Chosen: canonical local history plus passive native notifications. Additional provider polling cannot establish reliable historical attribution and adds external work. Account lifetime deltas cannot be allocated to projects.
- `thread/tokenUsage/updated.total` is a thread cumulative snapshot; `last` is not a turn total. Do not add notifications. The first run without an observed pre-run baseline remains unknown; subsequent continuous same-connection observations may expose a clearly labeled observed delta, never a billed total.
- Require exact thread/acknowledged turn ownership; bounded pre-ack projected buffer (128 entries). Replays are idempotent. Regressions, invalid numbers, synthetic inconsistent totals, foreign interleaving and late predecessor updates invalidate affected attribution. Old connections cannot update later sessions. Missing token data remains null.
- Capture model/provider from the existing handshake, with changed/unknown attribution for settings changes or reroutes. Identifier strings are bounded and privacy checked. No prompts, responses, raw protocol payloads, paths, endpoints or native thread IDs in analytics responses.
- Dedicated monotonic elapsed operation measurement; lost/legacy duration unknown. Terminal execution and timestamps remain immutable when late telemetry arrives. Retry notices are observations, not exact retries; only validated workflow retry lineage is counted as retries.
- Historical Checks are distinct from model completion and current approval. Analytics performs no workspace fingerprinting, model queries, filesystem scans or writes.
- Summary uses all project-owned canonical records once. Pagination is keyset ordered by createdAt/kind/id, 25 default / 50 maximum. Totals expose known/missing coverage; sums that exceed safe integer bounds become null. Costs remain unknown.
- Planning persistence-quarantine overlay must be reflected. Account subscription quota stays in its existing section, separate from project and Model Hub observations.
- Official evidence: installed stable `.local/capability-schema-mac/v2/ThreadTokenUsageUpdatedNotification.json`; https://github.com/openai/symphony/blob/main/elixir/docs/token_accounting.md ; https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs . Installed protocol has no final turn-token summary. Live native telemetry remains untested.

## Review focus

1. Notification replay/pre-ack/late output cannot charge another run; unknown legacy data cannot become zero.
2. Run completion differs from check pass; source changes and approvals are outside historical analytics.
3. Cross-project ownership, HTTP session/origin/query validation and stale UI responses remain isolated.
4. Pagination has deterministic ties and no event/receipt duplicates; partial provider token fields and arithmetic overflow remain explicit.
5. Malformed telemetry and persistence failures cannot stop coding; local metric recovery must remain honest.

## Tasks

- [x] Collector: `server/run-telemetry.ts`, `tests/run-telemetry.test.ts`. Interface `RunTelemetry(save)` with `connect(threadId,model,provider)`, `begin(runId)`, `acknowledge(runId,turnId)`, `event({method,params})`, `finish(runId,lost?)`, `disconnect()`. Emits `RunMetrics` from shared/analytics.ts. Test RED then GREEN for baseline, duplicates, invalid/reordered/foreign/late events, bounded pre-ack, reroute, timing and reconnect.
- [x] Root persistence/integration: separate `run_metrics` table/get/save; wire collector lifecycle without weakening execution transitions. Tests cover late terminal writes preserving Run, startup lost, request receipt replay and zero additional RPC calls.
- [x] Root analytics: `server/project-analytics.ts`, HTTP GET `/api/projects/:projectId/analytics?limit=25&cursor=...`. Iterator-based project-filtered SQL projections; exact fields only. Tests for ownership, canonical dedupe, actual check verdicts, measured durations, token coverage, retry lineage, overflow and stable pagination.
- [x] UI: `web/project-analytics.tsx`, minimal CSS, embed beside account usage; selected project prop. GET only, explicit refresh and next-page controls, generation guards and honest provenance/coverage labels. Tests for no POST/provider work, no-project/offline/error states, stale project/page responses and numeric zero versus unknown.
- [x] Run targeted suites, full `npm run verify`, independent review, isolated Chrome fixture with restart and clean-up; document evidence/limitations in MASTER files, then make verified local commit. Continue other incomplete Goal work.
