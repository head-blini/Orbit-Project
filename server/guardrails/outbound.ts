import { isIP } from 'node:net';

export const connectionProviderIds = Object.freeze(['bedrock', 'litellm', 'vllm', 'freellmapi'] as const);
export const MAX_OUTBOUND_BYTES = 256 * 1024;

export interface OutboundFinding {
  kind: 'credential' | 'email' | 'phone' | 'national_id';
  /** Half-open UTF-16 offsets, suitable for String.slice; never matched values. */
  start: number;
  end: number;
}

type DenialCode = 'INVALID_CONFIGURATION' | 'UNKNOWN_DESTINATION' | 'INVALID_PAYLOAD'
  | 'PAYLOAD_TOO_LARGE' | 'CREDENTIAL_DETECTED' | 'PERSONAL_DATA_BLOCKED';
type OutboundDecision = {allowed:true; payload:string} | {allowed:false; code:DenialCode};

/** Accept JSON-like data only; never invoke accessor properties or stringify rejected values. */
export function readDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  const record: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) return null;
    record[key] = descriptor.value;
  }
  return record;
}

/** Pattern coverage is intentionally finite; see docs/provider-guardrail/INTEGRATION-CONTRACT.md. */
export function inspectOutbound(text: string): OutboundFinding[] {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_OUTBOUND_BYTES)
    throw new Error('INVALID_INSPECTION_INPUT');
  const patterns: {kind:OutboundFinding['kind']; pattern:RegExp}[] = [
    {kind:'credential', pattern:/\b(?:[a-z0-9]+[_-])?(?:api[_-]?key|(?:access|refresh|session)[_-]?token|secret(?:[_-]?(?:key|access[_-]?key))?|password|authorization)["']?\s*[=:]\s*["']?[^\s"',;}]+/gi},
    {kind:'credential', pattern:/\bBearer\s+[^\s"']+/gi},
    {kind:'credential', pattern:/\b(?:sk-[\w-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[\w]+|github_pat_[\w]+|eyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?)/g},
    {kind:'credential', pattern:/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g},
    // The top-level label must start with a letter, so npm specs such as pkg@1.11.13 are not addresses.
    {kind:'email', pattern:/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)*\.[A-Z](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?![A-Z0-9-])/gi},
    {kind:'phone', pattern:/(?<!\d)(?:01[016789][ -]?\d{3,4}[ -]?\d{4}|\+82[ -]?1[016789][ -]?\d{3,4}[ -]?\d{4}|\+1[ -]?(?:\(\d{3}\)|\d{3})[ -]?\d{3}[ -]?\d{4})(?!\d)/g},
    {kind:'national_id', pattern:/(?<!\d)(?:\d{6}[ -]?[1-8]\d{6}|\d{3}-\d{2}-\d{4})(?!\d)/g},
  ];
  const findings: OutboundFinding[] = [];
  for (const {kind, pattern} of patterns)
    for (const match of text.matchAll(pattern))
      findings.push({kind, start:match.index, end:match.index + match[0].length});
  return findings.sort((a,b) => a.start - b.start || b.end - a.end || a.kind.localeCompare(b.kind));
}

function validEndpoint(endpoint: string, classification: 'local' | 'external'): boolean {
  // Conservative lexical subset: no credentials, query, fragment, escapes, or parser-normalized hosts.
  const match = /^(https?):\/\/(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?(\/[a-zA-Z0-9/._~-]*)?$/.exec(endpoint);
  if (!match) return false;
  try {
    const url = new URL(endpoint);
    if (url.hostname !== match[2].toLowerCase() || (match[3] && Number(match[3]) === 0)) return false;
    if (classification === 'local') return url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' || isIP(url.hostname) || url.hostname.startsWith('[')) return false;
    if (/(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) return false;
    return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname);
  } catch { return false; }
}

function parsePolicy(input: unknown) {
  const data = readDataRecord(input, ['destinationId', 'providerId', 'classification', 'endpoint', 'action']);
  if (!data) return null;
  const {destinationId, providerId, classification, endpoint, action} = data;
  if (typeof destinationId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(destinationId)) return null;
  const provider = connectionProviderIds.find(id => id === providerId);
  if (!provider || (classification !== 'local' && classification !== 'external')) return null;
  if (action !== 'block' && action !== 'mask' && action !== 'allow') return null;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !validEndpoint(endpoint, classification)) return null;
  return Object.freeze({destinationId, providerId:provider, classification, endpoint, action});
}

function mask(text: string, findings: OutboundFinding[]): string {
  const spans: {start:number; end:number}[] = [];
  for (const finding of findings) {
    const last = spans.at(-1);
    if (last && finding.start <= last.end) last.end = Math.max(last.end, finding.end);
    else spans.push({start:finding.start, end:finding.end});
  }
  let output = '', cursor = 0;
  for (const span of spans) {
    output += text.slice(cursor, span.start) + '[REDACTED]';
    cursor = span.end;
  }
  return output + text.slice(cursor);
}

/** Construct ONLY from trusted server configuration. Requests supply a destination ID, never a policy. */
export function createOutboundGuardrail(configuration: readonly unknown[]) {
  const policies = new Map<string, NonNullable<ReturnType<typeof parsePolicy>>>();
  let valid = Array.isArray(configuration);
  try {
    if (valid) for (const input of configuration) {
      const policy = parsePolicy(input);
      if (!policy || policies.has(policy.destinationId)) {valid = false; break;}
      policies.set(policy.destinationId, policy);
    }
  } catch { valid = false; }
  if (!valid) policies.clear();

  function evaluateOutbound(destination: unknown, text: unknown): OutboundDecision {
    if (!valid) return {allowed:false, code:'INVALID_CONFIGURATION'};
    const policy = typeof destination === 'string' ? policies.get(destination) : undefined;
    if (!policy) return {allowed:false, code:'UNKNOWN_DESTINATION'};
    if (typeof text !== 'string') return {allowed:false, code:'INVALID_PAYLOAD'};
    if (Buffer.byteLength(text, 'utf8') > MAX_OUTBOUND_BYTES) return {allowed:false, code:'PAYLOAD_TOO_LARGE'};
    const findings = inspectOutbound(text);
    if (findings.some(f => f.kind === 'credential')) return {allowed:false, code:'CREDENTIAL_DETECTED'};
    if (findings.length && policy.action === 'block') return {allowed:false, code:'PERSONAL_DATA_BLOCKED'};
    return {allowed:true, payload:policy.action === 'mask' ? mask(text, findings) : text};
  }
  return Object.freeze({
    evaluateOutbound,
    // Immutable snapshots; no mutable registry or caller-provided destinations escape.
    destination: (id: string) => policies.get(id),
  });
}
