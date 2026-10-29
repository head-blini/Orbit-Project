---
name: codex
description: Delegate one bounded Orbit development task to Codex CLI (`codex exec`) in a chosen worktree, with a durable run record, duplicate-run lock and no sandbox bypass. Use when the orchestrator assigns a task to Codex or the user types /codex.
argument-hint: <task-id> <worktree-path> [read-only|workspace-write] -- <instructions>
allowed-tools: Bash(node .claude/skills/codex/codex-run.mjs:*) Read
---

# /codex — delegate a task to Codex

Wrapper: `node .claude/skills/codex/codex-run.mjs` (run from the Orbit repo root).
Records: `.local/orchestrator/codex/<task>/<runId>/` (gitignored): `prompt.md`, `meta.json`, `events.jsonl`, `stderr.log`, `last.md`.

## Before dispatch

1. Run `node .claude/skills/codex/codex-run.mjs --status --task <task>`.
   - A live `lock` means that task is already running. Do not start another run. Wait or read its record.
   - Do not start a new run while `status: unconfirmed` is shown or the wrapper exits 4. Inspect the worktree and record first, then pass `--ack-unconfirmed` only when you have confirmed the old process did not apply anything.
2. Check `git -C <worktree> status` and `~/.codex/sessions/<date>/` for a Codex desktop or CLI session that is editing the same worktree. An interactive Codex session is not visible to the lock. If its last event is not `task_complete`, do not dispatch.
3. Check file ownership: the worktree must not be one where another worker currently owns the files.

## Dispatch

Write the task prompt to stdin. Include:
- goal and acceptance criteria
- owned files and forbidden paths
- the verification commands
- this requirement: "Do not push, merge, deploy, change credentials, or call paid APIs."

```bash
node .claude/skills/codex/codex-run.mjs --task QG-01 --cwd .worktrees/codex-quality-gate --sandbox workspace-write <<'EOF'
...prompt...
EOF
```

- Use `--sandbox read-only` (the default) for review or research and `workspace-write` for edits. The wrapper refuses `danger-full-access` and never passes a bypass flag.
- Use `--resume <sessionId>` to continue the same Codex session. Without it, the call starts a new session.
- `--model <id>` is optional. Without it, Codex uses the configured default.
- For long tasks, use `run_in_background: true` on the Bash call. You are notified when it exits.

## After exit

The wrapper prints JSON: `runId`, `status` (`completed|failed|quota_exhausted|provider_capacity|interrupted`), `exitCode`, `sessionId`, `record` and `lastMessage`.

1. Read `last.md`. Codex's own claims are not evidence.
2. Re-run the task's verification commands yourself (typecheck, test, build) in that worktree.
   Also run `node scripts/orchestrator/select-regression.mjs --base <base> --run` in the worktree: it selects tests that import or read the changed server/shared files plus a mandatory set for gate files (`--json` shows reasons, `--also <test>` appends the task's own tests).
3. If `provider_capacity` (model at capacity), the turn never ran: check the worktree is unchanged, then retry once after a wait with the same prompt. Do not switch models silently.
4. If `quota_exhausted`, do not retry automatically. Record a checkpoint and move to work that does not need Codex.
5. If `failed`, read `stderr.log` and the tail of `events.jsonl`, then decide: fix the prompt and use `--resume`, or reassign.
6. Mark the task done in `.local/orchestrator/STATE.md` only with verification evidence.
