export type ProjectAiRuntime='codex'|'claude-code';
export interface ProjectAiPreferences {
  planning:ProjectAiRuntime;
  execution:ProjectAiRuntime;
  revision:number;
  /** Null for virtual defaults; reading preferences never writes a row. */
  updatedAt:string|null;
}
export interface UpdateProjectAiPreferencesInput {
  expectedRevision:number;
  planning:ProjectAiRuntime;
  execution:ProjectAiRuntime;
}
