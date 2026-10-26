# Orbit v0.4 backlog and acceptance register

Status date: 2026-10-27. Design: V04-CONTROL-PLANE.md; decisions: V04-ADR.md. A checked design is not implemented software. Historical baseline 779 total / 778 pass / 1 Windows-only skip is a Mac record, not the current run.

## Milestones

- [ ] M-CP: qualified control plane (scope/version/OS stated), including all required execution/recovery/ownership/evidence gates. Autonomous remains disabled until its own gate.
- [ ] M-PRODUCT: all ORBIT-GOAL.md A–K requirements and Windows final E2E; not implied by M-CP.

## Dependency-ordered backlog

| ID | Work | Acceptance | Current implementation |
|---|---|---|---|
| V4-00 | Final design/ADRs, baseline, additive migration inventory | BASE, MIG | Design finalized; fresh baseline recorded in RESULTS |
| V4-01 | Policy scope projection and level/budget contracts | POLICY, LEVEL, QUOTA | Pure contracts + inert HTTP/Security UI implemented and locally tested in Task25; execution qualification pending |
| V4-02 | Solo uncertain-run quarantine and exact release evidence; shared Recovery integration | REC-IDENTITY, REC-STOP, REC-RELEASE, REC-STORAGE | Task26 same-state quarantine/dispatch fencing; Task27 operation identity/history; Task28 pre-factory intent and exact owned ChildProcess observations, unfinished-journal startup barrier, inert UI and actual Node/browser restart tested. Parent close is not descendant/remote stop. Runtime/policy/OS qualification, exact release, shared recovery and cross-state ownership pending |
| V4-03 | Cross-state-dir repository/branch/worktree/account ownership and common dispatch | OWNER, DISPATCH | Task29 repository identity/SQLite authority primitive tested with two actual processes and separate state-dir/worktree fixtures; durable claim survives owner kill, fencing/CAS and no-dispatch-only relinquish. Not wired into legacy dispatch; runtime-qualified release, account authority and all-writer integration remain pending |
| V4-04 | Goal Tracking with plan/task binding; inert reads and durable history | GOAL, MIG | Tracking HTTP/UI/history implemented; Task25 Mac browser restart/isolation verified. Acceptance qualification and broader migration rehearsal pending |
| V4-05 | Evidence qualification and trusted acceptance content | EVIDENCE | Pending; current Check/Review/Merge reused |
| V4-06 | Assisted admission connected to existing services, explicit grants and budgets | ASSIST, QUOTA, DISPATCH | Pending; legacy manual paths not certified as this profile |
| V4-07 | AgentRuntime extraction and Claude-only qualified route | RUNTIME, WINDOWS | Pending; Codex stdio remains existing implementation |
| V4-08 | Recovery handoff, aggregate ledger, native collaboration, bounded Autonomous | AUTO, OWNER, REC-STOP, EVIDENCE | OFF; depends on V4-01–07 |
| V4-09 | Existing A–K unfinished product work | PRODUCT | Preserved below |
| V4-10 | Platform E2E, operating docs, recovery/migration rehearsal | WINDOWS, PRODUCT, MIG | Pending |

## Acceptance contracts

| ID | Required test and expected result |
|---|---|
| BASE | Node 24 typecheck + full node:test suite + build; preserve every failed attempt and cause. Run actual command, not old counts. Record OS, CLI use, external calls and skips |
| POLICY | An attested runtime sandbox remains runtime-dependent; missing/stale/version-mismatched safety remains unknown and denies launch. API caller cannot submit trusted enforcement facts. Read-only status performs zero CLI/network/config discovery |
| LEVEL | Tracking persists with zero providers and never launches on read/reload/restart. Assisted requires direct initiation. Autonomous cannot be enabled by choosing Goal mode or passing a client flag |
| QUOTA | Unknown/stale quota + explicit acknowledgement + one safe assisted operation can pass only without a required hard token/cost cap. Known exhausted, wrong auth, missing ack, retry/schedule/delegation or unknown safety denies. Old exhausted does not degrade into eligible unknown. Autonomous denies unknown and unenforceable token/cost caps |
| REC-IDENTITY | PID reused by unrelated process, PID missing, boot changed, owner nonce changed and foreign session events never authorize kill/release. Matching ChildProcess close is scoped to its own incarnation |
| REC-STOP | Interrupt ack, error, signal sent, deadline, transport EOF and parent exit with unknown children cannot prove full stop. Terminal session + required child/process evidence can qualify only its matching operation |
| REC-RELEASE | Startup lost operation blocks new conflicting writes before connection/dispatch. Release is revision/source/ownership bound. Manual attestation is labeled human, does not mark success, never retries and cannot activate autonomous. Stale preview/running owner/conflict denies |
| REC-STORAGE | Intent storage failure prevents dispatch; termination/release storage failure keeps deny barrier. Restart reconstructs unresolved quarantine. Failure between commit and notification cannot duplicate execution |
| OWNER | Two processes with different state directories, path aliases and two worktrees of one repository cannot acquire conflicting ownership. Lease expiry cannot steal active/uncertain ownership. Plugin/Orbit never both write the same task |
| DISPATCH | Task, free prompt, review, planning, workflow, model request and merge paths cannot bypass applicable policy/ownership/recovery gates. Duplicate requests return receipts without side effects; conflicts reject |
| GOAL | Plan change invalidates current applicability without rewriting historical evidence. Foreign task/plan IDs reject. Agent complete does not imply achieved. Tracking does not rewrite old Run/Task bodies or invoke runtime |
| EVIDENCE | Removed assertion/modified runner cannot satisfy original approved suite. Changed source/version/OS evidence stays stale/reference-only. Independent review provenance and authored diagram provenance remain distinct |
| ASSIST | Unknown quota execution is one confirmed operation, max one attempt, no continuation, finite server deadline, same qualified runtime/destination, explicit uncertainty disclosure; deadline enters stop/recovery, not guaranteed-token-cap success |
| AUTO | All safety, exact profile, aggregate enforced limits, descendant accounting, ownership, recovery, evidence and approval tests pass before enablement. Native goal reset/retry/resume does not reset ledger. No implicit final merge or API fallback |
| RUNTIME | Codex absent/Claude-only planning→implementation→check→human approval works in a qualified environment. SDK adoption changes neither authentication nor billing implicitly. Native unverified capability is not ready |
| WINDOWS | Real Windows browser E2E + actual applicable CLI checks on exact version/config; Mac tests and Windows mocks are explicitly insufficient. Path/case/reparse, process stop, restart and simultaneous managers exercised |
| MIG | Additive migration on fixture copy preserves old IDs/bodies/events, repeat migration is safe, failure rolls back, backup restores, legacy evidence remains reference-only |
| PRODUCT | All A–K rows below and ORBIT-GOAL completion conditions satisfied; generated files inspected, restart tested, external-service unknowns reported |

## Existing backlog preserved (not replaced by V4)

The complete S0–S4 IDs remain in docs/03-BACKLOG.md; Task0–24 history remains in ORBIT-MASTER-PLAN/RESULTS. No unchecked legacy item is silently marked done by this file.

| A–K | Preserved unfinished scope / dependency |
|---|---|
| A Dashboard/Projects | Project management, goal/blocker/recovery overview, state persistence |
| B Planning Studio | Ideas/brainstorming, neutral PRD/ADR/task flow, import/export, approved revisions, native planning live validation, optional official Planning Bridge and feedback |
| C Agent Center | Claude/Gemini/OpenCode optional adapters, roles, session recovery, qualified native subagents, isolated worktrees and handoff; one provider sufficient |
| D Development | Task30 static HTML/CSS/JS result preview implemented and Mac Chrome fixture verified; build/backend preview and Task→Run→Check→result source binding pending. Existing diff/check/review/merge, richer language/function/class/dependency/call graph, change impact, qualified native review and trusted acceptance remain |
| E Visualization Studio | Existing Mermaid/C4/UML/sequence/flow/PPTX/MD preserved; PDF, report/chart PPTX, additional UML, source-backed architecture and stale checks |
| F Automation | Workflow/templates/DAG, explicit retry; schedule and external/AI steps only behind admission and recovery |
| G Model Provider Hub | Bedrock/LiteLLM/vLLM/FreeLLMAPI/OpenAI-compatible/local/future, actual transport vs live validation, streaming capability, diagnostics/routing/usage |
| H Extensions | MCP/Skills/Plugins inventory and project profiles, trusted discovery, permission/source preview, backup/CAS apply/restore |
| I Privacy/Security | Project policy, masking/pseudonymization/blocking, destination recheck, native/gateway distinction, audit without raw secrets |
| J Usage/Analytics | Subscription observations/reset, API cost separately, token/time/retry coverage, quality/project statistics, unknown preservation |
| K Runner | Existing bounded Node/Git verification and sequential integration, conflicts and structured recovery; no duplicate native orchestration |

## Implementation ledger

Updated per verified slice in ORBIT-MASTER-RESULTS.md. Distinguish implemented, automated test results, actual runtime/browser evidence and unverified features. A contract-only module does not complete an executor or platform milestone.
