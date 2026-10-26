# Orbit v0.4 Tracking Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalize the approved v0.4 contracts, then add usable policy visibility and durable Goal Tracking without enabling new execution authority.

**Architecture:** Keep Node 24, node:http, node:sqlite, React and existing services. Add a policy projection and a goal/evidence read model around canonical records; no second dispatcher. Later execution work follows V04-BACKLOG gates and is not claimed by this foundation.

**Tech Stack:** Existing TypeScript/Node 24/React/node:test/esbuild; no dependencies.

**Spec:** docs/architecture/V04-CONTROL-PLANE.md, V04-ADR.md, V04-BACKLOG.md; latest user conditions 2026-10-27.

## Global Constraints

- Preserve A–K, historical ADRs/backlog, existing data and App Server. M-CP and M-PRODUCT remain incomplete.
- Tracking performs zero model/CLI/tool calls. Assisted and Autonomous qualification is not implied by a contract function.
- Unknown usage may be acknowledged only in the bounded Assisted profile; unknown safety never can. Existing strict autonomous budget checks are unchanged.
- Policy statuses distinguish Orbit enforcement, runtime attestation and unverified guarantees.
- Existing dedicated branch is retained; disposable repositories/databases only. No remote push, live AI, plugin installation, auth/billing changes or native feature activation.
- Full test command uses the existing ignored Node 24.22.1 toolchain. Loopback fixture tests may require host execution permission; record sandbox failure separately.

## Review Focus

- Spoofed quota/safety booleans or stale exhausted observation must not open a runtime route; contract facts are server-only and no execution route is added.
- Legacy run/check evidence, changed plan head and altered tests must never become qualified goal completion.
- Cross-project IDs, stale revisions and lost response replay must not duplicate or overwrite goals.
- Reload/restart/late UI responses must not dispatch work or display another project's goals.
- Transaction/storage failure must not leave an unreceipted mutation/event; historical Run/Task bodies must stay identical.

## Task 1: Policy scope and operating-level visibility

**Files:** Create shared/control-plane.ts, server/control-plane.ts, web/control-plane.tsx, tests/control-plane.test.ts, tests/control-plane-http.test.ts, tests/control-plane-ui.test.ts. Modify server/http.ts and web/pages.tsx.

**Interfaces:** `assessAssistedAdmission(facts: AssistedAdmissionFacts): AdmissionDecision` is a pure server-facts contract, not an authorization endpoint. `controlPlaneStatus(provider: ProviderStatus): ControlPlaneStatus` returns current, conservative scope/qualification metadata. Authenticated GET /api/control-plane is inert. `ControlPlanePanel` renders the report and explicitly separates current implementation from future contract.

- [ ] Write negative admission matrix: unknown quota without acknowledgement, known exhaustion even stale, schedule/retry/delegation, API auth, safety unknown, live/conflicting owner, recovery blocked, hard cap requested without enforcement all reject; qualified one-turn direct assisted with unknown usage acknowledgement may pass.
- [ ] Verify RED with Node24 node --test tests/control-plane.test.ts.
- [ ] Implement minimal types/decision and safe current report. Current Autonomous OFF, Assisted unqualified; no launch call consumes these decisions yet.
- [ ] HTTP tests: session/Origin/query validation, repeated GET causes no probe/dispatch/store event. UI: scope labels and unknown limits present; no autonomous start control.
- [ ] Connect Security page; typecheck, focused tests, full npm run verify. Record actual outcomes.

## Task 2: Durable Goal Tracking and evidence references

**Files:** Create shared/goals.ts, server/goal-service.ts, web/goals.tsx, tests/goals.test.ts, tests/goals-http.test.ts, tests/goals-ui.test.ts. Modify server/controller.ts, server/http.ts, web/pages.tsx, web/shell.tsx as needed.

**Interfaces:** `GoalService(store)` initializes additive goal/receipt/history tables. `list(projectId)` returns goal records plus current plan applicability, linked tasks/runs and explicitly reference-only evidence. `create(projectId, {requestId, planningVersionId, expectedPlanningHash})` binds the current approved plan. `setState(projectId, goalId, {requestId, expectedRevision, state:'tracking'|'paused'|'cancelled'})` is CAS/idempotent; cancelled terminal. No achieved or execution endpoint. `history(projectId, goalId)` returns persisted revisions. Authenticated project-scoped GET/POST /api/projects/:id/goals, POST /api/projects/:id/goals/:id/state and GET /api/projects/:id/goals/:id/history.

- [ ] Write tests for current approved plan only, zero-provider tracking, foreign IDs, stale hash/head, duplicate request receipt and conflict.
- [ ] Verify RED; implement additive tables and atomic Store.transaction operations. Preserve old IDs/bodies/events.
- [ ] Write tests for CAS/state/restart/history, transaction trigger failure rollback, immutable historical goal binding after plan revision and reference-only evidence despite completed Run/passed Check.
- [ ] Verify RED; implement view/history/evidence references. Never call fingerprint/CLI/model or infer acceptance success.
- [ ] HTTP exact fields/CSRF/project isolation and no arbitrary completion. UI explicit create/state controls, stale project response handling, retry receipt and no execution from reads.
- [ ] Typecheck, focused tests, full npm run verify; browser fixture if available; record actual native/Windows tests as unverified.

## Verification and follow-on

After both tasks, independent review against spec and Review Focus; fix important findings with regression tests. Inspect diff, update docs/ORBIT-MASTER-PLAN.md, docs/ORBIT-MASTER-RESULTS.md and V04-BACKLOG.md with exact implementation/test/unverified status. Preserve all original checklist entries.

Next implementation plan must cover V4-02/03 recovery and common ownership before certifying Assisted; V4-05 trusted acceptance before goal achievement; V4-07/08 runtime/platform/aggregate evidence before Autonomous. Do not manufacture stubs or enable executors to make this foundation look complete.
