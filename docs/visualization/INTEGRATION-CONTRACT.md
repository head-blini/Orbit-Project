# Visualization integration handoff

Integration update (2026-10-25): the Studio and timeline are mounted; Artifact SQLite/API persistence is connected. The following text is the original module handoff. See [product integration results](../ORBIT-INTEGRATION-RESULTS.md). Actual PPTX export remains unsupported; sandbox product build and browser acceptance remain unverified.

Status: independently implemented modules; not mounted in the application. No shared types, Controller, HTTP, SQLite, package manifests, security core, or other worktrees were changed. No provider or paid API is required.

## Shared contract prerequisite

`shared/parallel.ts` was absent throughout implementation. Its creation and contract tests are explicitly reserved for the integration owner. No replacement named common contracts were created. Public functions currently express structural inputs and inferred return types; local aliases derive from these functions. Integration must supply the common types, bind/check these implementations against them, and run the common contract tests before claiming contract compatibility. This remains a release prerequisite.

## Browser modules

Import `web/visualization/index.tsx` for components and scoped CSS, or `Studio.tsx` for components without styles. Pure helpers are exported from the index and their individual `.ts` modules. Server hashing/repository code is imported by UI only as an erased type reference.

- `generateArchitectureMermaid(graph)` accepts the contracted node/edge shape, validates it, and emits restricted Mermaid. Node identifiers are remapped to `n0`, `n1`, etc. to avoid reserved language tokens; labels and edge topology are preserved. `kind` remains in architecture JSON and presentation shapes, not Mermaid source.
- `validateMermaid(source)` returns `{ok, issues:[{code,line?}]}`. `parseMermaid(source)` returns inert nodes/edges plus direction, or throws `INVALID_MERMAID`.
- `validateArchitecture(unknown)` returns the same validation result shape. It rejects unknown fields, duplicate IDs, unknown endpoints, empty graphs, more than 100 nodes or 300 edges. IDs match `[A-Za-z][A-Za-z0-9_]{0,63}`. Labels/kinds are nonblank, at most 160 UTF-16 code units, and satisfy the text safety filter.
- `toPresentationDocument(graph)` returns one expandable slide with `id`, numeric `width`/`height` and `elements`. Elements are editable `shape` records (`id,x,y,width,height,kind`), `text` records (`id,x,y,width,height,text`), and `connector` records (`id,from,to`, referencing shape IDs). Coordinates use a logical canvas, not PPTX units. Integration must convert units/fit slides.
- `exportPresentation(graph, exporter)` accepts the structural `PptxExporter.export(document): Promise<Uint8Array>` boundary. It validates/converts before invoking the supplied exporter. **편집 가능한 PPTX 생성 기반만 구현 / editable PPTX generation foundation only.** No serializer, ZIP/XML writer, or actual PPTX artifact exists. A future exporter must emit separate editable elements, escape XML, remap element IDs, and validate package structure. Rasterizing the SVG is not an editable export.

## Restricted Mermaid syntax

Input is at most 256 KiB UTF-8. Blank lines and CRLF are accepted. Each statement occupies its own line. Header: `flowchart TD` or `flowchart LR`. Nodes: `name["Plain text"]`. Edges: `name --> other` or `name -->|Plain text| other`. Endpoints must have explicit node declarations. Duplicate node IDs are rejected. Nodes named `end` or `subgraph` are rejected; generated output always uses safe identifiers.

No other Mermaid language is supported: no directives, comments, subgraphs, styles, click handlers, HTML, raw markup, URLs, encoded entities/percent escapes, or arbitrary statements. Labels reject angle brackets, quotes, backslashes, control characters, brackets/braces/pipes/backticks, web URL forms and URI-scheme-like strings (a word directly followed by a colon is conservatively rejected, even when intended as ordinary prose). This is an allowlisted parser, **not validation of the full Mermaid grammar**.

Preview renders validated primitives through React SVG, never `innerHTML`, a Mermaid runtime, or a network renderer. Both accepted directions currently use a documented fixed four-column grid; this is not Mermaid's layout engine. Long labels are visually truncated with full text in SVG titles and preserved in source/presentation text. Dense graphs may have overlapping connectors or labels; no automatic graph-layout engine is included.

## Studio host callbacks

`VisualizationStudio` takes `projectId`, an array of latest server Artifact records, and optional callbacks:

- `onSave({id?, expectedRevision?, kind, source, metadata}) -> Promise<ArtifactRecord>`. Missing ID means create; existing ID means revise using optimistic concurrency. The host binds the project using server context, passes only `kind/source/metadata` into repository input, and refreshes the latest list after success. Do not trust browser project, ID, revision, hash or timestamp as authority. HTTP must retain existing origin/session/CSRF checks.
- `onHistory(id) -> Promise<ArtifactRecord[]>`. Returns revisions in ascending order after checking project access. Selecting an old revision is allowed for inspection; saving it produces a conflict until the latest revision is loaded or a new Artifact is created.
- `onExportPresentation(document) -> Promise<void>`. The host supplies a tested exporter and download delivery. If absent, the export button is disabled and the foundation-only limitation is visible. Supplying this callback is the host's responsibility and is not evidence that a serializer has been verified.

Editor state is keyed by project, foreign project records are filtered, source is preserved exactly, and errors are generic rather than raw server/provider messages. Saving and history actions are unavailable without host callbacks. An explicit new-Artifact action detaches a revision while retaining editor source.

## Artifact server boundary

`server/visualization/artifacts.ts` exports `ArtifactRepository`, an **in-memory implementation only**, with:

```
create(projectId, {kind, source, metadata}) -> record
revise(projectId, id, expectedRevision, {kind, source, metadata}) -> record
list(projectId) -> latest record[]
history(projectId, id) -> all revisions[]
```

Records have the contracted `id,projectId,revision,kind,source,contentHash,createdAt,metadata`. UUIDs/timestamps/SHA-256 and revision numbers are server assigned. SHA-256 covers exact UTF-8 source bytes. Kind cannot change within an Artifact; create a new Artifact to change kind. Return objects and incoming metadata are detached from stored history. Unknown input keys (including paths or forged record authority) are rejected. Project identifiers are bounded identifiers, never filesystem paths. Metadata permits up to 32 entries, keys up to 64 code units and values up to 1000 code units. Source cap: 256 KiB UTF-8. Architecture and presentation JSON are validated before storage.

Errors: `INVALID_PROJECT`, `INVALID_ARTIFACT`, `ARTIFACT_NOT_FOUND`, `REVISION_CONFLICT`, `ARTIFACT_KIND_IMMUTABLE`. The host maps these to safe HTTP statuses. The repository does not authenticate project access; it enforces isolation only within the supplied project scope. There are no filesystem reads/writes and no delete or arbitrary download path operation. Persistence, quotas, migrations, cross-process concurrency, HTTP routes and download APIs remain integration work. SQLite must preserve immutable revisions and transactional expected-revision checking.

## Timeline and reload lifecycle

`buildTimeline(snapshot, events)` reads existing `Snapshot`/`AppEvent` types without mutation. Its result contains `lastSeq,items` plus `workspaceKey` and nullable `reload:{reason,after}`. Reasons: `gap`, `conflicting_sequence`, `workspace_changed`. Events are sorted/deduplicated; the cursor advances over irrelevant global/foreign events but stops before uncertainty. Conflicting duplicate payloads conservatively require a reload. Unknown kinds receive a neutral label and raw payloads are not displayed. `run.completed` never implies verification.

**Keep an authoritative snapshot anchor:** pass the snapshot obtained at bootstrap/reload plus events strictly after that snapshot's cursor. Do not pass the existing app's continuously incremented `snapshot.lastSeq` alongside accumulated events: covered events are intentionally skipped. Keep current run state separately for `RunTimeline.snapshot` if desired. On authoritative reload, replace the anchor and clear/rebase the replay list. Bound the replay buffer at the host and reload periodically.

`RunTimeline` takes the computed view, a current snapshot, optional `WorkspaceDiff`, and required `onReload({workspaceKey, after, reason}): Promise<void>`. Supply snapshot/view for the same workspace session. The hook requests reload once per unchanged reload key, cleans up queued requests, ignores obsolete failures, and allows an explicit retry. The host must fetch through existing endpoints, update the anchor/current snapshot/replay state, and ignore responses from a superseded workspace session. It must also handle network reconnect by authoritative reload; no transport/reconnect subscription is created here. Already dispatched host work cannot be aborted by this component. Workspace identity changes remount timeline state; diffs from another workspace are omitted. Diff text is escaped; it is not a file reader.

## Required integration verification

Run `npm.cmd run verify` and `node tests/fixtures/visualization/verify-ui-build.mjs` in an environment where esbuild may resolve the existing workspace. Both bundle attempts are currently blocked by sandbox ancestor-directory access. Typecheck, pure behavior tests and JSX-to-SSR checks run successfully; browser mounting/interactions and screenshot inspection remain unverified. Validate mounted save/history/reload/export flows, stale async responses across workspace changes, shared contract compatibility, persistent history, download delivery, and actual PPTX editability after those integrations exist.
