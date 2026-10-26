# Solo lost execution admission plan

**Goal:** Keep uncertain Solo work from being followed by another execution, including after restart or changing workspace.
**Spec:** docs/architecture/V04-CONTROL-PLANE.md V4-02; 2026-10-27 product goal Phase1/3.
**Architecture:** Reuse durable Run records and existing Controller/service admission callbacks. Add a volatile deny barrier before loss persistence. No second dispatcher, new dependency, native feature, automatic retry, or release endpoint.

Ruling: This slice implements quarantine only. Parent close, old PID absence and a boolean confirmation cannot release it. Shared cross-state-dir ownership, exact termination evidence and qualified manual recovery remain separate prerequisites. Until implemented, this server state cannot resume work after a lost Solo run. Historical records must not be deleted to bypass this gate.

- [x] RED: transport loss rejects reconnect/new prompt while returning the old request receipt. Current successful-reconnect regression changes to the newly required deny behavior.
- [x] RED: disk restart retains lost denial; another project/worktree and public service dispatch cannot bypass it; readonly snapshots/history still work.
- [x] Implement Controller gate and snapshot flag, all existing service busy callbacks, Model Hub dispatch guard, native version probe gate. Keep interrupts/close and inert reads available.
- [x] RED: persistence failure retains in-memory denial and restart reconstructs from the unresolved Run. UI clearly disables reconnect and discloses recovery availability.
- [x] Focused tests, full Node24 verify, independent review and browser fixture. Failures and exact evidence recorded in ORBIT-MASTER-RESULTS Task26. Final841total/840pass/1skip/0fail, type/build0. Review-driven late-event and actual transport dispatch races also RED→GREEN.
- [x] Verified slice isolated for local commit; prior unintegrated recovery contract files remain separate. Commit identity is available in Git history.

Review focus: request replay without a new turn; failure before persistence; direct public service calls; cross-workspace bypass; a ready provider never clearing the barrier. This does not certify Assisted/Autonomous or cross-process isolation.
