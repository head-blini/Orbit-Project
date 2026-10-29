# TG-01 — approved Task Graph domain

## Scope and resume checkpoint

Implements backlog item 6 / X01 as a local domain and persistence service. Approved sources: `ORBIT-VISION.md`, `ORBIT-SCOPE-2026-10-27.md`, `ORBIT-SCOPE-EXTENSION-2026-10-29.md` (X01 and absolute boundaries), and `ORBIT-UNIFIED-BACKLOG-2026-10-29.md`.

Worktree: `codex-task-graph`, branch `codex/tg-task-graph`, starting HEAD `a8601d7`; initially clean. The integration resume summary names CORE-LIVE as its next task and records earlier Node 24 verification. This work unit is the explicitly assigned TG-01 domain task, not a resumption of live executions. No prior execution was repeated. `graphify-out/graph.json` was absent. Actual source inspection used the named files directly.

Only four files belong to this work unit: `shared/task-graph.ts`, `server/task-graph.ts`, `tests/task-graph.test.ts`, and this document. Integration owner retains HTTP, controller, UI, shared Store schema, and `ORBIT-STATUS.md`. No commits, installations, provider calls, network listeners, or external calls were made.

## Domain and decisions

- One graph is identified by `(projectId, planningVersionId)`. A graph may contain a subset of that version's saved tasks, including an empty set. Every edge endpoint must be an explicit node. Task content remains exclusively in existing `SavedTask` records.
- `{taskId: B, dependsOn: A}` means B waits for A. Reject unknown IDs, foreign project/version tasks, duplicate nodes/edges, self edges, and cycles. Kahn traversal handles disconnected DAGs without recursion.
- Each node and edge may hold `contracts: [{id, digest}]` and `impactScope: {files: string[], resources: string[]}`. Digests are opaque nonempty strings, not automatically verified hashes. Scopes are declarative globs only: no filesystem access, matching, resource locks, or execution grants.
- `contentHash` is the existing planning SHA-256. Creation and revision require the authoritative approved version, approval metadata, matching draft hash, and current lineage head. Once established, a graph's hash cannot change. A new planning version needs a separate explicit graph; no task migration or rebinding occurs automatically.
- Existing planning revisions leave older approved records marked `approved`. Therefore `planning_heads`, not the state enum alone, determines whether the graph remains current. Even a newly proposed draft head makes the old graph stale, matching `Studio.execution`.
- `expectedRevision: 0` creates revision 1. Each successful `save`, including an identical replacement, appends revision N+1. A mismatch returns `REVISION_CONFLICT` (409). Changes replace the full topology/metadata in that new revision. History is ascending and prior revisions remain readable.
- `Store.transaction` uses `BEGIN IMMEDIATE`; revision comparison, baseline/task checks, and insertion run under the same transaction. Only the new `task_graph_revisions` table is introduced by this module. `Studio` initializes its existing tables through its normal constructor. No existing table schema changes.
- Limits: 1,000 nodes, 10,000 edges, 100 contracts per node/edge, 100 globs per scope list, 1,024 characters per digest/glob, and 1 MiB serialized input. Invalid fields are rejected rather than silently persisted. No history retention or deletion policy is introduced.

## State projection and trust boundary

`deriveTaskGraphState(graph, baseline, facts)` is a pure function. Its graph must be a validated revision. `baseline` contains the authoritative planning record (or null) and current lineage head ID. `facts` is exactly `{verifiedDoneIds: string[], blocked: [{taskId, reasonCodes}]}`. Unknown task IDs, duplicate facts, invalid or empty blocker codes, and extra fields are rejected.

Precedence is **stale > blocked > done > waiting > ready**:

1. Missing, superseded, unapproved, hash-mismatched, or non-head baseline makes every node `stale`, including previously verified nodes. Reason: `TASK_GRAPH_BASELINE_CHANGED`.
2. Explicit blocker facts produce `blocked` with their reason codes. They override a conflicting verified-done ID.
3. Only an explicitly supplied verified-done ID produces `done`. Execution completion, `SavedTask.state`, and `SavedTask.verification` never imply done. Explicit completion evidence remains completion even if a predecessor is currently waiting; this projection does not invent retrospective scheduling facts.
4. A remaining node waits on every direct predecessor that is not effectively done. A blocked predecessor supplied as verified is still unsatisfied. Independent nodes become ready.

The service's `view` loads the graph and baseline under one transaction and does not persist derived states or append activity events. Reads do not dispatch work. Historical topology is read as recorded, but its state is projected against the current planning baseline and the supplied facts, not reconstructed as an historical execution snapshot.

**Caller responsibility:** supply authoritative, current verification/blocker facts scoped to the requested graph revision, tasks, planning hash, and relevant artifacts/contracts. Do not pass browser assertions as verified facts. This domain does not verify evidence, infer contract satisfaction, grant execution permission, schedule workers, or interpret impact globs. Missing verification is an empty `verifiedDoneIds` array, never guessed completion. Graph revisions alone do not invalidate or carry forward evidence; the integrating evidence adapter must decide its applicability.

## Service API and proposed HTTP wiring

```ts
const graphs = new TaskGraphService(store);
graphs.save(projectId, {
  planningVersionId, contentHash, expectedRevision,
  nodes: [{taskId: predecessor}, {taskId: dependent}],
  edges: [{taskId: dependent, dependsOn: predecessor}],
});
graphs.read(projectId, planningVersionId, revision); // omit revision for latest
graphs.history(projectId, planningVersionId); // [] before creation
graphs.view(projectId, planningVersionId, facts, revision); // derived state only
```

Proposed routes for the orchestrator (not implemented):

| Method | Project-scoped route | Service operation |
|---|---|---|
| POST | `/api/projects/:projectId/task-graphs/:planningVersionId/revisions` | `save`, validate path/body planning ID equality |
| GET | `/api/projects/:projectId/task-graphs/:planningVersionId` | `read`, optional positive integer `revision` |
| GET | `/api/projects/:projectId/task-graphs/:planningVersionId/history` | `history` |
| GET | `/api/projects/:projectId/task-graphs/:planningVersionId/state` | `view`, server loads verified facts for the selected revision |

Apply existing local-session authorization, request validation/body limits and error serialization. The write body consists of `contentHash`, `expectedRevision`, `nodes`, and `edges`; the handler supplies the path planning ID. Graph editing is not planning approval or execution authorization. A concurrent state/evidence adapter must read facts and the target graph consistently; it must not silently apply facts collected for an older revision to latest.

Errors: malformed payload/topology/facts use 400; oversized serialized graph uses 413; missing project/version/graph uses 404; unapproved draft uses 422; task scope, stale baseline, and revision conflicts use 409. No request-id receipt mechanism is included: after a lost successful write response, reload history/latest before deciding whether to retry with a new expected revision.

## Verification

Tests use real Store/Studio/SQLite instances, in-memory or disposable temporary databases; no mocks, model calls, or network servers. Coverage includes cycles, self/unknown/duplicate edges, cross-project/version rejection, draft/hash rejection, concurrent connections and optimistic conflicts, complete close/reopen history persistence, waiting/blocker/done precedence, superseded heads, contract/scope roundtrip, unchanged source tasks, read-only projections, malformed facts, insert rollback, and changed-hash rebinding rejection.

Initial red: missing implementation module, exit 1. A later targeted changed-hash regression failed with `Missing expected exception`, then passed after binding enforcement.

Final commands and counts are recorded below after execution. Full suite, build, HTTP/UI integration, and live provider integration are intentionally outside this work unit; the orchestrator owns those gates. No unresolved product question blocks TG-01. Integration still needs an authoritative facts adapter and route/UI wiring.

Verified on installed Node **v24.22.1**, selected only for these commands by prepending `/Users/DKLEE/.local/share/fnm/node-versions/v24.22.1/installation/bin` to `PATH`:

- `node --test tests/task-graph.test.ts`: exit 0; **9 tests, 9 pass, 0 fail, 0 skipped**.
- `npx tsc --noEmit` with `npm_config_offline=true npm_config_yes=false`: exit 0; no diagnostics. Uses existing dependencies; installation/network fallback disabled.
- `git diff --check`: exit 0. The four delivery files are new and untracked; no commit or staging performed.

Earlier default-runtime checks also passed on Node v26.12.1 (9 tests, typecheck), but Node 24 is the repository-supported verification above. These results establish domain/SQLite behavior, not HTTP/UI or live integration success.
