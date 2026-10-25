// Throwaway Phase 0 contracts, not a production adapter.
import { realpathSync, statSync } from 'node:fs';
import { relative, isAbsolute, sep } from 'node:path';
export type Availability = 'not_installed' | 'auth_required' | 'ready' | 'unsupported' | 'unknown';
export type CapabilityEvidence = 'verified' | 'unsupported' | 'unknown';
export interface Provider { id: string; status: Availability; capabilities: Record<string, CapabilityEvidence> }
export interface PlanningArtifact {
  schemaVersion: '0.1'; version: number;
  source: { kind: 'manual' | 'external'; format: 'markdown' | 'json'; label?: string };
  body: string; acceptanceCriteria: string[];
}
export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  register(p: Provider) {
    if (!p.id || this.providers.has(p.id) || !['not_installed','auth_required','ready','unsupported','unknown'].includes(p.status)) throw new Error('Invalid provider');
    if (!Object.values(p.capabilities).every(v => ['verified','unsupported','unknown'].includes(v))) throw new Error('Invalid evidence');
    this.providers.set(p.id,p);
  }
  all() { return [...this.providers.values()]; }
  ready() { return this.all().filter(p=>p.status==='ready'); }
}
export function validatePlan(p: PlanningArtifact): boolean {
  return p?.schemaVersion==='0.1' && Number.isInteger(p.version) && p.version>0 &&
    ['manual','external'].includes(p.source?.kind) && ['markdown','json'].includes(p.source?.format) &&
    typeof p.body==='string' && !!p.body.trim() && Array.isArray(p.acceptanceCriteria) &&
    p.acceptanceCriteria.length>0 && p.acceptanceCriteria.every(x=>typeof x==='string' && !!x.trim());
}
export function validateRoot(root: string, candidate: string): boolean {
  try {
    if (!isAbsolute(root) || !isAbsolute(candidate) || !statSync(candidate).isDirectory()) return false;
    const r=relative(realpathSync(root),realpathSync(candidate));
    return r==='' || (!isAbsolute(r) && r!=='..' && !r.startsWith('..'+sep));
  } catch { return false; }
}
export function initialRun(threadId: string) {
  return { threadId, turnId: null as string|null, execution:'created', verification:'not_run', deltaCount:0 };
}
export function applyEvent(state: ReturnType<typeof initialRun>, e: any) {
  const s={...state}, p=e.params ?? {};
  if (e.method==='transport/closed') { if (!['succeeded','failed','interrupted'].includes(s.execution)) s.execution='lost'; return s; }
  if (p.threadId!==s.threadId) return s;
  const turnId=p.turn?.id ?? p.turnId;
  if (s.turnId && turnId && turnId!==s.turnId) return s;
  if (e.method==='turn/started') { s.turnId=p.turn.id; s.execution='running'; }
  if (e.method==='item/agentMessage/delta') s.deltaCount++;
  if (e.method==='error' && p.willRetry===false) s.execution='failed';
  if (e.method==='turn/completed') {
    s.turnId=p.turn.id;
    s.execution=({completed:'succeeded',interrupted:'interrupted',failed:'failed'} as Record<string,string>)[p.turn.status] ?? 'unknown';
  }
  return s;
}
export function denyRequest(e: any) {
  if (['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(e.method)) return {id:e.id,result:{decision:'decline'}};
  if (e.method==='item/permissions/requestApproval') return {id:e.id,result:{permissions:{},scope:'turn'}};
  return {id:e.id,error:{code:-32601,message:'Unsupported server request; no permission granted'}};
}
// Deliberately lossy: do not persist prompts, deltas, account details, commands or stderr.
export function safeLog(e: any) {
  const out: Record<string,string|number>={};
  if (typeof e.method==='string' && /^[a-zA-Z0-9/_-]{1,100}$/.test(e.method)) out.method=e.method;
  if (typeof e.id==='number') out.id=e.id;
  return out;
}
