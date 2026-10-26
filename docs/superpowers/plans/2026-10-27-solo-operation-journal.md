# Solo operation identity journal

**Goal:** Persist the exact manager/session/generation that initiates each new Solo Run before native dispatch, retain state-transition history, and expose it through inert authenticated reads. This is a prerequisite for recovery identity and handoff, not a release authority.

**Architecture:** Extend the existing Store Run transactions with additive versioned tables. Controller contributes a fresh manager nonce and its actual connection generation/session. Legacy Runs remain unchanged and explicitly have unknown identity. No second execution path, PID inference, process signalling, automatic retry, release or qualification claims.

**Requirements:** goal-objective Phase1/3, V04-CONTROL-PLANE Recovery identity and additive migration. Existing Run/Task/check bodies, IDs, receipts and historical events are preserved.

- [x] RED: new intent and transition journal commit atomically with Run; failed identity/event persistence rolls back and prevents turn dispatch.
- [x] Implement strict server-only identity input, immutable scope and monotonic revision history in Store. Response chunks do not grow transition history.
- [x] Connect Controller creation to actual manager/session/generation, preserve old request replay without a new journal/native call.
- [x] Verify disk restart, repeated migration, legacy unknown identity, late acknowledgement and failed terminal transition.
- [x] Add authenticated read-only operation history endpoint and per-Run UI detail; no identity claims accepted from browser input.
- [x] Focused regression, full Node24 verify, independent review, real browser history/restart fixture and documentation.
- [x] Local checkpoint commit after final diff review.

Evidence: `.local/verification/solo-operation-reviewed.log` 854 total / 853 pass / 1 Windows-only skip / 0 fail, type/build exit0. Subsequent UI error wording and compact spacing passed typecheck/build and Chrome. Independent notification persistence P1 reproduced RED2 and fixed; final review includes simultaneous journal/event/close failure and found no remaining actionable defect. `.local/ui-e2e/solo-operation-20261027/result.json` records two distinct closed server processes, unchanged three synthetic Runs/journals, actual native calls0 and three screenshot hashes. This is a synthetic UI/storage fixture, not actual AI E2E.

Completion of this slice does not supply runtime version/policy qualification, OS boot/start/child proof, shared resource ownership or release CAS. Those remain explicit next work. The complete product objective and Phase1 E2E remain open.
