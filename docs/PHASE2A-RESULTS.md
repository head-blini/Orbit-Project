# Orbit Phase 2-A — implementation and verification

Date: 2026-10-25, Windows / Asia-Seoul. Baseline `38e3572`, preserved branch `phase1/codex-web-slice`. Phase 1 implementation and history retained. Phase 2-B not started.

## Actual implementation

- Orbit UI title/branding and new documentation; existing directory, DB and branch names retained.
- Read-only local Git project registration and canonical path/access validation. Exact server-only project allowlist defaults empty. No actual user project was enabled in this work.
- UUID-based `orbit/<UUID>` branch/worktree creation from committed HEAD, selection, immutable base SHA. Original main/master and uncommitted source files are not edited or reset.
- Path traversal, special Windows paths, links/junctions/hardlinks, external Git data, tracked symlinks/submodules, executable checkout config/include rejection. Git uses argument arrays, no shell; hooks/fsmonitor/external diff/textconv are disabled. Revalidation before operations.
- Only selected managed worktree reaches Codex. workspace-write has empty additional roots, network disabled, both temporary-directory exclusions enabled. Coding uses on-request/user, with all received approval requests denied. Read-only Phase 1 uses its original policy. No approval-allow endpoint exists.
- MCP preflight disabling and thread-scoped inventory verification retained. Only the local tool host required for patching is enabled in coding mode; shell, code_mode, apps, plugins, hooks and other restricted tools remain disabled. Existing user settings are not edited.
- Additive SQLite project/workspace records, workspace-scoped threads/runs, selection persistence and normalized work events. Existing Phase 1 history is retained. Lost/failed/interrupted runs do not trigger cleanup or replay.
- CSRF/session-protected project/worktree APIs; unknown override fields rejected. React registration/selection, on-demand changed-file list and text Git Diff (base versus staged + working tree + untracked). Sensitive/binary/large content omitted; raw diffs and tool logs are not stored in SQLite.
- README Windows install/run/stop, allowlist, supported workflow, recovery and failure guidance.

## Automated tests actually passed

Initial unchanged baseline: `npm.cmd test`, 36/36, exit 0.

Final `npm.cmd run verify` after the review fixes: TypeScript typecheck, **51/51 tests**, esbuild build all passed, exit 0. No skipped, failed or cancelled tests. The full suite includes the original 36 tests. An earlier intermediate run passed 44 tests before further regressions were added.

Coverage added: write gate and revocation; isolated branch/main preservation; tracked/untracked/sensitive diff; traversal/option-like path/junction rejection; filter and symlink tree rejection; durable worktree records; protected directories; selected cwd and exact sandbox; per-workspace history/resume; active-switch rejection; transport loss preserving changes; authenticated endpoints/exact fields; tool-host restriction flags. Existing RPC TRANSPORT_CLOSED, interruption, redaction, SSE, CSRF and instance-lock regressions remain included.

Final security regressions also cover repository-local git.exe execution, literal filenames versus sensitive sibling pathspecs, promisor transport-helper execution with a missing tree object, and stale-tab workspace mismatch before creating any run. Each reproduced a failure before its fix and then passed.

## Actual native and browser execution

Environment: Node 24.22.1, Git 2.56.0.windows.3, Codex 0.164.0, Chrome. Native coding tests use existing ChatGPT authentication through Codex; no authentication files are read/copied and no separate API key is used.

| Executed check | Observed result |
|---|---|
| Native `scripts/verify-worktree.mjs` | Connected with validated policy, patched `greeting.ts` from before to Orbit, verified Git Diff, source main/HEAD/content unchanged; exit 0 |
| Native `scripts/verify-mcp-isolation.mjs --coding` | Temporary credential-free CODEX_HOME. Preflight did not start MCP; disabled override did not start marker; enabled positive control did; exit 0 |
| Chrome project registration and worktree creation | New disposable repository registered via form, separate orbit branch created and selected |
| Chrome real code change | Prompt caused actual `greeting.ts` edit to Orbit browser; changed-file button and exact removed/added lines rendered |
| Streaming and refresh | Numeric response streamed. Reload during Run 3 preserved running state and Run count 3, without duplicate submission |
| Interrupt | Actual interrupt.requested / interrupt.accepted / interrupted transition; edited file remained |
| Server restart / resume | Same separate test DB restored project, selected workspace, 3 runs and unchanged diff; explicit resume loaded same thread |
| Post-resume prompt | Fourth prompt returned ORBIT_RESUME_OK |
| Workspace switching | Second worktree showed no history and no diff; selecting the original restored its 4 runs and changed file |
| Final two-tab synchronization | Changing workspace in tab 2 updated tab 1 to the new empty history without manual reload; original workspace restored afterward |
| Final browser patch after review fixes | Fifth request carried the selected workspace identity and patched greeting.ts from Orbit browser to Orbit final; exact final Git Diff rendered |
| SQLite final aggregate | quick_check=ok; 5 runs completed/completed/interrupted/completed/completed, verification=not_run throughout; 2 workspaces, session.created=1, session.resumed=2; 2379 message.updated events |

The browser server used a separate temporary working directory, database, Git source and worktree on loopback 4328. During development its fixture received the newly introduced empty protected directories before restart; its code edit was not recreated. Tests never registered the implementation repository as an editable Orbit project.

## Failed tests / observed constraints

- New behavioral tests first failed against absent functionality; they passed after implementation. These intentional red-phase failures are distinct from live failures.
- Initial native patch attempt with the Phase 1 tool-host restriction completed a response without changing a file: tool host disabled. Enabling the host while retaining untrusted caused a file-change approval request, correctly denied. These were **failed code-edit tests**, not successful coding. The final coding policy uses workspace-write/on-request plus the unchanged deny handler; a later native test and Chrome patch both actually edited files. No never/auto-review/full-access policy was used.
- Initial browser fixture belonged to CodexSandboxOffline while the server ran as the ordinary user. Git rejected dubious ownership. A fresh same-user disposable fixture resolved the test setup; safe.directory and existing Git configuration were not changed.
- One numeric streaming prompt completed before the interruption attempt. A separate longer request was visibly running at reload and successfully interrupted.
- Ctrl+C teardown reports exit 1 through the PTY tool. Server disconnection, restart and data recovery were observed; clean shutdown exit code 0 is unverified.

## Unverified / safe limitations

- Actual user-project writes remain untested and off by default. Only disposable repositories were exercised. Registration and server allowlisting are separate; users must validate their environment before opting in.
- Coding is patch-only. Shell commands, dependency installation, general code exploration and project test execution are unavailable; all run verification remains not_run. Model completion is never counted as a passed test.
- Native returned sandbox fields and successful in-worktree editing are verified, but exhaustive OS filesystem/network escape resistance and adversarial concurrent path swapping are not. Same-user processes can modify files outside Orbit; stop concurrent editors/sessions before work. Links and root changes found during revalidation block use.
- No new native out-of-workspace write attack was executed under the final coding policy. Default-deny handling is covered by production RPC fixture tests, and a real native file approval was denied during diagnosis; these are separate evidence.
- Forced server termination during a live code patch, disk-full/Git-worktree partial failure, very large repositories, all ACL variants and cross-workspace browser races are not exhaustively verified. Incomplete workspace records/files are retained for inspection, not automatically removed.
- MCP configuration changing concurrently with connection, all managed policies/plugin combinations and other Codex versions are not verified. Any unknown effective policy or MCP inventory fails closed. Credential-free no-turn MCP probe cannot prove resume; persisted resume was exercised separately in Chrome.
- Diff is a bounded review view, not a secret scanner or a verification runner. Known credential patterns are redacted; arbitrary secret strings cannot be reliably identified. Sensitive filenames/content are omitted and raw diff is not persisted.
- macOS/Linux/WSL, multiple concurrent executions, external clients/public servers are unverified or unsupported.

## Deferred beyond Phase 2-A

No Phase 2-B implementation. Approval-allow UI, shell/test execution, automatic commit/merge/deploy, other providers, cloud gateways, code graph and Visualization Studio remain excluded. Broad repository compatibility and stronger isolation require separate scope and evidence.

## Final review / repository hygiene

Independent read-only review found four material issues; all were accepted and fixed in one regression pass:

1. **P1 repository-local git.exe:** resolve Git once using an absolute server PATH candidate; a harmless renamed Node executable no longer hijacks registration. RED→GREEN.
2. **P1 lazy-fetch helper:** reject promisor configuration, set GIT_NO_LAZY_FETCH=1, deny transport protocols. A disposable missing-object/ext-helper marker fixture no longer starts the helper. RED→GREEN; no network used.
3. **P1 sensitive diff through pathspec:** use --literal-pathspecs. A tracked `[.]env` file no longer includes a tracked `.env` sibling's synthetic private content. RED→GREEN.
4. **P2 stale-tab execution:** require expected workspace ID on HTTP submissions and reject mismatch before Run creation. Selection SSE reloads an authoritative snapshot and replay cursor. RED→GREEN plus actual two-tab UI synchronization.

Final full suite **51/51**, typecheck and build passed. Final native code-edit script also passed again after these fixes. The reviewer did not re-review fixes; fresh regression results are the fix evidence.

Review rulings for items declined to judge: exhaustive native sandbox/OS escape/ACL/concurrent replacement/forced termination remain explicitly unverified above; authentication and existing DB contents were intentionally not read; final aggregate/native/browser verification was performed by the implementer. These are limits of the evidence, not silent completion claims.

No commit, reset, clean, forced overwrite, merge or deployment has been performed in Phase 2-A. `.local`, DB/WAL/SHM, auth/environment files, raw logs, temporary test repositories, dependencies and build outputs are excluded. Existing DB/WAL/SHM SHA-256 hashes match their pre-test values, checked again after teardown. Test server and verification scripts were stopped; no test server listener remained on 4328. Test repositories/changes remain preserved.

Final candidate list: **22 files, 13 modified + 9 new**, none staged. Modified: `.gitignore`, `README.md`, `scripts/verify-mcp-isolation.mjs`, `server/codex.ts`, `server/controller.ts`, `server/http.ts`, `server/main.ts`, `server/store.ts`, `shared/types.ts`, `tests/http.test.ts`, `web/index.html`, `web/main.tsx`, `web/style.css`. New: `docs/PHASE2A-PLAN.md`, `docs/PHASE2A-RESULTS.md`, `scripts/verify-worktree.mjs`, `server/errors.ts`, `server/projects.ts`, `tests/codex.test.ts`, `tests/projects.test.ts`, `tests/workspace-controller.test.ts`, `web/workspaces.tsx`.

Candidate scan found no DB/build/dependency/log/auth paths and no matches for the checked API-key/private-key patterns. This pattern check is not a proof against every possible secret. `git check-ignore` confirmed DB/WAL, dist, dependencies, auth.json and .env exclusions. `git diff --check` passed after normalizing the newly appended CSS line ending. The screenshot `.local/orbit-phase2a-browser.jpg` is a local, Git-excluded browser verification artifact, not a committed source file.

References: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [sandbox and approval boundaries](https://learn.chatgpt.com/docs/agent-approvals-security), [configuration](https://learn.chatgpt.com/docs/config-file/config-reference). Local installed schema and native observations take precedence over assumptions about other versions.
