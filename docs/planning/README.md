# Planning Studio

This isolated module supports planning with zero providers. It does not connect to ChatGPT, call a model, create a Run, or grant coding permissions. The product integrates immutable SQLite storage, authenticated HTTP routes and the main Planning screen. InMemoryPlanningRepository remains available for isolated tests.

## Entry points

- `server/planning/index.ts`: `parsePlanningDraft`, `approvalIssues`, `serializePlanningDraft`, `InMemoryPlanningRepository`, `PlanningRepository`, `PlanningError`, `toTaskDrafts`.
- `web/planning/index.tsx`: `PlanningStudio`, `PlanningPreview`, `PlanningStudioProps`. Styles are scoped to `.planning-studio` and `.planning-preview`.
- Planning domain types are imported from integration-owned `shared/parallel.ts`. The shared contract is present; no private duplicate is used.

## Input grammar

Both formats have a 262,144-byte (256 KiB) UTF-8 limit. The parser returns field/code diagnostics without echoing rejected content. Input is always text: HTML, Markdown links and shell-like strings do not run and are not fetched. Preview and task output use escaped React text nodes, not a Markdown/HTML renderer.

JSON uses the canonical `schema_version: "1.0"` schema in `docs/07-PROVIDER-NEUTRAL-CORE.md`. `requirements[].id` maps to `label`, `acceptance_criteria` to `acceptanceCriteria`, and `open_questions` to `openQuestions`. See `tests/fixtures/planning/valid.json`.

- Required structural keys: `schema_version`, `title`, `goal`, `requirements`, `constraints`, `open_questions`.
- `decisions` is optional, with at most100 objects containing exactly string `topic`, `decision`, `rationale`. Blank fields save as incomplete drafts but prevent approval. Empty decisions normalize to absence for legacy hash compatibility.
- Optional `source` metadata accepts `kind` (1–64 characters), `provider_id` (null/string up to128), `external_url` (null/HTTP(S) URL up to2048), `author` (up to200), and `references` (up to50 objects with `title` up to200 and `url` up to2048). URLs require a host and reject userinfo, backslashes, whitespace and controls; they are never requested or rendered as active links. Metadata is user-supplied attribution, never authority. The input envelope's `source: manual|import` remains separate. Both legacy default kinds `in_app_manual`/`file` with null provider/url and no author/references normalize to absence, preserving legacy cross-source reimport shapes.
- Unknown keys, including approval/state/ID/hash/revision fields, are rejected. Old schema `0.2` is rejected, not migrated implicitly.
- Requirement labels must be unique, use ASCII letters/digits/underscore/hyphen, start with a letter or digit, and be 1–64 characters.

Markdown uses this deliberately narrow grammar, illustrated in `tests/fixtures/planning/valid.md`:

```markdown
# Title
## Goal
Goal text (multiple lines allowed).
## Requirements
### REQ-01
Requirement description (multiple lines allowed).
#### Acceptance criteria
- First check
- Second check
## Constraints
- A constraint
## Open questions
- A question
## Decisions
### Storage
#### Decision
Use SQLite.
#### Rationale
Offline operation.
```

Korean headings `목표`, `요구사항`, `인수 조건`, `제약`, `질문`, decision section `결정사항`/`결정 사항`/`결정`, and decision fields `결정`/`근거`/`이유` are also accepted. Section headings may occur once; requirements may repeat with distinct labels. Lists accept `- ` or `* `. Unknown/duplicate headings, unsupported nesting and text outside the documented sections are rejected. This is not a general-purpose Markdown parser. Heading-looking lines in descriptions need to be written as plain text without a Markdown heading prefix. Empty documents and missing sections are valid incomplete drafts.

Saving permits structurally valid incomplete drafts. Approval requires a nonempty title and goal, at least one requirement, and nonempty descriptions and acceptance criteria for every requirement. Every supplied decision also requires nonempty topic, decision and rationale. Source metadata cannot supply approval.

## Repository behavior

`InMemoryPlanningRepository` implements the `PlanningRepository` interface. All methods are synchronous; the UI callbacks are asynchronous so an HTTP adapter can be injected.

```ts
const repository = new InMemoryPlanningRepository();
const version = repository.create(projectId, { format: 'markdown', text, source: 'manual' });
const approved = repository.approve(projectId, version.id, version.revision);
const tasks = repository.toTasks(projectId, approved.id);
```

IDs, content hashes, revision numbers and state are server-generated. The SHA-256 hashes the canonical normalized draft, including normalized provenance. Each `create` starts an independent lineage at revision 1. `revise` creates a new ID and advances that lineage's revision. It must name the current head with the exact expected revision; stale requests fail with `REVISION_CONFLICT`. Invalid input cannot partially supersede a version. Approval is idempotent for the current version and exact revision.

Previously approved versions remain approved history and can still produce task drafts for that exact version. A newer draft never inherits approval. Previous unapproved drafts become `superseded`. Superseded/historical versions cannot be approved or revised; choose the current head. Approval changes state without changing content revision or hash. This follows the fixed contract: revision is a content revision, not a separate approval-event counter.

Returns are deep copies. `toTaskDrafts` additionally requires a genuine unchanged snapshot issued by this module; it derives state and task content from a separate private copy. Copies deserialized from browser JSON, forged approvals, changed objects and serialization hooks cannot become authority. HTTP handlers must call `repository.toTasks(projectId, versionId)` and never accept a browser version object for conversion.

The repository retains original input privately. PlanningVersion exposes lineage and creation/approval metadata; Studio uses SQLite transactions, mutation receipts, metadata-only audit events and per-project storage quotas. Original input is not exposed by the normal read/export routes. Project IDs are opaque 1–128-character ASCII identifiers (letters/digits, underscore, hyphen; first character alphanumeric), never filesystem paths. Project existence and session access belong to the integration layer.

Each requirement produces one `TaskDraft`; the result copies acceptance criteria and links the exact planning version and requirement label. It does not persist tasks or start runs. Constraints, decisions and questions stay on the linked plan. Execution includes approved decisions and constraints, rejects unresolved questions/incomplete decisions and enforces its existing4000-character prompt limit. Attribution is excluded from execution prompts. Comparison displays decisions/provenance changes; only decisions affect all previous tasks.

## UI behavior and checks

The editor supports manual input, file import, preview, saved-version selection, new revisions, approval and task draft display. Editing disables approval/task conversion until the change has been saved. Selection is disabled with unsaved edits; the explicit discard button starts a new plan. Mutation callbacks send IDs and expected revision, not browser approval state. Initial loading and operations disable controls. Changing projects remounts the editor and discards late results from the old project. Errors do not display raw server exception text.

Checks:

```text
node --test tests/planning.test.ts
node tests/fixtures/planning/verify-ui.mjs
node tests/fixtures/planning/verify-bundle.mjs
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

The focused UI smoke transforms the TSX and renders real React components on the server, including hostile text escaping. It does not exercise browser interaction, CSS layout, file selection or asynchronous callback races. The product build includes the integrated Planning screen. See the results report for actual exit codes and blockers.
