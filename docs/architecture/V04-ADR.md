# Orbit v0.4 ADR supplement — 2026-10-27

Status: accepted design incorporating conditional approval. Implementation and validation status are separate. This supplements, rather than overwrites, docs/04-ADR-RISKS-SOURCES.md.

| ADR | Decision | Alternatives and change condition |
|---|---|---|
| 009 Four boundaries | AgentRuntime / ModelBackend / Collaboration / Extension; existing Node modular server retained | SDK/framework replacement only after measured benefit and equivalent protocol/security contracts; no blanket rewrite |
| 010 Goal authority and operating levels | Orbit owns goal/acceptance; Tracking, Assisted, Autonomous are distinct. Autonomous OFF until qualification | Native goals may implement bounded continuation; never become the project truth or reset parent accounting |
| 011 Recovery and ownership | Durable intent, exact ownership identity, termination evidence, quarantine, explicit release; one writer manager | No automatic retry after uncertainty. PID/TTL is insufficient. Broader concurrency only after cross-state-dir ownership and child lifecycle tests |
| 012 Evidence qualification | Reuse records with requirement/source/approved suite/runner/policy/platform binding; legacy reference-only | Existing successful checks can qualify only when missing mappings/evidence are supplied; no invented past facts |
| 013 Policy scope and budgets | Orbit enforcement, runtime dependence and unverified controls are explicit. Subscription observations separate from enforceable budgets | Unknown quota may allow strictly bounded Assisted only under V04-CONTROL-PLANE conditions. Unknown safety never does. Strict Autonomous budget contract retained |
| 014 Additive migration and release evidence | Preserve existing data/services and A–K scope; M-CP and M-PRODUCT separate; OS-specific gates | More invasive migration only after backup/restore and compatibility evidence; Mac success cannot satisfy Windows E2E |

## Compatibility with ADR-001–008

001 independent server, 002 official CLI authentication, 003 explainable rule-based assignment, 004 evidence-based completion, 005 worktree isolation, 006 usage provenance, 007 neutral optional external planning and 008 zero/one/multiple-provider support remain in force. ADR-005 is strengthened for managed writes by explicit ownership and isolation qualification; it never meant OS sandboxing. The previous strict ExecutionBudget contract remains for autonomous modes; a separately named Assisted contract documents what can actually be bounded without claiming a hard token cap.

## Risks and decisions that require new evidence

- codex-plugin-cc must not become an independent writer for an Orbit-owned task. Optional read-only collaboration is preferred; write integration requires explicit ownership transfer.
- Runtime claims must be keyed to version/OS/auth/policy evidence. Flags, SDK permission callbacks and Hooks are not interchangeable with complete containment.
- Parent process close does not prove remote session/descendant exit. Unqualified runtimes remain blocked for affected operations.
- Shared repository locking must cover separate Orbit state directories; arbitrary external Git still requires freshness checks.
- Execution deadlines trigger stop; cancellation latency and unobserved usage remain limitations, not hard spending caps.
- No implicit API fallback on quota exhaustion or auth failure. Distribution/auth changes require separate review and user choice.
- No existing backlog item is removed by this supplement. New control-plane work precedes unsafe automation; independent product work remains available.
