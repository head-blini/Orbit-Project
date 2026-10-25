# Orbit Phase 2-A implementation plan

Baseline: `38e3572`, branch `phase1/codex-web-slice`. Existing Phase 1 files, data and history stay in place. Scope is the user's Phase 2-A request, not the broader backlog.

## Design and constraints

Extend the Node/React/SQLite slice with a project registry and server-owned Git worktrees. Registration is read-only. Creating a worktree requires an exact canonical project path in the server-only `ORBIT_ALLOWED_PROJECTS` JSON array (default empty). The browser cannot change this allowlist. First exercise this gate only with disposable repositories; actual projects remain opt-in after verification.

Use generated UUIDs and `orbit/<uuid>` branches based on the registered repository's current committed HEAD. Never checkout, reset, clean, commit, merge or delete the source worktree. Preserve incomplete worktrees on errors. Reject links, traversal, special Windows paths, external Git directories, submodules and repository configuration capable of executing checkout helpers. Disable Git hooks, filters, fsmonitor, external diff and textconv; no shell interpolation or browser-supplied Git arguments. Revalidate before every operation.

Keep one active execution at a time. Persist projects/workspaces additively in SQLite; scope thread and run history to the selected workspace while retaining Phase 1 history. Switching is blocked during connection/execution, closes the old transport, and never sends a prompt. Runs/events include workspace identity. Restart marks incomplete runs lost without removing files.

Codex receives only the selected managed worktree as cwd, workspace-write with no additional writable roots, no network or temporary-directory write grants, on-request approval policy and user reviewer. Every approval request is still denied. Keep shell/MCP/plugins/hooks and other Phase 1 tool restrictions. Coding enables only the required local code_mode_host; read-only mode retains the old host-off/untrusted behavior. Validate returned policy and known disabled MCP inventory before inference. Any mismatch fails closed. Native patch-tool availability and Windows enforcement require live evidence; do not infer them from unit tests.

Live-driven decision: host-off returned "tool host is disabled" without an edit; host-on/untrusted requested file-change approval and was correctly denied. Workspace-write/on-request with the same deny handler produced the intended in-worktree patch. No user configuration, sandbox bypass, or approve-all path was introduced. Create empty .codex/.agents/.aws directories before connection so the native protected-directory policy applies from the first turn.

Diff is on-demand, bounded, rendered as text, compared against captured base SHA, includes untracked files, and omits sensitive/binary content. Never persist raw diffs or tool logs. UI retains streaming/interrupt/recovery and adds Orbit branding, registration, worktree selection and changed-file/diff review. No arbitrary file editing endpoint.

## Execution / review focus

1. Add failing real-Git tests in `tests/projects.test.ts` for gates, traversal/link/config rejection, isolated branch creation, diff, persistence and preservation; implement `server/projects.ts` and shared types/store additions.
2. Add controller tests for selected cwd, exact sandbox, per-workspace sessions, switch locks, transport loss and default deny; extend controller/main without replacing Phase 1 behavior.
3. Add HTTP security/field-validation coverage; extend existing CSRF-protected routes and React UI. Keep all capability controls server-side.
4. Run typecheck, full automated suite, build, native MCP check. Use a separate temporary cwd/database/source repository for live Codex edit, browser streaming/diff/interrupt/refresh/restart. Record actual results independently from mocks. Do not relax a security restriction to make a test pass.
5. Update README and `docs/PHASE2A-RESULTS.md`; fresh read-only final review of path, Git execution, sandbox and session boundaries. Check changed files/exclusions before any commit. No automatic merge/deploy or Phase 2-B.

## Initial evidence

- Clean baseline at 38e3572; source hashes unchanged during a 10-second concurrency observation, no other active repository-writing session identified.
- Existing full suite: 36/36 pass, exit 0.
- Local Codex 0.164 generated schema confirms `workspaceWrite`, writableRoots, excludeTmpdirEnvVar and excludeSlashTmp fields.
- Official references: https://learn.chatgpt.com/docs/agent-approvals-security , https://learn.chatgpt.com/docs/config-file/config-reference , https://learn.chatgpt.com/docs/app-server . Native enforcement still needs verification.

## Final execution ledger

Tasks 1–5 complete within the stated restrictions. Fresh final verify: typecheck + 51 tests + build, exit 0. Final native patch/diff/main-preservation script exit 0. Actual Chrome registration, two worktrees, patch/diff, streaming, running reload, interruption, restart/resume and two-tab selection synchronization verified. Existing DB/WAL/SHM hashes unchanged; 22 source/doc files remain uncommitted for review.

Final review rulings: fix all four reported material issues (cwd executable resolution, lazy-fetch helper execution, pathspec-sensitive diff leak, stale-tab workspace routing). Each reproduced RED→GREEN and the full suite stayed green. Git now resolves an absolute binary once, blocks protocols/lazy fetching, and uses literal pathspecs. Submissions carry expected workspace identity. Native OS escape/ACL/concurrent replacement/forced-patch-crash scenarios remain unverified and explicitly limited; no broader permissions or Phase 2-B work was introduced. Full evidence and deferred items are in PHASE2A-RESULTS.md.
