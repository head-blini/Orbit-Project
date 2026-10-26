import type {NativeNotCreatedReason} from '../shared/solo-operation.ts';

/** Trusted factory refusal only, before attempting to create any ChildProcess.
 * Never classify caught spawn/transport errors as this: their outcome is uncertain. */
export class NativeLaunchNotStarted extends Error {
  readonly reason:NativeNotCreatedReason;
  constructor(reason:NativeNotCreatedReason){super(reason);this.reason=reason;}
}
/** Only raised by the native executable resolver, before creating any ChildProcess. */
export class NativeExecutableUnavailable extends NativeLaunchNotStarted {
  constructor(){super('CODEX_NOT_INSTALLED');}
}
