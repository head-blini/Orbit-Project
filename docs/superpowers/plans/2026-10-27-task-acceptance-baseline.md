# Task acceptance baseline implementation plan

Goal: preserve approved Task criteria, host command configuration and selected test/runner/manifest bytes before coding starts; detect changed criteria before verification and approval.

Architecture: reuse Studio execution validation, Projects hardened snapshots, Store Run transaction and VerificationService. Optional `protectedFiles` in existing host-only command configuration. Task launch previews the baseline and requires its digest; the immutable baseline is written atomically with Run intent before native dispatch. Existing local checks remain distinct from acceptance evidence.

Decisions: no new command entry or browser-supplied authority, no automatic execution or rebaselining, no assertion that selected tests cover every criterion. Normal implementation changes remain allowed; only designated files/config/plan are fixed. OS tools, ignored dependencies, intermediate change-and-restore and hostile same-user DB mutation remain outside this bounded integrity check. Actual runtime qualification/ownership and A–K remain unfinished.

1. [x] RED/GREEN AcceptanceService preview/status and immutable Run storage; independent service implementation in disjoint files.
2. [x] Integrate configuration, Task preflight/dispatch CAS, verification pre/post gate and approval evidence; actual subprocess and HTTP tests.
3. [x] UI preview/explicit launch confirmation and integrity status, asynchronous stale-state tests; independent UI implementation.
4. [x] Independent review, Node24 full verification, actual Chrome temporary Git/DB fixture and restart, cleanup.
5. [x] MASTER PLAN/RESULTS/backlog checkpoint prepared for safe local commit. No remote push.

Baseline: macOS arm64, Node24.22.1, branch codex/orbit-mac-handoff-2026-10-26, clean HEAD e053d8d. Previous turn made progress (Task31). Existing dedicated checkout reused. User authorizes routine decisions and internal delegation.

Verification: service12/12; Task HTTP/real Check7/7; UI9/9. First whole943/942pass/1skip, final948/947pass/1Windows skip/0fail/type/build0. Independent read-only review found no remaining P1/P2 after synchronous UI-intent revocation fixes. Chrome fixture performed one synthetic coding dispatch and one actual Node Check, preserved exact Run/baseline/Check across restart, and disabled execution/approval after assertion removal. No real AI or external API; details and evidence paths in MASTER RESULTS Task32.
