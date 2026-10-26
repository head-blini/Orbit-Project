# Task24 — UML class diagrams implementation plan

> **For agentic workers:** Use superpowers:executing-plans for assigned files; independent parser and layout owners collaborate under root integration. Track checkable steps below.

**Goal:** Author, preview, version and export a bounded, inert Mermaid class diagram with readable class compartments and explicit UML relationships.

**Architecture:** Extend the existing Mermaid document dispatcher while preserving `parseMermaid`'s flowchart return value. Reuse Artifact persistence and fixed SVG/PPTX primitives. Class layout emits native boxes, labels and line segments; only fixed diamond geometry and a foreground fill are added to the common canvas vocabulary.

**Tech Stack:** Existing TypeScript, React, Node24, SQLite and native DrawingML serializer; no new package, renderer or model call.

**Spec:** ORBIT-GOAL E; [official Mermaid class grammar](https://mermaid.js.org/syntax/classDiagram.html); existing visualization integration contract. The user's autonomous whole-goal instruction covers routine design and execution choices. Task23 is preserved in verified local commit `cd149e0`.

## Design decisions and scope

- A full Mermaid runtime would add executable syntax and a dependency; a separate JSON class format would duplicate the existing Mermaid authoring path. Extend the current inert subset and disclose its limits.
- Header `classDiagram`. Explicit declarations precede relationships: `class Id`, `class Id["Display name"]`, or either with `{` followed by one member per line and a closing `}`. Optional body annotation is exactly `<<interface>>`, `<<abstract>>` or `<<enumeration>>`. No implicit class creation, duplicate declarations or later patch definitions.
- Members are display text classified by a valid single pair of method parentheses. Optional `+ - # ~` visibility is preserved. Attribute/member type colons and commas are ordinary text, not executable syntax. Static/abstract member suffixes, generics, namespace, note, direction, styles, callbacks, links, directives and comments are unsupported. Conventional URLs and executable URI schemes are rejected; other member colons are inert type notation and never become links. Reject unsafe control/invalid Unicode/HTML/URL syntax before trimming can hide it; preserve ordinary Korean, combining marks and ZWJ/ZWNJ.
- Relationships support inheritance, composition, aggregation, directed association, dependency, realization, plain solid link and plain dashed link, including their reverse single-marker forms. Optional endpoint multiplicities and a label are preserved. Self relationships and two-headed markers are unsupported. Endpoints must have been declared; exact duplicate semantic relations are rejected.
- Source limit256KiB UTF-8/1024lines;1–10classes,16members per class/80total,20relationships,64ASCII ID characters,80Unicode codepoints per class display name,160per member/relationship label,32diagnostics. Multiplicity is `*`, a canonical integer0–999 or ascending numeric-to-numeric/star range; no leading zeros or free text.
- Typed model in `shared/uml-class.ts`: `ClassDiagram {kind:'class',classes:ClassNode[],relationships:ClassRelationship[]}`; node `{id,name,annotation,attributes:string[],operations:string[]}`; relation `{id,kind,from,to,fromMultiplicity:string|null,toMultiplicity:string|null,label:string|null}`. Normalize inheritance/realization from child to parent, aggregation/composition from whole to part, directed association/dependency from source to target. Plain links keep declaration orientation but equivalent reversed duplicates are rejected.
- Geometry: one complete overview within3600×1200points. Cards retain name/annotation and distinct attributes/operations compartments. Text wraps by grapheme without truncation. Fixed relationship lanes below the cards avoid arbitrary path search; unique ports and unobstructed label slots are required. Unsupported density returns `CLASS_LAYOUT_LIMIT` before preview/export/persistence. Crossings are explicitly non-junctions. This authored model does not verify source code, runtime types or semantic correctness of a design.
- Relation markers use only fixed primitives: open V lines for association/dependency, hollow triangles for inheritance/realization, hollow diamond lines for aggregation and a filled native diamond box for composition. No arbitrary SVG/path field or new executable input surface. Existing sequence/C4 bytes must stay unchanged.

## Global constraints

- Preserve project ownership, exact source/hash/version, immutable kind, session/Origin/CSRF, rollback/receipt and source freshness boundaries.
- Root owns shared contracts, common renderer, Studio/HTTP/persistence and documentation. Agents edit only assigned modules/tests.
- Use disposable repositories/DB and loopback for browser checks. No credentials, provider calls, remote push or deployment.
- A local vertical slice is not completion of the whole platform. PDF, other UML forms, Windows final gate and real application validation remain separately reported.

## Implementation tasks

### 1. Common primitives — root

Files: `shared/canvas.ts`, `web/visualization/presentation.ts`, `FixedCanvasPreview.tsx`, `server/visualization/pptx.ts`, canvas tests.

- [x] Add failing tests for fixed diamond and foreground fill; verified2RED.
- [x] Add `geometry:'diamond'` and `fill:'ink'` with SVG polygon/native DrawingML equivalence and strict enum validation.
- [x] Focused canvas/sequence/PPTX34pass/exit0; all4Task22/23 final files regenerated byte-for-byte identical. Evidence `.local/verification/class-canvas-{red,green}.log` and `class-legacy-file-checks.json`.

### 2. Inert class parser — parser agent

Files: `web/visualization/uml-class.ts`, `tests/uml-class-validation.test.ts`. Root creates shared types.

Interfaces: `parseClassDiagram(source:string):ClassDiagram`, `validateClassDiagram(source:string):{ok:boolean;issues:{code:string;line?:number}[]}`, `validateClassModel(value:unknown):boolean`.

- [x] RED tests for declarations/members/annotations/eight relation kinds/reversal/multiplicity and ordinary typed member colons.
- [x] Implement exact bounded source and object validation; `parseClassDiagram` throws only `INVALID_CLASS_DIAGRAM` for invalid inputs.
- [x] GREEN tests for malformed Unicode/control text, accessors/prototypes/sparse arrays, unsupported syntax, unknown refs/duplicates/self edges and all limits.

### 3. Complete class layout — layout agent

Files: `web/visualization/uml-class-layout.ts`, `ClassDiagramPreview.tsx`, `tests/uml-class-layout-ui.test.ts`.

Interfaces: `layoutClassDiagram(diagram:ClassDiagram):CanvasPresentationDocument`; preview props `{diagram:ClassDiagram}` using `FixedCanvasPreview`.

- [x] RED tests for full compartments/Unicode, deterministic bounds, all marker directions and endpoint multiplicities, dense/overflow rejection.
- [x] Implement fixed lanes/ports and label placement with no shared collinear relation segments, no lines through cards or labels, no hidden data and no unbounded search.
- [x] GREEN geometry/SSR checks, including ordinary4–6class examples and explicit complexity limits.

### 4. Product integration and evidence — root

Files: Mermaid dispatcher, Studio, index, server artifacts/Studio export, HTTP/UI tests and integration documentation.

- [x] RED tests for class save/export/history, unsupported input and layout rejection before writes.
- [x] Wire dispatcher, examples, visible limits, preview and actual native PPTX/MD export; preserve exact raw source and existing grammars.
- [x] Independent review, fixes and full Node24 typecheck/tests/build.
- [x] Actual PPTX package/import/render/visual/edit round trip and Chrome save/revise/history/isolation/download/restart/invalid input checks; verify owned cleanup.
- [ ] Update MASTER documents with exact failures/limits and make a verified local commit. Continue the next incomplete requirement.

## Review focus

1. Arrow reversal and composition owner markers/multiplicities must remain at their semantic endpoints in both SVG and PPTX.
2. Typed member text such as `name: string` must not be mistaken for a URL; actual unsafe syntax cannot enter as a member.
3. Long/grapheme-heavy names and members must fit completely or reject before records/events/receipts are created.
4. Multiple relations and multiplicity labels must not overlap or hide a relation direction; crossings must not imply a junction.
5. Historical export, source integrity, project isolation and legacy sequence/C4 file bytes remain unchanged.

## In-progress evidence

- Parser API stub13RED→19GREEN; parser+legacy sequence/flowchart/C4 focused84pass; targeted strict typecheck exit0.
- Root class HTTP2RED and Studio UI1RED → combined parser/layout/HTTP/UI47pass. Full typecheck and build exit0.
- First real6class/8relationship sample:2388×948points,95elements; native PPTX65962bytes, structural/layout findings0, bundled import/render and separate-copy text edit round trip passed. Visual inspection found unnecessarily split short ASCII member names; layout owner is correcting wrapping before final artifacts/full gate.

- Independent parser review found two ordinary-member false rejections: command-like names (`link`, `style`, `direction`, `callback`) and URI-like typed names (`data`, `file`). Each had RED→GREEN source/direct-AST regressions. General labels/URI restrictions stay strict; unambiguous data/file member fields and fully typed parameters have a narrow identifier/array type exception. Parser23GREEN, parser+legacy88pass, targeted strict tsc0.
- Layout final14GREEN and C4/sequence combined40pass, targeted strict tsc0. ASCII wrapping and10class/20unlabeled-edge maximum each reproduced RED before fixes. Bounded45candidates with cached graphemes; sample2388×912/95primitives. Complete dense inputs may still returnCLASS_LAYOUT_LIMIT.
- Actual final PPTX v2:63175bytes, SHA256 c75b22e883f682a1b147480bdc75857d2f3597a3400d67a6e01f11f3b9b1f46e; package/layout findings0, first-party import/render, visual inspection and separate-copy edit/reimport passed. Native PowerPoint/Google Slides unverified.

## Final local verification

- Independent review also reproduced4null-prototype array cases (classes/relationships/attributes/operations) accepted before incompatible layout methods. Validator now requires ordinary Array.prototype;4RED→GREEN with fixed INVALID_CLASS_DIAGRAM. Final parser27/layout14; independent final41pass and earlier broader65pass; owned Studio rollback/receipt/replay/isolation probes passed. No remaining findings.
- Final Node24 gate `.local/verification/class-reviewed-verify.log`:779total/778pass/1Windows-onlyskip/0fail, typecheck0/build0/overall0, tests25.76s. Previous pre-last-fix gate774pass is superseded.
- Final Chrome fixture `.local/ui-e2e/mac-task24-NOI3kC`: keyword/data/file typed members accepted;self/namespace/HTML/density rejected;v1/v2source/history/project isolation;dirty export disabled;actual product-button downloads4files match server bytes exactly;new server process/sameSQLite preserves revisions and bytes;keyboard scroll0→12 both axes;console0 before cleanup. Product sources/HEAD/status unchanged, factory0, AI/CLI0, Run0. PID37541/43454 exit0, loopback53353 closed, tab423251683 closed, cleanup errors[].
- Final v1PPTX63175B/MD901B and v2PPTX63176B/MD902B. Evidence: result.json, browser-checks.json, download-checks.json, screenshots and tab-cleanup.json under the fixture. Initial fixture mac-task24-xseyXL was also cleanly stopped before final review/build QA. The full-page Chrome screenshot has a sticky-header stitching artifact; viewport evidence after owned server shutdown records the expected disconnected/disabled state.
- Native PowerPoint/Google Slides and Windows final gate remain unverified. No provider invocation, dependency addition, remote push or deployment.
