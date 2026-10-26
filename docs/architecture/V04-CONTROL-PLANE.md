# Orbit v0.4 — Provider-Neutral Development Control Plane

Status: accepted direction with the user's 2026-10-27 conditions incorporated. This specifies contracts, not a claim that they are implemented. Implementation evidence lives in ORBIT-MASTER-RESULTS.md and V04-BACKLOG.md. Baseline: faba903, Node 24 / node:http / node:sqlite WAL / React / esbuild / node:test.

## Scope and migration

Keep the current App Server, Studio, Projects, Verification, Review, Planning Agent, Merge, Workflow, Model Hub, telemetry and Runner implementations. Add boundaries around them before extracting implementations. No new orchestration framework, API billing default, credential intermediary, plugin installation or native feature activation. codex-plugin-cc is an optional Collaboration component, never a second writer/manager for an Orbit-owned operation. Existing ADR-001–008 and every A–K requirement remain; changes are recorded in V04-ADR.md, not silently substituted into historical design documents.

Two independent milestones:
- **M-CP:** v0.4 control plane contracts implemented and qualified for explicitly named runtime/OS/configuration combinations. Tracking may ship before execution qualification. No autonomous readiness inferred from partial completion.
- **M-PRODUCT:** all existing A–K requirements, remaining backlog, actual files, Windows E2E, recovery and operating documentation completed. M-CP does not imply M-PRODUCT.

## Four boundaries

| Boundary | Owns | Must not claim/own |
|---|---|---|
| AgentRuntime | Official session/turn/events, cancellation, permission requests, observed native identity/termination/usage | Project acceptance, final merge approval, cross-provider budget reset |
| ModelBackend | Existing text transports, destination/model policy, response/usage | Coding tools, worktree ownership, implicit CLI backend replacement |
| Collaboration | Roles, native subagents/teams where qualified, bounded handoff/review/integration | Duplicate agent loop, independent write manager, implicit child permissions |
| Extension | Inventory, source/version, project profiles, preview/backup/CAS apply/restore | Execution authority obtained merely by installing a skill/MCP/plugin/hook |

The current Codex stdio adapter remains the first runtime. CLI subscription authentication remains delegated to official tools. Native CLI egress does not traverse Model Hub; Model Hub guardrails cannot be advertised as protecting all native traffic. A model connection is not an agent runtime. Capabilities are qualified by runtime version, OS, auth/billing mode, policy fingerprint, evidence and collection time; documentation/fixtures/live validation remain distinct.

## Policy Engine: scope is part of every decision

Each policy claim records `owner: orbit | runtime | unverified`, `status: enforced | attested | unknown | blocked`, its scope and evidence. Runtime attestation never becomes OS enforcement evidence. Missing/expired/mismatched evidence is unknown. The API accepts no browser-supplied enforcement facts.

| Control | Orbit directly enforces | Native dependency / limitation |
|---|---|---|
| API admission | loopback, session, Origin/CSRF, exact fields, idempotency, explicit user action | Does not control actions started outside Orbit |
| Approval | current plan/scope/digest, separate check and merge approval, RPC requests denied by default | Whether a runtime respects supplied permission policy requires runtime evidence |
| Workspace | registered/canonical worktree, source/base checks, ownership/conflict admission | A worktree is not an OS sandbox; external processes can change it |
| Runtime restrictions | safe spawn, environment allowlist, requested options, response attestation, reject mismatch | Filesystem/network/tool restrictions are native-enforced; do not infer from flags alone |
| Egress | Model Hub destination/input policy and native handoff input filtering | Native file discovery/model egress and extension subprocesses are separate surfaces |
| Budget | admitted top-level operations/attempts, explicit retry prohibition, elapsed deadline and stop request | Deadline is a cancellation trigger, not proof of stop or exact token/cost cap |
| Recovery | durable intent, quarantine, no replay, explicit release requirements | Remote session/descendant liveness may remain unknown after parent exit |

Unverified safety-critical controls block execution; they do not become a warning that a user can click past. The user may acknowledge unknown *usage observation* under the Assisted conditions below, never unknown isolation/ownership/termination capability.

## Three operating levels

| Level | Allowed | Required / forbidden |
|---|---|---|
| Goal Tracking | Store goal versions; link approved plans/tasks; inspect evidence, blockers and history | Zero runtime/model/tool calls from reads/reload/restart. No execution grant. Available with zero providers and unknown quota |
| Assisted Execution | One explicit, bounded user-approved operation; new action requires a new scoped decision | Known safe runtime profile; current approved write task; single owner; no unresolved recovery; finite deadline/attempt envelope; no auto retry/next task/provider switch; no native goal/teams/background plugin jobs |
| Autonomous Execution | Approved bounded multi-step continuation, only after all gates qualify | Default OFF. Requires qualified runtime/OS safety, aggregate hard budget enforcement, child lifecycle, recovery, ownership, acceptance and approval contracts. No automatic final merge |

The existing six execution modes remain product scope. A Goal tracking record does not enable the existing native Goal executor. Autonomous requires V04-AC-AUTO and runtime/platform evidence; merely setting a boolean or passing pure contracts is insufficient. Existing pure ExecutionBudget strict checks remain strict; Assisted gets an explicit separate policy rather than falsifying `tokenLimitEnforced` or loosening the autonomous contract.

## Quota observations versus enforceable execution envelopes

`SubscriptionObservation` contains source, observedAt, freshness and `available | exhausted | unknown`. Tokens/cost are separate observations with coverage; unknown is never zero. Account observations are not reservations against other applications. An old exhaustion observation stays blocking until a fresh available observation or authoritative reset evidence; expiry must not downgrade it to an overridable unknown.

An Assisted operation with unknown/stale quota is admissible **only if all** are true:
1. Direct user initiation for exactly one current operation with explicit `quotaUnknownAcknowledged`; no scheduled/background/automatic initiator.
2. Subscription CLI authentication is confirmed; no automatic key/API/credit fallback or model/destination switch.
3. Safe runtime/OS/configuration profile, policy attestation, worktree/ownership and recovery gates passed. Unknown safety cannot be acknowledged away.
4. At most one top-level turn/attempt, concurrency one, no automatic retry/continuation/delegation. Existing Solo deadline is 120,000 ms; this is a stop-request deadline, not a guaranteed termination time or token cap.
5. Stop is available, failures enter quarantine, and a new operation cannot start until required termination/release evidence is present.
6. The user did not request a hard token/cost cap that this path cannot enforce. UI explicitly says exact tokens/cost/remaining subscription are unknown and not capped by Orbit.

Fresh exhausted quota blocks Assisted and Autonomous. Unknown/stale/malformed quota blocks Autonomous. Autonomous additionally requires finite verified aggregate turn/attempt/iteration/time/token budgets, and a hard cost budget for an explicitly opted-in API path. Observed tokens or an estimated USD number cannot satisfy hard enforcement. Reservations are durable before dispatch; uncertain work retains reservation. Resume, retry, child work, runtime switch and native goal reset do not reset the parent ledger. Budget amendments require an explicit versioned user decision.

## Recovery Engine contracts

### Identity and termination

Every operation has an immutable operation/request ID, runtime ID, manager incarnation nonce, native session/turn IDs when acknowledged, policy fingerprint, canonical resource identity and dispatch state. OS PID alone is never identity. Where supported, store OS boot/process start identity; otherwise cross-restart process identity is unknown. Never signal a PID recovered from storage without matching ownership identity. No `kill(pid, 0)` or PID absence is accepted as complete termination evidence.

Evidence levels are independent:
- `process_closed`: close observed on the exact owned ChildProcess in the same manager incarnation (or pre-dispatch spawn failure without PID). A kill request/error/timeout does not establish this.
- `session_terminal`: authoritative terminal/idle evidence for the exact session/turn. A transport disconnect does not establish this.
- `descendants_stopped`: all authorized children/teams/background jobs accounted for, or a qualified profile proves none were permitted. Parent close alone does not establish this.
- `manual_attestation`: a local human explicitly reports inspected termination. Preserve who/when/scope; never promote to machine proof.

Native terminal completion may permit a next turn in the same qualified manager/session; uncertain dispatch requires the stricter recovery path. Detached/remote/native child behavior must be qualified before enabling it.

### Quarantine and release

`intent -> dispatched/unknown -> terminal OR quarantined -> release-ready -> released`. Transactionally record intent before side effects. Startup inventory and quarantine complete before admitting work. Persisted Run `lost` is historical execution state, not permission to reuse resources.

Automatic release requires the termination evidence required by that runtime profile, no remaining writer, matching operation generation, and a fresh canonical workspace/base/source check. Lease expiry, manager exit, terminal UI text, TTL, or a later session with the same PID cannot release it. Storage failure keeps a volatile deny barrier and must be durably repaired before release; startup reconstruction fails closed on unresolved intent.

Manual recovery is an explicit preview/confirm transaction bound to operation ID, recovery revision, workspace/source identity and the exact unresolved facts. It neither retries nor changes lost into successful. Human attestation is allowed only for a previously qualified Assisted profile and fresh conflict checks, never to activate Autonomous or override known running work, unknown safety, identity mismatch, or a live owner. If termination cannot be established to the profile's standard, keep the old resources quarantined; creating another worktree does not bypass a repository/account conflict.

### Single execution manager and resources

One owner incarnation and fencing generation per operation. Every Orbit-controlled writer, including plugin/native collaboration integration, must use the same ownership handoff. Never run both Orbit and a plugin manager with write authority for the same task. Ownership transfer requires old-owner release proof before new dispatch.

Resource identity includes canonical repository/commonGitDir, target branch, worktree and account slot; aliases, case folding and reparse/symlink changes are rejected or canonicalized with verified identity. A shared lock authority must work across state directories/processes. Initial implementation stays sequential and repository-exclusive; parallel worktrees are a later qualified strategy. External Git is not cooperative: pre/post freshness checks remain mandatory and no lock promises protection from arbitrary external writes.

## Goal and Evidence Engines

Goal versions bind approved plan, requirements, acceptance criteria, task DAG, stop conditions and policy/budget version. Lifecycle: draft/ready/active/verifying/awaiting_approval/achieved, plus paused/blocked/recovery_required/cancelled. Tracking can start before executors. An agent's completed message is evidence to examine, never acceptance. Plan changes preserve history and invalidate affected current satisfaction, not historical results.

Evidence references existing Run/Check/Review/Approval/Merge/Artifact records, with source, approved suite/test/runner content, policy/runtime/OS/version and provenance. Existing source fingerprints cover Git-visible bounded inputs, not all ignored dependencies or transient changes. Acceptance records explicitly describe that limit. An agent changing tests before a passing run does not qualify the original acceptance suite; test changes need separate review/reapproval.

Legacy evidence is reference-only until mapped and qualified; missing historical facts remain missing. Model report, executed local check, accepted requirement, human decision and merge receipt are separate classes. Authored diagrams are not code-analysis proof. Goal achieved requires current applicable evidence, required review disposition, current human approval and no unresolved execution. Merge evidence is required only when the objective includes merge; merge remains separately approved.

## Persistent integration and operating boundaries

Add tables alongside the existing Store: goals/versions/task links, acceptance/evidence references, operations/recovery, resource ownership, budget ledger. Preserve old IDs/bodies/receipts. Use versioned additive migrations, fixture backup/restore tests and no user DB transformation until the migration gate passes. Wrap existing services first. There must be one dispatch path during migration, not dual execution or automatic legacy evidence promotion.

Existing registered verification commands run outside the native coding sandbox; report this scope and require approved command/suite inputs. Extensions remain inventory-only until profile/source/permission preview, backup, CAS update and rollback tests pass. Do not enable hooks/goals/multi_agent/plugins as a side effect of adding these contracts.

Mac tests, Windows fixtures, Windows browser E2E and actual native services are four different evidence categories. No active daemon, unattended catch-up, external API activation or installation is implied by continuous goal tracking.

## Official references reviewed 2026-10-27

- [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).
- [codex-plugin-cc pinned source](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346): optional review/rescue/transfer, not acceptance authority.
- [Claude headless](https://code.claude.com/docs/en/headless), [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [Hooks](https://code.claude.com/docs/en/hooks), [Teams](https://code.claude.com/docs/en/agent-teams).
- [Claude sandbox scope](https://code.claude.com/docs/en/sandboxing): native Windows commands unsandboxed; file/MCP/hooks outside shell sandbox. Do not claim Windows write parity.
- [Claude subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): personal subscription use and third-party product distribution must be assessed separately; no automatic billing migration.
