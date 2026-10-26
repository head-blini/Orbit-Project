# Development result navigation implementation plan

> Execute inline using executing-plans; independent whole-change review after integration.

**Goal:** Connect saved Planning Task, selected Run, actual Check evidence and the current static app preview in Development, with direct navigation from execution and planning.

**Architecture:** Reuse Store/Studio/VerificationService and existing panels. A read-only selected-workspace result endpoint returns bounded provenance and verification metadata, never prompts/output or execution authority. One Run selection drives Review/Verification/Merge and preview evidence. Preview remains a current workspace snapshot, not proof that the selected Run authored all files.

**Tech Stack:** Existing Node24/TypeScript/React/SQLite; no dependencies.

**Spec:** goal-objective.md Phase1 and sections6/7/9/12, MASTER PLAN next Phase1 slice. Whole A–K, actual AI scenarios and qualified recovery remain required.

## Decisions / review focus

- Continue clean dedicated branch HEAD46ff568. User authorizes internal implementation without repeated questions. Preserve existing dispatch/approval controls; this slice adds reads/navigation only.
- Choose server-side association validation over separately trusting browser Task/Run IDs. Reject foreign workspace/Run. Missing or changed planning authority remains explicit.
- Current-source verification is an observation; no atomic repository ownership claim. Require result and preview workspace/source digests to match. Never infer success from Run.completed or old Check.passed alone.
- Older Run stays selected across unrelated SSE events; do not silently redirect approvals to the latest Run. Workspace changes clear selection, and late responses are ignored.
- No configured commands, no linked Task, no Run, unreadable source, running/lost execution, failed/stale checks and superseded plan have honest states. Read-only rendering starts no AI/commands.
- Existing snapshot runs are scoped to the selected workspace. Planning result actions must verify project/workspace and must not describe unseen other-workspace runs as never executed.

## Task 1 — authoritative result projection

Files: shared/development-results.ts, server/development-results.ts, server/controller.ts, server/http.ts, tests/development-results.test.ts.

- [x] RED real temporary Git/Store/HTTP tests for selected workspace/session/query validation, Task/plan provenance, source changed vs passed evidence, no configured checks/free prompts, no dispatch, restart preservation.
- [x] Implement GET /api/workspaces/:id/result?runId=... with explicit optional Run ID, metadata-only verification projection and source consistency check. Reuse existing authoritative records and check view, no new tables.
- [x] Focused tests pass; preserve check history and authority.

## Task 2 — result selection and navigation

Files: web/development-results.tsx, web/pages.tsx, web/app-preview.tsx, web/main.tsx, web/agent-center.tsx, web/studios.tsx, focused UI tests.

- [x] RED production TSX tests for Run selection routing, evidence/source matching, empty/unknown/stale state and truthful labels.
- [x] Add result summary and Run selector above preview. Pass selected terminal Run to existing Review/Verification/Merge panels; active Run shows state without selecting some other Run. Show same-source check relation beside preview only when exact workspace/source matches.
- [x] Add explicit result buttons in Agent Center and saved Task cards, carrying workspace/Run selection. Scope handoff to current workspace; no automatic workspace changes or new execution.
- [x] Focused tests pass. Avoid stale response reuse after selection/online/revision changes.

## Task 3 — integration verification and checkpoint

- [x] Independent review; address reproducible important findings.
- [x] Node24 npm run verify, diff check; actual Chrome fixture with real local Check and static app, multiple Runs/source changes/workspace and restart. Distinguish synthetic Run from real AI.
- [x] Update MASTER PLAN/RESULTS and backlog; local commit, no remote push. Record exact test evidence, remaining work and resume state.

## Ledger

- Previous turn: progress (Task30 implementation, 898 tests/897pass/1skip, Chrome, commit46ff568). Current checkout clean and single worktree on macOS arm64.
- Ruling: use existing plan/results ledger and focused scripts directly; avoid a second progress hierarchy. Independent auditor reviews data provenance while primary owns implementation.

- Ruling: delegate the independent server projection/tests to the auditor after fixing the shared interface; primary owns HTTP/UI integration, avoiding shared-file edits. Foreign Run is concealed with404 rather than disclosing its workspace; HTTP expectation corrected after observing that contract.

- Task1: projection missing RED11; authoritative source/config/base/latest/lost safeguards →13/13. HTTP404 RED1 then foreign Run expected404 contract correction →pass. No new persisted records from reads.
- Task2: missing UI RED4→5 UI tests; existing preview regression updated for wrapper; actual-TSX delayed responses/offline/workspace/poll cleanup5/5. Independent whole-change reviewer found no P1/P2.
- Task3: first whole917/916pass/1skip; final922/921pass/1Windows skip/0fail, type/build0 (development-results-final.log). Chrome two process lifetimes, exact persisted Check IDs exit0/9, three synthetic Runs, native/AI0, five screenshots. Source-stale first command request safely refused; explicit reload/unlock then real current-source failure verified. Detailed limitations/continuation in MASTER RESULTS Task31.
