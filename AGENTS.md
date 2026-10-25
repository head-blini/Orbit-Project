# Agent instructions — AI Coding Control Center

## Project goals
Create a provider-neutral, local-first development control center where a user can plan, run and observe coding agents, review diffs, verify tests, and approve work from a browser. Initial implementation environment: only GPT Pro + Codex CLI is available. Claude/Gemini/OpenCode may be absent; they must not block Codex-only or planning-only flows.

## Source of truth
1. docs/00-START-HERE.md
2. docs/01-PRD.md
3. docs/02-TECH-DESIGN.md
4. docs/03-BACKLOG.md
5. docs/07-PROVIDER-NEUTRAL-CORE.md
6. docs/06-CHATGPT-PLANNING-BRIDGE.md — ChatGPT planning is optional for end users.

This root AGENTS.md supersedes conflicting assumptions that Claude Code is required in Phase 0. Do not remove support for future adapters.

## Safety and scope
- Before coding, inspect actual OS, installed tools and versions; report supported versus hypothetical functionality.
- Phase 0 only until its documented gate passes. Work on a dedicated branch if a Git repository exists. For code-writing integration tests, use a disposable repository/worktree. No editing unrelated repositories.
- Do not read or print auth.json, API keys, OAuth tokens, credentials, cookies or secrets. Do not copy credentials into logs or UI responses.
- Use official Codex App Server stdio JSON-RPC for product integration; do not use removed `codex mcp-server` integration or unauthorized authentication workarounds.
- Avoid paid external APIs, unexpected installation, opening public inbound ports, enabling full filesystem access, or bypassing approvals without the user's permission.
- Keep the local application bound to loopback. Browser requests must pass through server endpoints, not read local credentials.
- Test state transitions, reconnect/interrupt behavior, path validation, and separation of 'agent reported complete' from 'actual verification succeeded'.
- Support planning-only with zero providers, Codex-only with one provider, and multi-provider later.
- Preserve user-written changes. Never force-push, auto-merge into main, discard dirty worktrees, or invoke dangerous shell commands silently.
- Record exactly which smoke tests ran, their exit codes, and limitations. Mark unsupported and untested features clearly.

## Approach
Keep dependencies few. Use TypeScript + React + Node + SQLite where practical, but confirm actual needs and versions. Prefer small, testable vertical slices with clearly stated acceptance criteria to giant scaffolds or dozens of dummy services. Keep design decisions in docs/.
