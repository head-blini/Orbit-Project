# Visualization integration contract

Current implementation contract (2026-10-26). Studio and timeline are mounted in the product; SQLite Artifact history, authenticated HTTP save/history/export, and actual editable PPTX/Markdown downloads are connected. Task22 adds sequence diagrams. Verification evidence and remaining product gaps belong in `ORBIT-MASTER-RESULTS.md`; this contract is not a claim that unrun checks passed.

## Inert diagram inputs

`ArtifactInput` / `ArtifactRecord` are defined in `shared/parallel.ts`. Artifact kinds remain `mermaid`, `architecture`, and `presentation`. All stored source is capped at 256 KiB UTF-8. No Mermaid runtime, raw markup, network renderer, scripts, links or arbitrary SVG paths execute.

- `parseMermaid(source)` preserves its original flowchart-only return `{nodes,edges,direction}` and throws `INVALID_MERMAID` on invalid input.
- `parseMermaidDocument(source)` adds dispatch: `{kind:'flowchart',graph}` or the `SequenceDiagram` contract from `shared/sequence.ts`.
- `validateMermaid(source)` validates either supported grammar and returns `{ok,issues:[{code,line?}]}`.
- `validateArchitecture(unknown)` validates exact node/edge fields, identifiers, references, unique nodes and text safety. Limits: 100 nodes, 300 edges, nonblank labels/kinds at most 160 UTF-16 units.
- `generateArchitectureMermaid(graph)` remaps IDs to `n0`, `n1`, etc. and preserves labels/edges. Architecture kinds remain in JSON/presentation data.

### Flowcharts

Supported headers: `flowchart TD` / `flowchart LR`; explicit nodes `name["Plain text"]`; edges `name --> other` / `name -->|Plain text| other`. Each statement occupies one line. Blank lines and CRLF are accepted. IDs follow `[A-Za-z][A-Za-z0-9_]{0,63}`; node IDs `end` and `subgraph` are rejected.

Both directions retain the existing four-column preview layout. Dense edge crossings and long preview label truncation remain legacy limitations; original source and editable presentation text are preserved.

### Sequences

Header: `sequenceDiagram`. Explicit ordered `participant` / `actor` declarations with optional `as` aliases precede events. Supported statements:

- `A->>B: Message`, `B-->>A: Reply`, including self calls.
- `Note left of A: Text`, `Note right of A: Text`, `Note over A,B: Text` (one or two participants for `over`).
- Bare `autonumber` before events; numbers only messages.
- `activate A` / `deactivate A`, including stacking; `A->>+B` activates recipient B after the message, `B-->>-A` deactivates sender B after the message.
- Nested `alt` / `else` / `end`, `opt` / `end`, `loop` / `end`, `par` / `and` / `end`. Fragment starts require labels; branch labels may be empty.

References must exist. Fragment stacks match; activation stacks balance globally in linear source order. Parallel operands have explicit labels; their vertical placement is source presentation, not an execution schedule. Other Mermaid features remain unsupported.

Limits: 10 participants, 120 normalized events (shorthand adds an activation event), 24 notes, 16 fragments, nesting/activation depth 4, 1,024 source lines, 160 Unicode code points per label, 32 fixed diagnostics. Labels additionally reject semicolons/comments, markup, URLs, encoded syntax, XML-invalid characters and controls. The typed AST independently validates exact fields, dense arrays, references, stack semantics and budgets.

`layoutSequence(diagram)` produces one deterministic `SequencePresentationDocument` for both SVG and PPTX. Text wraps without truncation; long diagrams paginate with repeated participant headers and continuing fragment/activation context. Pages have natural scrollable dimensions. Grammar-valid sources can still exceed geometry/page/byte budgets: `SEQUENCE_LAYOUT_LIMIT` prevents preview export and server persistence before any partial result is saved.

## Presentation and real file output

`toPresentationDocument(graph)` retains the legacy single-slide model: editable `shape`, `text`, and endpoint-linked `connector` elements. `validatePresentationDocument` preserves its 800-element / 256 KiB / 160 UTF-16 text contract. `serializePresentation` produces an actual deterministic PPTX ZIP with DrawingML, internal relationships, editable text/shapes/connectors and no raster images, external relationships or macros. Legacy diagrams retain 16:9 scaling.

The additive `format:'sequence-v1'` model uses native point coordinates with `box` (rect/ellipse), `line` (fixed solid/dash stroke and none/triangle arrow), and `label` primitives. Element order is retained. Every page shares dimensions; minimum 72 points per axis meets OOXML slide-size bounds, maximum 3600×1200 points. Positive boxes/segments have at least a one-point extent. Label font size is 17–48 points; wrapped labels allow 512 UTF-16 units. Limits: 32 pages, 800 elements/page, 8000 total elements, 1 MiB generated JSON. These generated limits do not increase the stored-source budget. SVG and PPTX consume the same page geometry.

## Studio and persistence

`VisualizationStudio` receives project-bound latest records and callbacks:

- `onSave({id?,expectedRevision?,kind,source,metadata})` creates or revises using optimistic concurrency.
- `onHistory(id)` retrieves immutable revisions in ascending order.
- `onExportArtifact(record,'pptx'|'markdown')` downloads the exact selected saved revision. Dirty source must be saved first.
- Optional `onExportPresentation(document)` supports an embedding host's exporter and accepts legacy or sequence presentation documents.

Editor state is keyed by project; foreign records are filtered. The sequence sample is a local editable example, never an agent invocation. Source remains exact; a new-Artifact action detaches history while retaining source. Errors use fixed diagnostics or generic messages.

`SqliteArtifactRepository` is the product repository; `ArtifactRepository` is the memory implementation. UUIDs, hashes, revision numbers and timestamps are server assigned. SHA-256 covers exact original UTF-8 source bytes, including whitespace. Kind is immutable within an Artifact. Metadata permits 32 entries, keys up to 64 and values up to 1000 UTF-16 units. Input validation and sequence layout execute before persistence. SQLite mutations share the Studio transaction, audit event and idempotency receipt.

HTTP retains session/origin/CSRF checks, registered project ownership, quotas, exact request fields and expected revisions. Historical export requires the requested revision/hash, rechecks stored record identity and recomputes the source hash, then revalidates input. Corruption returns `ARTIFACT_INTEGRITY` (409); no bytes are returned. Markdown contains exact source inside a safe-length fence. There is no arbitrary output path, file read or provider call in export.

## Timeline and reload lifecycle

`buildTimeline(snapshot, events)` reads existing `Snapshot`/`AppEvent` types without mutation. Its result contains `lastSeq,items` plus `workspaceKey` and nullable `reload:{reason,after}`. Reasons: `gap`, `conflicting_sequence`, `workspace_changed`. Events are sorted/deduplicated; the cursor advances over irrelevant global/foreign events but stops before uncertainty. Conflicting duplicate payloads conservatively require a reload. Unknown kinds receive a neutral label and raw payloads are not displayed. `run.completed` never implies verification.

**Keep an authoritative snapshot anchor:** pass the snapshot obtained at bootstrap/reload plus events strictly after that snapshot's cursor. Do not pass the existing app's continuously incremented `snapshot.lastSeq` alongside accumulated events: covered events are intentionally skipped. Keep current run state separately for `RunTimeline.snapshot` if desired. On authoritative reload, replace the anchor and clear/rebase the replay list. Bound the replay buffer at the host and reload periodically.

`RunTimeline` takes the computed view, a current snapshot, optional `WorkspaceDiff`, and required `onReload({workspaceKey, after, reason}): Promise<void>`. Supply snapshot/view for the same workspace session. The hook requests reload once per unchanged reload key, cleans up queued requests, ignores obsolete failures, and allows an explicit retry. The host must fetch through existing endpoints, update the anchor/current snapshot/replay state, and ignore responses from a superseded workspace session. It must also handle network reconnect by authoritative reload; no transport/reconnect subscription is created here. Already dispatched host work cannot be aborted by this component. Workspace identity changes remount timeline state; diffs from another workspace are omitted. Diff text is escaped; it is not a file reader.

## Verification and remaining scope

Run `npm run verify` with Node 24. Focused sequence parser/layout/PPTX/Studio tests supplement existing malicious-input, project-isolation, immutable revision, rollback and legacy export coverage. Actual browser and PPTX import/render checks are recorded separately with their real results.

C4, other UML forms and PDF export remain separate incomplete requirements. Supporting this inert subset does not imply support for full Mermaid syntax or the Mermaid layout engine. PowerPoint/Google Slides manual round-trip evidence must be reported separately from package inspection and the bundled importer.
