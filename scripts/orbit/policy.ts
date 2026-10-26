import { lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

export const BASE = '641d01c21ae11a9dad1a16d93a08b2902bbcbf4c';
export const featureFiles = {
  planning: ['docs/planning/INTEGRATION-CONTRACT.md','docs/planning/PARALLEL-planning-RESULTS.md','docs/planning/README.md','server/planning/index.ts','server/planning/parser.ts','server/planning/repository.ts','tests/fixtures/planning/valid.json','tests/fixtures/planning/valid.md','tests/fixtures/planning/verify-bundle.mjs','tests/fixtures/planning/verify-ui.mjs','tests/planning.test.ts','web/planning/PlanningStudio.tsx','web/planning/index.tsx','web/planning/planning.css'],
  visualization: ['docs/visualization/INTEGRATION-CONTRACT.md','docs/visualization/PLAN.md','docs/visualization/RESULTS.md','server/visualization/artifacts.ts','tests/fixtures/visualization/verify-ui-build.mjs','tests/visualization.test.ts','web/visualization/Studio.tsx','web/visualization/index.tsx','web/visualization/mermaid.ts','web/visualization/presentation.ts','web/visualization/style.css','web/visualization/timeline.ts'],
  'provider-guardrail': ['docs/provider-guardrail/INTEGRATION-CONTRACT.md','docs/provider-guardrail/RESULTS.md','server/guardrails/outbound.ts','server/providers/connections.ts','tests/provider-guardrail.test.ts']
} as const;
export type Feature = keyof typeof featureFiles;
export const features = Object.keys(featureFiles) as Feature[];
const excluded = /(^|\/)(?:\.git|\.codex|\.agents|\.aws|\.local|\.worktrees|node_modules|dist|coverage|logs?|build|\.env(?:\..*)?|auth\.json|credentials?(?:\..*)?|cookies?(?:\..*)?|secrets?(?:\..*)?|config\.toml|settings(?:\..*)?)(\/|$)|\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$|\.(?:log|pem|key|p12|pfx|exe|dll|zip)$/i;
export function isExcluded(path:string) { return excluded.test(path); }
export function checkRelative(path:string) {
  if (!path || /[\\:\x00-\x1f*?\[\]]/.test(path) || isAbsolute(path) || path.split('/').some(p => !p || p==='.' || p==='..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) || isExcluded(path)) throw new Error('UNSAFE_PATH');
}
export function contained(root:string, target:string) {
  const rel = relative(resolve(root), resolve(target));
  if (rel==='..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('PATH_ESCAPE');
  let current = resolve(root);
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    current = resolve(current,part);
    const st = lstatSync(current);
    if (st.isSymbolicLink() || realpathSync(current).toLowerCase()!==current.toLowerCase()) throw new Error('LINK_REJECTED');
  }
  return resolve(target);
}
export function safeDiagnostic(value:string) {
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,'[REDACTED PRIVATE KEY]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g,'[REDACTED]')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g,'[REDACTED]')
    .replace(/\b(?:secret|client_secret|token)\s*[=:]\s*["']?[^\s"']+/gi,'[REDACTED]')
    .replace(/\bsk-[\w-]*/g,'[REDACTED]')
    .replace(/\bBearer\s+[^\s]+/gi,'Bearer [REDACTED]')
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password)\s*[=:]\s*["']?[^\s"']+/gi,'[REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g,'[REDACTED]');
}
export function scanText(value:string) {
  // Short synthetic strings in security tests are not credentials. Known formats
  // and plausibly real values fail closed; never include the match in the error.
  if (/\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}\b|\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|-----BEGIN [^-]*PRIVATE KEY-----\r?\n|\beyJ[\w-]{15,}\.[\w-]{15,}|\bBearer\s+[A-Za-z0-9_.-]{24,}|\b(?:api_key|access_token|refresh_token|password|client_secret)\s*[=:]\s*["'][A-Za-z0-9_+/.=-]{24,}["']/i.test(value)) throw new Error('SECRET_DETECTED');
}
const integrationFiles = new Set(['server/controller.ts','server/http.ts','server/store.ts','server/main.ts','web/main.tsx','web/workspaces.tsx','web/style.css','tests/parallel-contracts.test.ts','tests/orbit-integration.test.ts','tests/orbit-integration-ui.mjs','docs/ORBIT-INTEGRATION-RESULTS.md']);
export function assertEditable(path:string) {
  checkRelative(path);
  if (!integrationFiles.has(path) && !/^shared\/[\w/-]+\.ts$/.test(path) && !/^(?:server|web)\/integration\/[\w/-]+\.(?:ts|tsx|css)$/.test(path)) throw new Error('INTEGRATION_SCOPE_VIOLATION');
}
export function classifyFailure(text:string):'code'|'infrastructure' {
  if (/EPERM|EACCES|ENOENT|ENOSPC|ETIMEDOUT|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|permission denied|access is denied|POLICY|MCP_|AUTH|LOGIN|spawn|out of memory|timeout|ECONN|ENOTFOUND/i.test(text)) return 'infrastructure';
  return /error TS\d+|AssertionError|ERR_ASSERTION|SyntaxError|Transform failed|No matching export|Could not resolve|not ok \d+/i.test(text) ? 'code' : 'infrastructure';
}
export interface Check {ok:boolean; kind:string; summary:string}
