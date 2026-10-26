# Native planning suggestions implementation plan

> **For agentic workers:** Use superpowers:executing-plans for assigned bounded modules. Root owns shared contracts, service/SQLite, Controller/HTTP and integration.

**Goal:** Let a user explicitly request a Codex planning proposal and save a validated result as a separate unapproved Planning draft.

**Architecture:** Reuse the official restricted Rpc factory and read-only session checks from native review. A narrow planning adapter runs one stable `turn/start` with `outputSchema`, observes its matching final answer/terminal event and closes its owned process. A service owns preview/consent, receipts, lifecycle/recovery and validated proposal history; Studio creates a draft only after a separate user save. No new orchestration framework or dependencies.

**Tech Stack:** TypeScript/React/Node24/SQLite, official installed Codex0.162.1 App Server.

**Spec:** ORBIT-GOAL B/C; Provider-Neutral Core section3; TECH-DESIGN agent-draft path. [Official App Server](https://learn.chatgpt.com/docs/app-server) documents stable turn/start outputSchema and agentMessage final_answer. Installed `.local/capability-schema-mac/v2/TurnStartParams.json` confirms outputSchema; experimental collaborationMode is not needed.

## Decisions and constraints

- User request text1–8000 chars/32KiB UTF8; inspect all decoded input for known credentials/PII/control characters before preview/start. Preview displays exact outgoing instructions and binds workspace/project/input/policy digests. Start repeats text and requires exact fresh digest, requestId and separate consent. Raw text is not stored in history/audit.
- Selected registered isolated workspace is validated for read-only access, not granted writes. Fresh ephemeral session, ChatGPT account check, effective readOnly/networkfalse/untrusted/user policy check and disabled MCP inventory, restricted CLI flags unchanged. One turn/60s plus bounded shutdown; no model/account installation or API-key fallback.
- Stable structured output contains schema_version,title,goal,requirements,constraints,open_questions,decisions only. Model cannot assert source/approval/IDs. Max final64k chars/256KiB; validate with canonical parser and export privacy checks before exposing/persisting any proposal. Add server attribution in_app_agent/codex after validation. No raw deltas/reasoning/errors retained. Incomplete but structurally valid drafts may be proposed; normal approval gates apply later.
- Read-only sandbox still permits native reads; stable schema has no universal tools:[] switch. Restricted CLI flags/MCP isolation/approval denial and tool-event failure reduce capability but do not claim gateway control over native context loading, retention or provider transport. UI states this limitation explicitly.
- Final output must belong to acknowledged thread/turn and completed agentMessage (phase final_answer; missing/null phase is rejected). Commentary/partial answers are not proposals; conflicting final messages, tools, approvals, malformed output, timeout or unconfirmed process closure fail closed. Interrupt uses owned IDs and process close evidence. No automatic retry/resume.
- SQLite history contains IDs/digests/lifecycle and validated draft only. On restart, running becomes lost/quarantined until explicit stopped attestation. Bound history100/project and16MiB. No auto draft save, approval, Task or Run.
- Explicit save creates a new lineage through Studio using deterministic server receipt `planning-${record.id}`. Repeat save returns the same draft even after response loss/restart. Acknowledge saved version in history; no replacement of existing plans. Safe retry after a crash between Studio creation and history update uses its receipt.
- All model/Run/review/extension/workflow/verification/merge/start/switch operations respect planning busy and per-workspace recovery guards. Polling reads metadata only; uncertain mutation responses require explicit refresh before another start. UI scope changes dispose late requests and clear consent. Saving a proposal adds it to the editor's version list without discarding existing edits.
- Actual native model invocation remains untested unless separately authorized as a live smoke. Fixture tests/Chrome do not claim live success. Windows/full automated gate remains separate.

## Work units

- [x] Root input/output contract: shared/planning-agent.ts; server/planning/agent-input.ts and tests/planning-agent-input.test.ts. TDD bounds/privacy, exact schema/no authority, safe normalized output and source attribution.
- [x] Native protocol worker: server/codex-planning.ts and tests/codex-planning.test.ts. Reuse Rpc restricted factory and small existing helpers if justified; preserve native review behavior. Test ordering/early/foreign/final phase/tool/approval/MCP/timeout/interrupt/close proof and raw-data absence.
- [x] Root service/integration: server/planning-agent-service.ts, Controller/HTTP/Snapshot/registry wiring and tests. Preview/start/receipt/explicit-save/current workspace/quotas/restart/quarantine/no raw audit, mutual exclusion and exact session/CSRF routes.
- [x] UI worker: web/planning/PlanningAgent.tsx plus tests/planning-agent-ui.test.ts and scoped CSS. User request→preview→consent→proposal→explicit new-draft save; history/interrupt/recovery/manual refresh, scope epochs/uncertain response guards. Root embeds into PlanningStudio and passes live workspace/status.
- [x] Frozen targeted/full/type/build, independent review, dedicated Chrome fixture including restart and no AI calls. Master evidence updated; verified local commit follows. Continue remaining Goal.

## Review focus

1. Foreign/early/final-phase events cannot become a trusted proposal; raw invalid model text never reaches history/UI.
2. Privacy checks inspect decoded input/output values and every decision field; masking must not silently alter an approved proposal.
3. Lost response/restart save or launch must not duplicate model calls or drafts; unknown process termination keeps quarantine.
4. Workspace/project/consent changes invalidate pending UI actions and server preview; no permission comes from source metadata.
5. Existing native review, coding and manual planning remain available under their original guards; no unrelated automatic calls.

## Frozen interface routes

Shared contracts: `shared/planning-agent.ts`. Base `/api/projects/:projectId/planning-suggestions`. GET base with exact `?workspaceId=...` returns PlanningAgentView; POST `/preview` body `{workspaceId,text}` returns PlanningAgentPreview; POST `/start` StartPlanningSuggestionInput returns PlanningSuggestion. POST `/:id/interrupt` body `{workspaceId}`, `/recover` body `{workspaceId,suggestionId,confirmedStopped}`, `/:id/save` body `{workspaceId,expectedOutputDigest}`. Save returns PlanningVersion; repeat save is server-receipted. Every mutation uses session/Origin/CSRF and exact query/body checks.

`server/planning/agent-input.ts`: `planningOutputSchema` immutable server schema, `buildPlanningPrompt(text:unknown):{instructions:string,inputDigest:string}`, `parsePlanningProposal(text:unknown):PlanningDraft`. Native `runCodexPlanning({workspacePath,instructions,timeoutMs,signal?,onStarted?},factory)` returns `{execution,threadId,turnId,proposal:PlanningDraft|null,issue,processStopped}`. Native runner output execution excludes running. Root owns input/output module.
