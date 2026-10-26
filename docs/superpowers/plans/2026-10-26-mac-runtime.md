# Mac runtime continuation plan

**Goal:** Resume the full Orbit goal by preparing Node 24, resolving the installed native Codex on macOS, and completing the handoff verification and Task17 gate.

**Architecture:** Keep the existing App Server/Rpc and all restricted flags. Resolve native files directly from absolute PATH entries, explicit server configuration, and the official npm platform package layout. A small shared native-file validator also fixes the version probe's Windows-only assumption. No shell wrappers or new dependencies.

**Spec:** `HANDOFF-MAC-2026-10-26.md`, `ORBIT-GOAL.md`, `ORBIT-MASTER-PLAN.md`; user authorized continued implementation and independent review.

## Constraints

- Continue the clean dedicated handoff branch at `23a9296`; root owns Controller/HTTP/shared integration.
- Node 24.x; preserve lockfile, credentials, user data, loopback and approval/MCP restrictions.
- Local synthetic fixtures and native `--version`/schema diagnostics do not prove authenticated AI execution.
- Full-platform goal remains open after this plan.

## Tasks

- [x] Inspect branch/HEAD and required handoff documents. Record actual Mac tool versions.
- [x] Install a checksum-verified official Node 24 runtime under ignored `.local/toolchains`; run `npm ci` using that runtime.
- [x] Add failing resolver regressions for macOS executable/symlink/npm package, explicit override, non-executable/script/directory rejection, absolute PATH, and Windows platform package layouts.
- [x] Implement `findCodex(options?)` in `server/codex.ts`, sharing `resolveNativeExecutable(path, platform)` with `server/capability-probe.ts`. Keep `codexArgs` unchanged.
- [x] Update version-probe tests for both platforms; verify installed binary with `--version`, compare installed App Server schema/flags without reading authentication.
- [x] Run `npm run verify` with default test concurrency; investigate any failures including `merge-http` without hiding them with retries or weaker assertions. Final 479 pass/1 Windows-only skip, type/build0. Windows ECONNRESET root cause is not claimed fixed.
- [x] Finish Task17 independent review, reproduce/fix findings, implement its missing browser scenarios and execute available browser verification with isolated fixtures. Chrome CUA2 scenarios passed; full37-step/Windows run remains unexecuted.
- [x] Update MASTER-PLAN/MASTER-RESULTS with exact counts, exits, evidence paths and limits; continue the next incomplete platform slice.

## Review focus

- npm's PATH symlink is a JavaScript wrapper; never execute it to discover its native package.
- Invalid explicit override must fail closed, not fall back to a different installation.
- Empty/relative PATH entries must not select project-local executables.
- Native version detection is not authentication or App Server feature readiness.
- Failed or closed inventory collection must release server and browser busy state without accepting late results from an older session.
