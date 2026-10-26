# Static app result preview implementation plan

**Goal:** Let users interact with an actual HTML/CSS/JavaScript result from their selected managed workspace in Development.

**Architecture:** Reuse `Projects.snapshot()` for one bounded, validated byte snapshot. An independent loopback HTTP origin serves only immutable preview bytes, with capability paths, response CSP and an opaque sandbox iframe. The authenticated Orbit API controls creation; no build scripts, native agents, installation or dev servers run.

**Tech Stack:** Existing Node24/TypeScript/React; no new dependencies.

**Spec:** User goal Phase1 and scenario A step5; existing A–K remain intact. This static slice does not complete automatic orchestration, runtime qualification, live backend/dev-server previews, or actual AI E2E.

## Decisions and constraints

- Reuse clean dedicated branch at HEAD5f99f68. User explicitly authorized autonomous internal decisions and local implementation; no repeated design approval.
- Considered srcdoc/blob: inherited Orbit CSP would block application inline scripts/styles or require weakening the control UI policy. Choose a separate static origin with its own policy. Keep the main UI script/style policy unchanged.
- Only Git-visible HTML and relative JS/CSS/image/font assets are supported. Ignored build output, npm/TSX compilation, absolute-root asset references, storage, backend/API connections and multi-page navigation are outside this slice and must be described honestly.
- Preview is an ephemeral frozen snapshot, not test success or AI completion. Keep source digest and creation/expiration time. Refresh replaces the workspace preview; main-server restart invalidates all preview URLs. Maximum4 previews, 8MiB each,256 supported files,10minute TTL.
- Main HTTP server owns a second ephemeral loopback listener, starts it on listening, awaits readiness before HTTP responses, and closes it with the main server. Main CSP frame-src is the exact preview origin. Preview HTML is served only to iframe destinations; assets only under a random capability directory. No filesystem fallback, proxy, cookies, auth bridge or postMessage bridge.
- iframe and response sandbox allow scripts only. Response CSP denies connections, workers, nested frames, objects, forms and base changes; enables only preview-directory assets and inline JS/CSS. CORS static assets accept anonymous opaque-origin reads. Deny permissions and DNS prefetch. Browser isolation is not OS process/network containment; no claim against all browser egress or resource exhaustion.

## Review focus

1. Unauthenticated/CSRF/workspace mismatch/stale digest must not create previews.
2. HTML and module scripts render and button interactions work, without weakening Orbit CSP or receiving Orbit session/API access.
3. Traversal, malformed URL, unknown token, sensitive source, unsupported MIME, direct top-level HTML and expired/replaced tokens fail closed.
4. File changes never silently mutate existing bytes. UI marks known stale results, clears across workspace switch and restart, and offers explicit refresh/close.
5. Actual Chrome probes cover cross-origin parent access, fetch, external image/script, nested frame, popup, self-navigation and top-navigation against owned loopback canaries; record exact observations and limitations.

## Task 1 — snapshot and isolated static host

Files: `shared/app-preview.ts`, `server/app-preview.ts`, `tests/app-preview.test.ts`.

- [x] Write failing tests for listing/creation, snapshot bytes, assets/module CORS, bounds, stale input, token rotation/expiry, routing and response protections.
- [x] Implement `AppPreviewHost` with `listen(orbitOrigin)`, `origin`, `catalog(workspaceId)`, `create(workspaceId,{entryPath,expectedSourceDigest})`, `close()`. Constructor receives a trusted snapshot callback. No Store/Projects/auth object reaches request handling.
- [x] Run focused tests and repair actual failures. Preserve original source bytes.

## Task 2 — API and Development UI

Files: `server/controller.ts`, `server/http.ts`, `web/app-preview.tsx`, `web/pages.tsx`, `web/style.css`, new HTTP/UI tests and `tests/app-preview-state.test.ts`.

- [x] RED tests for authentication, CSRF, query/extra-field rejection, selected-workspace admission and runtime-free requests.
- [x] Connect catalog GET and creation POST through existing session/CSRF route and controller workspace checks. Use no execution lock release or new AI dispatch.
- [x] Add accessible entry selection, open/refresh/close controls, isolated iframe, timestamps/digest, stale and unsupported-state copy. Source changes/run completion cause catalog recheck; no completion claims from iframe load.
- [x] Focused HTTP/UI regression and actual browser interaction with owned fixture repository.

## Task 3 — independent review and integration checkpoint

- [x] Independent review, meaningful regressions for findings, complete Node24 verify and diff check.
- [x] Record static-app fixture vs actual AI and browser/platform limits in MASTER PLAN/RESULTS; retain remaining ownership/qualification and whole-product work.
- [x] Commit locally; no push/deployment/auth changes. Save screenshot and reproducible verification evidence under ignored `.local`.

## Verification ledger

- Task1: missing module RED1; basic3pass. Independent startup-close race RED1 fixed with stored startup promise/stopped check.
- Task2: HTTP missing routes RED2; UI missing module RED2; integrated10 tests pass after source-revision and loaded-document-origin RED3 repairs. Main script/style CSP unchanged. HTML response carries the authorized preview origin; restart mismatch asks for a deliberate page reload to preserve other unsaved input.
- Task3: first full893total/892pass/1Windows skip; intermediate895total/894pass/1Windows skip/0fail; final898total/897pass/1Windows skip/0fail, type/build0. Chrome owned fixture: module/CSS/Todo interactions, manual and SSE stale removal, workspace isolation, five server lifetimes, restart notice/reload verified. Canary0/native0/Run0/realAI0. Final logs and precise boundaries are in ORBIT-MASTER-RESULTS Task30.
- Ruling: use the already established MASTER PLAN/RESULTS and this plan as the continuation ledger; do not create a parallel progress hierarchy. The dedicated branch is reused.
- Browser-security references consulted: [CSP3](https://www.w3.org/TR/CSP/), [HTML sandbox flags](https://html.spec.whatwg.org/dev/browsers.html), [MDN srcdoc](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc). Browser isolation does not establish OS-level egress/resource containment.
- Follow-up review: a delayed successful POST could be discarded by an unrelated SSE revision while revoking the displayed old token. Actual-TSX hook regression RED1/2pass; split catalog sequencing from creation/lifecycle, queue revision refresh, and recheck current source after POST. Focused7/7 and independent3/3 pass, no additional important finding.
