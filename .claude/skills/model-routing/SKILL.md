---
name: model-routing
description: Choose and escalate the Claude model for an orchestrator-spawned Claude worker task (Sonnet 5.5 for general implementation/UI/tests, Opus 5.5 for concurrency/recovery/security/architecture, Sonnet→Opus→Fable 5.1 only for unresolved code defects), with a ledger of actual model, escalation reason and verification result. Use before spawning a Claude worker and after verifying its result.
allowed-tools: Bash(node .claude/skills/model-routing/route.mjs:*) Read
---

# Adaptive model routing for Claude workers

Ledger: `.local/orchestrator/models/` (gitignored). `availability.json` holds the models verified through the subscription CLI. One `<task>.json` per task records selection, results and escalations.
The router only records decisions. It never calls a model. The Agent tool's `model` parameter (`sonnet` | `opus` | `fable`) runs the worker.

Scope: Claude workers only. Codex tasks run through `/codex` with Codex's configured model. In-flight tasks keep their model. Routing applies to new tasks only.
Limits stay as they are: at most 2 Workers in total, at most 1 Codex, one integration queue.

## Before spawning a worker

```bash
node .claude/skills/model-routing/route.mjs select --task <id> --class <impl|ui|test|docs|concurrency|recovery|security|architecture> --sha <base sha>
```

- `impl`, `ui`, `test` and `docs` go to `sonnet`. `concurrency`, `recovery`, `security` and `architecture` go to `opus`.
- A task that already exists keeps its model (`reused:true`).
- Pass the returned `model` to the Agent tool `model` parameter.

## After verifying the worker's result

```bash
node .claude/skills/model-routing/route.mjs record --task <id> --result pass|fail --sha <result sha> --verify "<command: counts/exit>" [--fingerprint <error id>] [--usage '<json>']
```

- On failure, set `--fingerprint` to a stable id for the defect, such as the failing test name plus the assertion.
- `--usage` takes the observed usage only, such as tokens, or the CLI `total_cost_usd` marked as an estimate. Never invent numbers.

## Escalation (code defects only)

```bash
node .claude/skills/model-routing/route.mjs escalate --task <id> --reason code_defect --fingerprint <f> --sha <sha> --evidence <log path>
```

- Analyze the cause first. Escalate only after a failure with that fingerprint is recorded on the current model.
- The order is `sonnet → opus → fable`. `fable` is used only while `availability.json` shows it as verified.
- `environment`, `provider_capacity`, `quota_exhausted` and `approval_blocked` never escalate (exit 3, `NOT_A_MODEL_PROBLEM`). Fix the environment, wait, or ask the user.
- There are at most 4 failures per fingerprint in total. At the top model, there are at most 2 attempts. After that (`ATTEMPT_LIMIT_REACHED` / `NO_HIGHER_MODEL`), stop and report to the user with the evidence.
- When the model changes, the worktree, branch, source SHA, failure log and approval scope carry over unchanged. The new worker receives the previous failure evidence path in its prompt.

Re-verify availability with one minimal `echo "Reply with exactly: OK" | claude -p --model <m> --output-format json` per model. Record it with `route.mjs availability` only when `modelUsage` shows the expected model id.
