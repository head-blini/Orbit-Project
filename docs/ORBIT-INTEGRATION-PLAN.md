# Orbit product integration

Scope authorized by the 2026-10-25 request: main agent implements; three agents review read-only. Reuse existing modules, current branch and dependencies. No Runner, worktree, credential access, external transport, push or deployment. Existing database files are not opened; migrations are exercised only on disposable databases.

1. Restore `shared/parallel.ts` from the documented contracts and add compile/runtime contract tests.
2. Add SQLite repositories using existing parser, approval and Artifact validators. Atomically persist revisions, heads, approvals, task drafts, idempotency receipts and metadata-only events. Registered local projects are the authorization scope; filesystem write permission remains independent.
3. Bind Studio HTTP routes behind existing session/origin/CSRF gates, exact request schemas and route-specific bounded envelopes. Server assigns all authority fields. Persist raw planning source privately; no content in audit events.
4. Mount existing Studios with independent project selection and durable task listing. Reuse the restricted Mermaid React SVG preview. Mount timeline with authoritative snapshot anchors and bounded replay. PPTX export remains disabled.
5. Supply fixed in-memory mock transport and server-owned block policies; add privacy checks before Codex dispatch without changing RPC/sandbox/MCP policies.
6. Verify HTTP workflows, rollback, idempotency, cross-project access, restart recovery, malicious content, privacy denials and legacy regression suite. Record typecheck/test/build exit codes and sandbox limitations in `ORBIT-INTEGRATION-RESULTS.md`.

Review focus: lost mutation responses, stale revisions, foreign-project IDs, escaped maximum-size input, transactions emitting events before commit. Each receives integration coverage. No intermediate Git commits are required; user forbids repeated blocked Git writes.
