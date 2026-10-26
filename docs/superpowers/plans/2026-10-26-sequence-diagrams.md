# Task22 — Inert sequence diagrams with editable export

Status: implemented and verified locally; see Task22 final evidence in `docs/ORBIT-MASTER-RESULTS.md`. Task21 is preserved in verified local commit `ff99b88`.

## Scope and decisions

Implement a useful bounded Mermaid sequence subset through the existing Artifact lifecycle: source validation, preview, immutable revisions, historical Markdown and real editable PPTX. Preserve legacy flowchart parse results, source hashes, project isolation and approval boundaries. No new package, external renderer, native AI execution or network service is needed.

Accepted grammar: explicit ordered participant/actor declarations; optional bare autonumber; solid `->>` and dashed `-->>` messages including self calls; left/right/over notes; stacked activate/deactivate and arrow suffix shorthand; nested alt/else, opt, loop and par/and fragments. Activation follows linear source order and must balance globally. Reject other Mermaid syntax, directives, HTML, links, encoded markup and unsafe labels. Parser limits are exported from `shared/sequence.ts`: 10 participants, 120 normalized events, 24 notes, 16 fragments, nesting/activation depth 4, 1024 lines, 160 code points per text, 32 diagnostics and 256 KiB source.

Add `parseMermaidDocument` dispatch while preserving `parseMermaid`'s legacy flowchart return. Validate the typed AST before layout as well as source at persistence. The existing artifact kind remains `mermaid`.

One deterministic pure layout produces fixed box/line/label primitives for SVG and PPTX. Text wraps without truncation. Pagination repeats participant headers, lifelines, active activations and open fragment context. Event rows are indivisible; multi-page fragments have explicit continuation labels. Preview pages retain natural dimensions in a scroll region. Parallel operands retain `par`/`and` labels; vertical placement is source presentation, not a scheduling claim. Grammar validation and layout budgets are separate: Studio and server persistence run layout before accepting a sequence Artifact; `SEQUENCE_LAYOUT_LIMIT` rejects pathological content rather than saving an unrenderable or partial result. Export rechecks stored source hash, identity and input validation.

Sequence exports use the additive `format:'sequence-v1'` presentation contract, fixed native point coordinates and the same dimensions across all pages. Legacy presentation JSON remains one slide with its original 16:9 scaling. New documents permit up to 32 pages / 800 primitives per page / 8000 total / 1 MiB, dimensions at most 3600×1200 points. Plain line segments, rectangles/ellipses and individual text boxes remain editable. No rasterized diagrams, external relations, scripts or arbitrary SVG paths. Saved source remains capped at 256 KiB.

## Ownership and execution

1. Root owns shared types, presentation validation/serialization, Studio/server dispatch, integration tests, browser/artifact evidence and documentation.
2. Parser agent owns `web/visualization/sequence.ts`, Mermaid dispatch and focused parser tests. TDD with malicious inputs, reference validation, stack balancing, limits and legacy regression.
3. Layout/UI agent owns `sequence-layout.ts`, `SequencePreview.tsx`, focused geometry/SSR tests. TDD with pagination, long Unicode labels, actors, notes, self calls, activations and nested fragments.
4. Independent review checks acceptance/security, geometry and persistence/export boundaries. Fix actionable findings and repeat relevant checks.

## Validation and completion evidence

- Observe RED then GREEN for each unit. Run typecheck, full tests and build with local Node 24.
- Validate real PPTX ZIP/XML, page relationships, editable primitives, original text, safe package parts and deterministic output. Import/render representative exported pages using bundled presentation tooling where supported; record any importer limitations accurately.
- Actual local browser: sequence preview, save/revise/history, project isolation, saved-version PPTX/Markdown download, refresh and server restart. Use temporary DB/repos and no actual provider call.
- Record evidence, limitations and remaining C4/UML/PDF work in MASTER-PLAN/MASTER-RESULTS. Create verified local commit; no push/deploy or overall-goal completion.
