# Orbit child environment security baseline

> **For agentic workers:** Use superpowers:executing-plans for this security fix. Parallel feature implementation is not authorized by this preparation task.

**Goal:** Prevent parent process secrets and execution overrides from reaching the Codex RPC child while retaining existing local ChatGPT authentication discovery.

**Architecture:** Construct a new environment from an explicit, small allowlist. Keep the existing Rpc constructor, transport, Codex arguments, MCP preflight, approval denial, Controller, HTTP and SQLite contracts unchanged.

**Tech Stack:** Windows, Node 24, TypeScript, node:test, existing native Codex.

**Spec:** User request: fix server/rpc.ts first, add regression tests, verify existing isolation/worktrees, commit locally, then prepare three independent work groups. No push, merge, billable API, auth/config/DB/user-project changes.

## Design and decisions

- Root cause: `{...process.env}` removes only OPENAI_API_KEY and CODEX_API_KEY; every other parent variable is inherited.
- A longer denylist misses unknown secrets. An empty environment loses existing authentication discovery and Windows runtime support. Use an explicit allowlist.
- Allow PATH/PATHEXT, SYSTEMROOT/WINDIR, TEMP/TMP/TMPDIR, HOME/USERPROFILE/HOMEDRIVE/HOMEPATH, APPDATA/LOCALAPPDATA, CODEX_HOME, LANG/LC_ALL/LC_CTYPE/TZ. Copy only defined string values, not credentials. Do not invent homes or read/copy authentication files.
- Match names case-insensitively on Windows and emit a single canonical spelling. Conflicting aliases fail closed. On other systems names are case-sensitive; other platforms remain unverified natively.
- Drop all other names, including provider/cloud/GitHub tokens, arbitrary unknown secrets, NODE_OPTIONS, loader variables, proxy/endpoint/CA overrides, GIT_CONFIG_*, Orbit settings and Codex runtime overrides. Proxy/custom CA deployments may need a separately reviewed compatibility change; never restore blanket inheritance.
- These trusted parent path values retain their existing meaning. This is environment minimization, not protection against malicious same-user processes, configuration files or filesystem reads.
- Keep the current dedicated branch for the baseline; create group worktrees only after the verified baseline commit. No feature workers are started now.

## Global constraints

- Preserve existing DB/WAL/SHM, authentication, settings, user projects and Git history.
- No token values, raw account response, raw child environment or sensitive logs in output/artifacts.
- No inference or token refresh in the native auth check; account/read with refreshToken=false only.
- Existing deny-by-default approvals, MCP checks and worktree gates remain intact.

## Review focus

1. Windows key casing and conflicting PATH/CODEX_HOME aliases.
2. Unknown secrets and runtime loader injection bypassing a denylist.
3. Missing/empty authentication home variables and parent environment mutation.
4. Authentication compatibility with current native Codex without paid inference.
5. Worktree ownership boundaries and nested test discovery in future groups.

## Task 1: RPC environment isolation

Files: create server/child-env.ts and tests/rpc-environment.test.ts; modify server/rpc.ts.
Interface: buildChildEnv(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv. No Rpc API change.

- [x] Add a real child process probe with synthetic secrets and runtime injection; confirm it fails against current Rpc.
- [x] Implement the allowlist and use it at spawn. Add synthetic unit coverage for missing, empty locale, undefined, inherited and Windows alias cases. Empty auth-location cases remain a documented minor test gap.
- [x] Run targeted tests and npm.cmd run verify (typecheck, full test suite, build).
- [x] Run native MCP checks in both modes using disposable CODEX_HOME. Run no-turn account/read without printing account data or requesting refresh.
- [x] Record exact results and limitations; independently review the bounded change.
- [ ] Audit and explicitly stage only source/tests/docs; make the local security baseline commit.

## Task 2: Parallel preparation

- [x] Document Planning, Visualization and Provider/Guardrail ownership and integrator-owned shared interfaces.
- [ ] Create separate worktrees/branches at the verified baseline, without copying runtime state or starting servers/workers.
- [ ] Verify each worktree HEAD, clean state and distinct branch. Report paths and readiness separately from future feature completion.

## Execution record

- Starting HEAD: 030f07ad63dd3a0f2ee8230d8d6450a8109f24e1, phase1/codex-web-slice, clean.
- Process ancestry identified current session helpers and application services; no other repository editor identified. Existing review agents are completed. No process was terminated.
- Ruling: use one bounded inline security change before group work starts; current user request already authorizes implementation and a local baseline commit.
- RED: real child exposed 17 synthetic variable names, exit 1. GREEN: targeted 8/8, full 56/56 + typecheck/build, exit 0. Native auth visibility and both MCP modes passed without inference.
- Independent read-only review passed; no Critical/Important findings. Minor deferred: generated auth-probe directories accumulate; explicit empty HOME/CODEX_HOME cases not yet covered. Both are recorded in docs/PARALLEL-DEVELOPMENT.md.
- Review rulings: native evidence belongs to the implementer's actual checks; the reviewer did not repeat them. Cross-platform/proxy/OS isolation and other spawn paths stay outside the verified Rpc claim. Future group contracts are proposals, not completed features. Costs if these limits are ignored: broken connectivity or overstated security/readiness.
- Existing DB/WAL/SHM hashes unchanged. Commit and group checkout outcomes will be recorded in the final report; no further product changes are planned.
