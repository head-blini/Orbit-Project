# Planning implementation results — 2026-10-25

Status: independent implementation complete; integration acceptance blocked by missing shared types and build sandbox access. No commits, merge, push or deployment performed.

## Scope and ownership

- Base and unchanged HEAD: `641d01c21ae11a9dad1a16d93a08b2902bbcbf4c`.
- Branch: `parallel/planning`; working tree was clean before work.
- Added `server/planning/**`, `web/planning/**`, `tests/planning.test.ts`, `tests/fixtures/planning/**`, `docs/planning/**` only.
- The task asks for `docs/PARALLEL-planning-RESULTS.md`, but the execution contract permits reports only in `docs/planning/**` and says to report conflicts instead of editing outside ownership. This report therefore lives at `docs/planning/PARALLEL-planning-RESULTS.md`. Integration can copy its results to the central status report.
- Shared contracts, controller, HTTP, SQLite, security core, package manifests, main UI and other worktrees were not edited.

## Environment and implemented behavior

Observed: Windows NT 10.0.19045, Node v24.22.1, npm 11.19.1, Git 2.56.0.windows.3, codex-cli 0.164.0. PowerShell `.ps1` wrappers for npm/Codex were blocked by execution policy; their existing `.cmd` launchers worked without changing policy. Codex version emitted a PATH-alias/home warning. No inference, account probe or authentication-file read was performed.

Implemented: bounded Markdown/JSON v1 parser; explicit schema mapping and validation; incomplete draft saving; isolated returned copies; server-owned version/approval/task boundaries; revision conflicts and project isolation; preserved prior approvals; private creation/approval timestamps and raw input; provider-free React input/edit/preview/version/approval/task UI with injected callbacks. No additional package dependency.

## Verification record

| Command / check | Exit | Result |
| --- | --- | --- |
| `npm.cmd ci --offline --ignore-scripts --no-audit --no-fund` | 0 | Installed 11 packages from the lockfile/local cache; no network installation or lifecycle scripts. |
| Baseline `npm.cmd run verify` | 1 | Baseline typecheck passed, all 56 existing tests passed; baseline build failed on esbuild parent-directory access denied. |
| RED `node --test tests/planning.test.ts` before implementation | 1 | Expected missing parser module failure. |
| First GREEN `node --test tests/planning.test.ts` | 0 | 13/13 Planning tests passed. |
| `npm.cmd run typecheck` after implementation | 1 | Missing `shared/parallel.ts` (TS2307) and downstream inferred-any diagnostics. No common contract was manufactured to mask this. |
| Intermediate `npm.cmd test` | 0 | 69/69 passed: 56 existing + 13 Planning tests before review regression was added. |
| Review regression `node --test tests/planning.test.ts` | 0 | 14/14, independently rerun by the reviewer after the approval-forgery fix. |
| Initial `node tests/fixtures/planning/verify-ui.mjs` | 1 | Test regex incorrectly matched `src=` inside safely escaped text. Corrected assertion to inspect actual HTML tags. |
| `node tests/fixtures/planning/verify-ui.mjs` after assertion correction | 0 | TSX transform and React server-render smoke passed; hostile text escaped, initial actions disabled, no provider callback required. |
| Latest scoped `node --test tests/planning.test.ts` | 0 | 16/16 including canonical fixture round-trip, runtime envelope checks and serialization-hook forgery. |
| `node tests/fixtures/planning/verify-bundle.mjs` | 1 | Standalone browser bundle attempted separately; same esbuild parent-directory access-denied error as baseline. |
| Final `npm.cmd test` | 0 | **72/72 passed**: 56 existing regressions + 16 Planning tests; no skips. |
| Final `npm.cmd run typecheck` | 1 | Shared module still absent; same TS2307 and downstream inferred-any errors. |
| Final `npm.cmd run build` | 1 | Same pre-existing esbuild sandbox directory-access failure; not a successful build. |
| `git diff --check` | 0 | No tracked diff whitespace errors; implementation files are new/untracked. |
| Final `git status --short --branch` / `git rev-parse HEAD` | 0 | Only Planning-owned additions; branch and HEAD unchanged. |

An initial inline bundle command also exited 1 because PowerShell removed inline JavaScript quotes; rerunning with a literal here-string reached esbuild and confirmed the sandbox access error. The checked-in bundle verification script avoids shell quoting ambiguity. No access policy was weakened, no parent files were copied and no sandbox bypass was attempted.

## Independent review

The execution contract explicitly requires a separate read-only reviewer. The reviewer found and reproduced an important `toJSON` snapshot-check bypass that could forge approval. The fix stores a separate private trusted copy, checks mutation without JSON serialization, and derives approval/task content only from that private copy. A regression covers both forged approval and changed task content. The reviewer verified the fix and 14/14 scoped tests, reporting no remaining important findings in the inspected code. UI asynchronous behavior was reviewed statically, not in a browser.

## Limitations and follow-up

- Missing integration-owned `shared/parallel.ts` and common contract tests block complete type checking and integration acceptance. The integration owner was asked to distribute them; they were not duplicated locally.
- Production and standalone bundle verification are blocked by esbuild's sandbox parent-directory access error. The successful transform/server-render smoke is not equivalent to a browser bundle or E2E test.
- Browser interaction, visual layout, async project-switch races, actual file selection and network callback failures were not exercised interactively.
- Storage is memory-only. HTTP/CSRF/session wiring, SQLite durability, persisted tasks and application routing remain unimplemented integration work.
- Nonempty canonical `decisions` are explicitly unsupported until the shared contract can represent them. The parser does not support arbitrary Markdown or the old 0.2 schema.
- No provider inference, actual agent editing, native reconnect/interrupt probe, paid API or public listener was used. Existing regression tests cover simulated reconnect/interrupt and verification separation, and disposable Git repositories cover path/worktree safety.

See `INTEGRATION-CONTRACT.md` for exact boundaries and required acceptance checks. This report is not a claim that integrated Planning Studio is production-ready.
