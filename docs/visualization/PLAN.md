# Visualization implementation plan

The assigned execution contract is the approved scope. Implement inline in this dedicated worktree; do not commit, change shared contracts, dependencies, HTTP, storage core, or another worktree.

1. Add failing behavior tests in `tests/visualization.test.ts` for a restricted Mermaid grammar, architecture graph validation, editable presentation conversion, immutable project-scoped Artifact revisions, and timeline replay/gaps/workspace boundaries.
2. Implement browser-safe pure helpers and independent React components in `web/visualization/`; server-owned hashing and in-memory Artifact repository in `server/visualization/`.
3. Verify targeted tests, TypeScript, the complete regression suite, production build, and separate browser bundling of the new UI. Obtain a read-only independent review, fix substantive issues, record evidence and integration requirements.

Design: a small allowlisted flowchart grammar parsed into inert graph data, rendered as React SVG elements (no Mermaid runtime, raw HTML, remote renderer, or fetched URLs). Architecture JSON uses the same graph validator. PPTX conversion produces editable shapes, text, and connectors; an injected exporter owns serialization. No exporter is provided and UI must state that limitation. Artifacts retain exact submitted source, server-generated UUID/SHA-256/revisions, optimistic concurrency, and detached return values. Timeline reads existing shared types and never changes execution or verification.

Ruling: `shared/parallel.ts` is absent. Do not create replacement named common contracts. Independent implementation helpers can use structural inputs and inferred return types until integration supplies the shared file; record this as an integration limitation. The named common types and their contract tests remain integration-owned.

Ruling: the requested `docs/PARALLEL-visualization-RESULTS.md` conflicts with the execution contract's ownership whitelist. Write `docs/visualization/RESULTS.md` instead and report the conflict.

Review focus: executable/encoded Mermaid input, malformed or oversized graph/Artifact input, mutation of returned revisions, cross-project access, conflicting event sequences, stale workspace events and reload callbacks, exporter availability claims.

Execution ledger: independent helpers/server/UI and 17 tests implemented. Final TypeScript and 73/73 combined tests pass. Both production and independent UI bundles remain blocked by the pre-existing sandbox ancestor-directory error. Independent read-only review completed; reload lifecycle and default connector visibility findings were fixed and covered by regressions. Shared contracts remain absent. Full evidence and limitations are in `RESULTS.md`; integration requirements are in `INTEGRATION-CONTRACT.md`. No commits or integration writes performed.
