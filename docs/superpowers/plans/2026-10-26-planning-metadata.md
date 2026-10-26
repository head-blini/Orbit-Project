# Planning decisions and source metadata implementation plan

> **For agentic workers:** Use superpowers:executing-plans for the assigned bounded work. Root owns shared contracts, Studio/HTTP and integration.

**Goal:** Preserve architecture decisions and user-supplied source metadata across import, version storage, preview, comparison, export and execution briefs.

**Architecture:** Extend the existing v1 normalized draft with optional decisions/provenance. Preserve legacy stored shapes and hashes without a migration; empty decisions and default source metadata normalize to absence. Reuse the existing parser, immutable versions, export inspection and comparison panel. No dependencies or remote lookup.

**Tech Stack:** TypeScript, React, Node24, SQLite.

**Spec:** ORBIT-GOAL B; 06-CHATGPT-PLANNING-BRIDGE sections2–4; 07-PROVIDER-NEUTRAL-CORE v1. Existing user authorization covers autonomous implementation, tests and bounded parallel work.

## Decisions and constraints

- Keep schema1.0 and existing `source: manual|import`. Optional `decisions: {topic,decision,rationale}[]` (max100); missing/empty is omitted. Incomplete decision text can save, but all three fields must be nonblank for approval. Markdown supports `## Decisions`, `### topic`, `#### Decision`, `#### Rationale` (Korean aliases too).
- Optional `provenance: {kind,providerId,externalUrl,author?,references?:{title,url}[]}` maps canonical JSON `source` snake_case provider/url and author/references. Max kind64/provider128/author200/url2048/reference-title200, references50. URLs are HTTP(S) with host and without userinfo, stored as inert text; nothing fetches or opens them automatically. Unknown keys/types/authority are rejected. Either legacy default kind in_app_manual/file with null provider/url and no author/references normalizes to absence regardless input source, preserving legacy cross-source reimport shapes.
- Provenance is user-supplied attribution, never verified identity or approval. Metadata-only changes appear in diff but do not affect task execution. Decisions change plan context for all base tasks and are included in the bounded execution prompt. Provenance is omitted from execution prompts to avoid sending incidental attribution.
- JSON preserves every supported field; Markdown uses existing lossless JSON envelope when ordinary Markdown cannot round-trip. Export inspection includes every new decoded string, including URLs. Original import remains private under existing repository behavior.
- No DB migration, legacy hash rewrite, auto-approval, agent run, link fetch, credentials or real-user data access. No push/deploy.

## Work units

- [x] Root: extend shared contracts; add execution/comparison regressions before implementation. Consume `normalizeStoredPlanningDraft`, include validated decisions in execution, compare decisions/provenance as display strings; decisions affect all tasks. Tests preserve old hashes and reject tampering/oversized prompts.
- [x] Parser/export worker: failing preservation, malformed metadata, incomplete approval, Markdown decisions, legacy shape, inert URL, export sensitive-field tests; implement `parser.ts`/`export.ts`. Own corresponding tests only. Check targeted parser/export tests.
- [x] UI worker: failing actual preview/compare SSR tests; render decisions and user-supplied attribution as escaped text with no anchors or auto calls. Add starter/help and comparison titles. Own PlanningStudio/PlanningComparison and new metadata UI test only.
- [x] Root integration: real Studio SQLite save→approve→task→brief→revise→diff→export→restart preservation test, no run/audit text leakage; focused/full/type/build. Independent review and dedicated disposable Chrome check. Record failures and limitations in MASTER documents, then verified local commit.

## Review focus

1. Legacy records have no new fields: exact shape/hash remains valid after restart and canonical re-export.
2. New metadata/decisions must not disappear from export or bypass decoded-string privacy inspection.
3. Source claims and hostile HTML/URL strings are data; no permission, provider connection or browser navigation.
4. Changed decisions invalidate content hashes/previews and mark task context; attribution-only changes do not expand agent prompts.
5. Incomplete decisions save but cannot approve; malformed nested objects reject with fixed diagnostics and no source content.

## Evidence

- Root execution/comparison RED29pass/3fail; SQLite2fail unsupported decisions. Parser/export new15 tests3pass/12fail→40/40 focused. UI new5fail→19/19 combined. Privacy guard mutation2expectedfail then restored.
- Frozen full verify `.local/verification/planning-metadata-frozen-verify.log`:540total/539pass/1 Windows-onlyskip/0fail·type/build0,23.2sec. Independent final review no findings. Initial full also539pass/1skip but rerun after worker mutation-check overlap.
- Chrome `.local/ui-e2e/mac-task19-JCR8SF/result.json`: decisions/rationale/source displayed, attribution inert, decision impact→approval→selected follow-up, reload/restart unchanged.3JPEG, actual browser JSON813B exact draft/hash in download-evidence.json. Download event timed out but expected disk file confirmed. HTTP JSON/Markdown metadata preserved. Source/task preserved, noAI/CLI/external,console0,server2exit0,port/tab closed. Dedicated Mac scope; no Windows/full automated gate.
