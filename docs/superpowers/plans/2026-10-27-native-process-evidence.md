# Native process evidence implementation plan

**Goal:** Record Solo connection intent before the native factory, then retain observations from the exact owned ChildProcess and link them to the existing Run identity. This supplies missing evidence for recovery/ownership; neither a terminal Run nor parent close grants cross-manager release.

**Architecture:** Keep existing Rpc, Controller and Run schema. Add a versioned connection journal keyed by manager incarnation and connection generation. Rpc owns the opaque process handle and emits facts; Store validates immutable identity and writes evidence/events atomically. Controller joins the native session and preserves late close evidence for its original connection. No process signalling by stored PID, no qualification/descendant inference, no release endpoint or new dependencies.

**Spec:** goal-objective Phase1/3, V04 REC-IDENTITY/REC-STOP/REC-STORAGE. Common ownership cannot safely release from the existing generic closed event, so exact lifecycle collection precedes that integration. The full Phase1 and A–K requirements remain open.

- [x] Agent: real Node child-process RED tests; implement `shared/native-process.ts`, `Rpc.processObservation` and process.observed; verify existing RPC close behavior.
- [x] Root: additive connection intent/session/process/transport journal with strict scope and monotonic immutable terminal observations; rollback and restart tests.
- [x] Root: commit intent before factory, bind session, collect process facts independent of stale UI generation, prevent native launch on intent persistence failure and quarantine on evidence write failure. Review added persisted unfinished-journal admission on startup and immediate quarantine for unclassified factory failure; trusted no-spawn refusal is explicit and separately recorded.
- [x] Root: authenticated per-Run history displays parent process evidence separately from native turn status and unknown descendants.
- [x] Real child + Controller integration, full Node24 verify (872 total / 871 pass / 1 Windows-only skip / 0 fail, type/build exit0), independent review, browser evidence and docs. Local checkpoint follows the final diff review; see Git log for its resulting hash.

Completion limits: this journal records observations and reconstructs the incomplete-collection deny barrier on startup. Journal completion is not execution/resource release. It does not collect OS boot/start identity, prove descendants or remote sessions stopped, qualify runtime profiles, acquire shared resource ownership, or authorize recovery release. Connection attempts without Runs remain available to server-side inventory; they are not shown as successful operations or automatically retried. Only a trusted factory's explicit pre-spawn refusal (`CODEX_NOT_INSTALLED` or `LAUNCH_REJECTED_BEFORE_SPAWN`) records known non-creation; unknown errors remain unresolved.
