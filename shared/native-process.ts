/** Server observation of one owned ChildProcess, never OS start identity or proof of descendant termination. */
export interface NativeProcessObservation {
  handleId:string;pid:number|null;createdAt:string;
  state:'spawn_pending'|'running'|'closed'|'spawn_failed';
  closedAt:string|null;exitCode:number|null;signal:string|null;
}
