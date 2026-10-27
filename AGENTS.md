# Orbit — Agent instructions

## Required source of truth
Before planning or editing, read `docs/ORBIT-VISION.md` and `docs/ORBIT-SCOPE-2026-10-27.md`. The vision defines product identity; the scope defines approved functionality. Consult `docs/ORBIT-IMPLEMENTATION-PLAN-2026-10-27.md` for implementation sequencing, then inspect actual code, tests, local Git status, and relevant architecture documents. Older PRD/Goal/Backlog files are historical context where they conflict with approved product scope.

## Product direction
Orbit is a provider-neutral, local-first, general-purpose AI task automation platform, **not** merely a coding control center. Preserve the natural-language goal → planning → approved task specification → project → selected AI execution → collaboration/verification → artifacts workflow, with simple/advanced modes. Support noncoding tasks, observable progress, durable decisions and handoffs, and user-extensible model/provider/agent registration. Never silently narrow the product vision when a new idea or implementation constraint arises. Propose scope/vision changes separately and require explicit user approval.

## Development collaboration
Claude Code and Codex may both develop Orbit on the new PC. Use the same approved specifications, separate worktrees/branches for simultaneous changes, clear file ownership, review, and tested integration. Do not confuse the tools developing Orbit with the AI tools Orbit supports. Reuse official native agent capabilities and existing Orbit modules before implementing substitutes. Preserve existing working features and data.

## Safety and evidence
- Inspect OS, installed tools, versions, local branches, worktrees, and dirty state before changes; do not assume remote HEAD is latest.
- Preserve user changes, SQLite DB/WAL/SHM, and worktrees. Never run destructive Git commands (`reset --hard`, `clean`), force-push, merge into main, or deploy without approval.
- Never read, display, or commit credentials, `auth.json`, tokens, cookies, API keys, or other secrets. Do not bypass authentication or approval controls.
- No unexpected paid API use, new installations, public inbound ports, external transmission, or elevated filesystem permissions without explicit authorization. Keep local services bound to loopback by default.
- Prefer official provider protocols and capability probes. Distinguish installed/authenticated/connected/verified/unsupported/unknown; do not invent model capabilities, usage limits, or cost figures.
- Keep execution complete separate from verification passed and user approved. Track observed events, evidence, blocked reasons, and recovery states; never fabricate progress percentages or ETA.
- Work in small, testable increments; run appropriate tests and report actual commands, exit codes, changed files, unresolved issues, and next actions. Do not mark mock tests as live integration success.

## Engineering approach
Use the existing TypeScript, React, Node, SQLite architecture unless evidence justifies a change. Reuse existing Planning, Handoff, Workflow, Agent, Verification, Visualization, and Model Hub functionality. Use isolated disposable repositories/worktrees for tests that write code. Do not edit unrelated repositories. Keep design decisions and current progress in `docs/`.
