# Repository ownership authority implementation plan

**Goal:** Supply a real, persistent repository-exclusive ownership authority shared by independent Orbit state directories and processes, without treating manager exit as release evidence.

**Architecture:** Resolve the primary repository/common Git directory through existing Projects validation. Keep a dedicated SQLite authority in that common directory, with a monotonically increasing fencing generation, manager claim, operation intents, CAS transitions and an append-only audit. No PID/TTL stealing. Reads never create an authority. Creation is explicit and exercised only on owned fixtures in this slice.

**Tech Stack:** Existing Node24/TypeScript/SQLite/Git, no dependencies.

**Spec:** V04-CONTROL-PLANE OWNER/DISPATCH/REC-STORAGE; ADR011/014; user goal Phase1/3. Full dispatch and qualified release remain required, not redefined by this prerequisite.

## Rulings and constraints

- HEAD437b0c7 is a clean dedicated branch. Reuse it; preserve prior code and user data.
- Design review found no current native/registered-command profile proving all descendants stopped. Broad dispatch wiring with automatic parent-close release would violate REC-STOP; permanently locking every normal restart would regress the product. Build the authority now; wire production writers together with qualification, not behind an unsafe fallback.
- The smallest claim is one repository-wide manager, with multiple sequential operation intents beneath it. A different state directory cannot change the conflict key. Same-owner reacquisition is idempotent only while its exact generation remains current.
- Only never-dispatched intents can be cancelled and only claims with no dispatched/uncertain operations can be relinquished. There is deliberately no dispatched-operation release API before trusted recovery collectors/CAS integration exists.
- No browser mutation route, automatic activation on existing repositories, chmod/chown of existing paths, OS PID signalling, account-wide claim, or Windows/network-filesystem certification.

## Review focus

1. Different state-dir/process/worktree sees same repository authority; active/uncertain owner cannot be stolen after crash.
2. Late/stale handles and stale operation revisions cannot dispatch, cancel or release a new generation.
3. Symlink/hardlink/special file or directory/DB replacement is rejected; no claim of hostile concurrent filesystem replacement containment.
4. Failed intent/audit writes roll back atomically and prohibit dispatch; uncertain transition never erases durable dispatch.
5. Read-only identity/status does not create a lock/DB or disclose paths through a new HTTP endpoint.

## Task 1 — validated resource context

Files: `server/projects.ts`, `shared/repository-authority.ts`, `tests/repository-resource.test.ts`.

- [x] RED3: two Projects/Store instances register one repo, create separate worktrees and produce identical `repositoryId/commonGitDir` with different worktree/branch identity; aliases and replaced metadata reject; read-only context does not create authority.
- [x] Implement `Projects.repositoryResource(workspaceId):RepositoryResource` after existing writable/validate, using canonical common Git directory and worktree, base SHA, and filesystem directory identity. Do not expose filesystem identities through browser responses.
- [x] Focused tests green (new3 + existing10 =12pass/1Windows skip). A copied replacement metadata directory gets a new identity; authority markers/open handles pin and reject mismatch rather than adding a second Projects cache.

## Task 2 — durable authority and real process contention

Files: `server/repository-authority.ts`, `tests/repository-authority.test.ts`, fixture helper if needed.

- [x] RED: explicit initialize/open, one owner across two state directories and real child processes, process crash retains claim, no TTL/PID release, fencing increases after never-dispatched relinquish, stale token/revision denial, atomic event-write failure, path integrity and inert reads.
- [x] Implement the internal `RepositoryAuthority` API: `create(commonGitDir)`, `open(commonGitDir)`, `inspect(commonGitDir)`, `snapshot()`, `acquire(ownerIncarnation)`, `begin(token,input)`, `dispatch(token,operationId,revision)`, `quarantine(token,operationId,revision)`, `cancelIntent(token,operationId,revision)`, `relinquishUnstarted(token)`, `close()`.
- [x] Token binds repositoryId + claimId + ownerIncarnation + fencingGeneration. Operation binds operationId + requestId + kind + resource and current revision. Persist one active manager claim and append-only transitions using BEGIN IMMEDIATE. `close()` only closes the DB; it never relinquishes ownership.
- [x] Initialization uses a dedicated `.orbit-authority-v1` directory, strict marker/schema/SQLite application ID, rollback journaling and verified regular single-link files. Unknown existing data and unsupported schema fail closed. No filename follows a caller-controlled relative path.
- [x] Run real multi-process tests and unchanged Projects regressions; no production repository authority activation. Final focused new suite13/13. SQL generation mismatch, missing claim/operation audit correspondence, ignored write/audit and AFTER-audit mutation fail closed with full transaction rollback. Request field order is not semantic identity.

## Task 3 — integration evidence and checkpoint

- [x] Independent code review, repair findings with regressions, Node24 full verify and diff check:885total/884pass/0fail/1Windows skip, type/build exit0.
- [x] Record exact implemented vs unwired boundaries in MASTER PLAN/RESULTS and V04 backlog. Local commit follows the final diff review; see Git log for resulting hash. No browser UI changes in this slice; no browser smoke needed.

Completion of this plan means the authority itself works across real processes and existing validated resources. It does not complete V4-03, qualify a runtime, protect legacy dispatch paths, or make the entire Goal complete.
