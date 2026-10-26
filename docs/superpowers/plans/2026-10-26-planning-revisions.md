# Planning comparison and explicit follow-up tasks

**Goal:** Compare saved revisions, show affected tasks, and create selected follow-up task drafts after approval without changing historical tasks or starting agents.

**Architecture:** Reuse immutable PlanningVersion records, the Studio transaction/receipt layer and existing task execution checks. A pure comparison module projects deterministic field/requirement changes. The server binds a preview digest to both versions, current head and target task identities; an explicit POST creates missing target tasks with provenance. No new dependencies.

**Tech Stack:** Existing TypeScript/React/Node24/SQLite.

**Spec:** ORBIT-GOAL B, PRD FR-00D, TECH-DESIGN Planning diff endpoint, 06-CHATGPT-PLANNING-BRIDGE sections2/8. User already authorized autonomous implementation, testing and independent delegation.

## Decisions and constraints

- Compare two saved versions from the same project and lineage, with the base older than the target. Unsaved edits cannot be approved or used for follow-up creation.
- Show title/goal/constraints/open questions/source/order changes and requirement additions/removals/description/criteria changes. Context changes to goal/constraints/open questions affect every base task. Label identity is explicit; no fuzzy matching.
- Prefer new task drafts linked to their predecessor over overwriting existing tasks: existing runs and approvals keep exact historical references. Removed requirements cannot create target tasks. Added requirements have an empty predecessor task list.
- Creation requires the target's current approved head, no unresolved questions, fresh preview digest, exact CSRF POST, request receipt and 1–100 unique selected target labels. Return existing target tasks without changing provenance or duplicating them. Existing all-task generation fills missing labels after a selective replan.
- No code execution, model call, automatic pause/restart or approval inheritance. Planning decisions/full imported provenance remain a subsequent slice.
- Root owns shared contracts, Studio/SQLite/HTTP and integration. Bounded pure comparator and standalone UI are independent work units. No edits to unrelated files or user data; no push/deploy.

## Tasks

- [x] Pure `comparePlanningVersions(base,target,tasks)` in `server/planning/comparison.ts` using `shared/planning-revisions.ts`. Tests in `tests/planning-comparison.test.ts`: added/removed/changed/unchanged, global effects, task scope, unchanged order, invalid identity, detached output. RED then GREEN19/19 including near-limit stored JSON/Markdown.
- [x] Root Studio `comparePlanning(projectId,targetId,baseId)` and `plans/:id/replan` mutation. Tests in `tests/planning-revisions.test.ts`: draft/stale/hash/foreign gates, exact selection, partial then all tasks, immutable old records, no runs, idempotency/restart/rollback. RED then GREEN5/5, including late predecessor creation.
- [x] GET `plans/:id/diff?baseVersionId=...` and POST `plans/:id/replan`. Exact method/query/body, session/CSRF and ownership HTTP tests in `tests/planning-revisions-http.test.ts`:404 RED→1/1 GREEN.
- [x] Standalone `web/planning/PlanningComparison.tsx` with version selection, explicit comparison, affected-task table, selected target labels and separate consent. Root connects it to saved editor selection and Studio callbacks. UI epoch tests, inert SSR/escaping and stale scope checks in `tests/planning-comparison-ui.test.ts`:10/10, existing handoff4/4.
- [x] Focused/full/type/build, independent review, disposable Chrome verification of comparison→approval→selected follow-up→reload/restart/no execution. Final516 total/515pass/1 Windows-only skip/0fail, type/build0. Dedicated CUA3JPEG, source/old tasks preserved, no AI/CLI/external request, cleanup complete. Windows full E2E remains separate.

## Review focus

1. Revision/head or generated target tasks change between preview and POST: reject stale digest, preserve all records.
2. A replay after response loss/restart returns its original tasks and emits no new audit or task creation.
3. Partial selected tasks followed by all-task generation preserve task IDs/provenance and fill only missing requirements.
4. Identical labels in unrelated project/version never cause cross-project impact or provenance links.
5. Late browser requests after selecting another version/project cannot restore an old consent or result; content is escaped text and GET never mutates.

## Progress

- Baseline Mac/Task17 commit: `4c303ff`, 479pass/1skip/type/build0. Dedicated branch retained. Contracts fixed before independent workers start.
- Ruling: bind all base and target task identities to the preview digest, including unchanged requirements — new predecessor records change the provenance a user is accepting. Regression RED→GREEN.
- Independent P2: pretty JSON reparse applied the external256KiB limit to valid stored content. Shared structural normalization now handles stored drafts; external input limit and canonical hash checks remain. CompactJSON and escapedMarkdown262143B cases RED→GREEN, parser/export/comparator44/44.
- Independent P2: a requirement without a predecessor Task was incorrectly labelled as newly added. Actual Studio/SSR regression RED→GREEN now displays the neutral “연결된 이전 Task 없음”. Focused UI/service/provenance16/16; final full log `.local/verification/planning-revisions-final-verify.log`.
- Chrome evidence `.local/ui-e2e/mac-task18-B9GhIA/result.json`: draft blocked, approval clears preview, explicit R1 selection/consent creates one follow-up, all-task creation fills R3 without duplicates, reload/server restart retains four tasks and predecessor link. Source HEAD/index/digest unchanged, counters0, console0, owned servers exit0 and port/tab closed.
