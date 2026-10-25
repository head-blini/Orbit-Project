# Planning Studio

This isolated module supports planning with zero providers. It does not connect to ChatGPT, call a model, create a Run, or grant coding permissions. Storage is in memory. HTTP, SQLite and the application's main screen are integration work, not implemented here.

## Entry points

- `server/planning/index.ts`: `parsePlanningDraft`, `approvalIssues`, `serializePlanningDraft`, `InMemoryPlanningRepository`, `PlanningRepository`, `PlanningError`, `toTaskDrafts`.
- `web/planning/index.tsx`: `PlanningStudio`, `PlanningPreview`, `PlanningStudioProps`. Styles are scoped to `.planning-studio` and `.planning-preview`.
- Planning domain types are imported from integration-owned `shared/parallel.ts`. That file is missing in this checkout; no duplicate contract was introduced.

## Input grammar

Both formats have a 262,144-byte (256 KiB) UTF-8 limit. The parser returns field/code diagnostics without echoing rejected content. Input is always text: HTML, Markdown links and shell-like strings do not run and are not fetched. Preview and task output use escaped React text nodes, not a Markdown/HTML renderer.

JSON uses the canonical `schema_version: "1.0"` schema in `docs/07-PROVIDER-NEUTRAL-CORE.md`. `requirements[].id` maps to `label`, `acceptance_criteria` to `acceptanceCriteria`, and `open_questions` to `openQuestions`. See `tests/fixtures/planning/valid.json`.

- Required structural keys: `schema_version`, `title`, `goal`, `requirements`, `constraints`, `open_questions`.
- `decisions` may be absent or empty. Nonempty decisions are explicitly rejected with `UNSUPPORTED_DECISIONS` because the mandated shared draft contract has no decision field. This avoids silent data loss; full decision support needs an integration-owned contract extension.
- Optional source metadata accepts `kind`, `provider_id`, `external_url`. It is untrusted provenance, never authority. The parser's explicit `source: 'manual' | 'import'` determines the normalized source; URLs are never requested.
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
```

Korean headings `목표`, `요구사항`, `인수 조건`, `제약`, `질문` are also accepted. Section headings may occur once; requirements may repeat with distinct labels. Lists accept `- ` or `* `. Unknown/duplicate headings, unsupported nesting and text outside the documented sections are rejected. This is not a general-purpose Markdown parser. Heading-looking lines in descriptions need to be written as plain text without a Markdown heading prefix. Empty documents and missing sections are valid incomplete drafts.

Saving permits structurally valid incomplete drafts. Approval requires a nonempty title and goal, at least one requirement, and nonempty descriptions and acceptance criteria for every requirement. Source metadata cannot supply approval.

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

The repository retains original input and generated creation/approval times internally. These are not exposed by the fixed `PlanningVersion` contract. It does not currently expose an audit-history API, persistence, deletion, plan grouping metadata or a configurable retention limit. Project IDs are opaque 1–128-character ASCII identifiers (letters/digits, underscore, hyphen; first character alphanumeric), never filesystem paths. Project existence and session access belong to the integration layer.

Each requirement produces one `TaskDraft`; the result copies acceptance criteria and links the exact planning version and requirement label. It does not persist tasks or start runs. Constraints and questions stay on the linked plan.

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

The focused UI smoke transforms the TSX and renders real React components on the server, including hostile text escaping. It does not exercise browser interaction, CSS layout, file selection or asynchronous callback races. The bundle check separately includes the standalone entrypoint; the default project build does not include it yet. See the results report for actual exit codes and blockers.
