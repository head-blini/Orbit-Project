import type { PlanningDraft, PlanningParseResult, PlanningSource } from '../../shared/parallel.ts';

export const MAX_PLANNING_BYTES = 256 * 1024;
export const PLANNING_EXPORT_MARKER = '<!-- orbit-planning-export:v1 -->';
export interface PlanningInput { format: 'markdown' | 'json'; text: string; source: PlanningSource }
type Issue = { field: string; code: string };
const fail = (field: string, code: string): PlanningParseResult => ({ ok: false, issues: [{ field, code }] });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));

/** Pure, browser-compatible parser. Never interprets HTML, URLs or embedded commands. */
export function parsePlanningDraft(input: PlanningInput): PlanningParseResult {
  if (!object(input) || !exactKeys(input, ['format', 'text', 'source'])) return fail('input', 'INVALID_INPUT');
  if (input.source !== 'manual' && input.source !== 'import') return fail('source', 'INVALID_SOURCE');
  if (typeof input.text !== 'string') return fail('text', 'INVALID_TEXT');
  // The character check prevents allocating a large encoded buffer for obviously oversized input.
  if (input.text.length > MAX_PLANNING_BYTES || new TextEncoder().encode(input.text).length > MAX_PLANNING_BYTES) return fail('text', 'INPUT_TOO_LARGE');
  if (input.format === 'markdown') {
    const text = input.text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (text.startsWith(PLANNING_EXPORT_MARKER)) {
      // Only one exact JSON envelope; no competing Markdown body or authority metadata.
      const prefix = `${PLANNING_EXPORT_MARKER}\n\`\`\`json\n`;
      const body = text.endsWith('\n') ? text.slice(0, -1) : text;
      if (!body.startsWith(prefix) || !body.endsWith('\n```')) return fail('text', 'INVALID_EXPORT_ENVELOPE');
      return parsePlanningDraft({format:'json', text:body.slice(prefix.length, -4), source:input.source});
    }
    return parseMarkdown(text, input.source);
  }
  if (input.format !== 'json') return fail('format', 'INVALID_FORMAT');
  let value: unknown;
  try { value = JSON.parse(input.text.replace(/^\uFEFF/, '')); } catch { return fail('text', 'INVALID_JSON'); }
  return normalizeJsonDocument(value, input.source);
}

function normalizeJsonDocument(value: unknown, source: PlanningSource): PlanningParseResult {
  if (source !== 'manual' && source !== 'import') return fail('source', 'INVALID_SOURCE');
  if (!object(value)) return fail('document', 'INVALID_DOCUMENT');
  if (value.schema_version !== '1.0') return fail('schema_version', 'UNSUPPORTED_SCHEMA');
  if (!exactKeys(value, ['schema_version', 'title', 'goal', 'requirements', 'constraints', 'open_questions', 'decisions', 'source'])) return fail('document', 'UNKNOWN_FIELD');
  if (typeof value.title !== 'string' || typeof value.goal !== 'string') return fail('document', 'INVALID_TEXT_FIELDS');
  if (!Array.isArray(value.requirements)) return fail('requirements', 'INVALID_REQUIREMENTS');
  if (!strings(value.constraints) || !strings(value.open_questions)) return fail('document', 'INVALID_LIST');
  // v1 has decisions but the shared draft contract cannot represent them. Never silently discard them.
  if (value.decisions !== undefined && (!Array.isArray(value.decisions) || value.decisions.length !== 0)) return fail('decisions', 'UNSUPPORTED_DECISIONS');
  if (value.source !== undefined) {
    const source = value.source;
    if (!object(source) || !exactKeys(source, ['kind', 'provider_id', 'external_url']) || typeof source.kind !== 'string'
      || (source.provider_id !== undefined && source.provider_id !== null && typeof source.provider_id !== 'string')
      || (source.external_url !== undefined && source.external_url !== null && typeof source.external_url !== 'string')) return fail('source', 'INVALID_SOURCE_METADATA');
  }
  const requirements: PlanningDraft['requirements'] = [];
  for (const [index, item] of value.requirements.entries()) {
    if (!object(item) || !exactKeys(item, ['id', 'description', 'acceptance_criteria'])
      || typeof item.id !== 'string' || typeof item.description !== 'string' || !strings(item.acceptance_criteria)) return fail(`requirements.${index}`, 'INVALID_REQUIREMENT');
    requirements.push({ label: item.id.trim(), description: item.description.trim(), acceptanceCriteria: item.acceptance_criteria.map(text => text.trim()) });
  }
  const draft: PlanningDraft = { schemaVersion: '1.0', title: value.title.trim(), goal: value.goal.trim(), requirements,
    constraints: value.constraints.map(text => text.trim()), openQuestions: value.open_questions.map(text => text.trim()), source };
  return finish(draft);
}

function finish(draft: PlanningDraft): PlanningParseResult {
  const labels = new Set<string>();
  for (const [index, requirement] of draft.requirements.entries()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(requirement.label)) return fail(`requirements.${index}.label`, 'INVALID_LABEL');
    if (labels.has(requirement.label)) return fail(`requirements.${index}.label`, 'DUPLICATE_LABEL');
    labels.add(requirement.label);
  }
  return { ok: true, draft };
}

function parseMarkdown(text: string, source: PlanningSource): PlanningParseResult {
  const draft: PlanningDraft = { schemaVersion: '1.0', title: '', goal: '', requirements: [], constraints: [], openQuestions: [], source };
  const names: Record<string, string> = { goal: 'goal', '목표': 'goal', requirements: 'requirements', '요구사항': 'requirements', constraints: 'constraints', '제약': 'constraints', 'open questions': 'openQuestions', '질문': 'openQuestions' };
  let section = '', titleSeen = false, criteria = false;
  let requirement: PlanningDraft['requirements'][number] | undefined;
  const seen = new Set<string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const field = `line.${index + 1}`;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length, label = heading[2].trim();
      if (level === 1 && !titleSeen && !section) { draft.title = label; titleSeen = true; continue; }
      if (level === 2 && titleSeen) {
        const next = Object.hasOwn(names, label.toLowerCase()) ? names[label.toLowerCase()] : undefined;
        if (!next) return fail(field, 'UNKNOWN_SECTION');
        if (seen.has(next)) return fail(field, 'DUPLICATE_SECTION');
        seen.add(next); section = next; requirement = undefined; criteria = false; continue;
      }
      if (level === 3 && section === 'requirements') {
        requirement = { label, description: '', acceptanceCriteria: [] };
        draft.requirements.push(requirement); criteria = false; continue;
      }
      if (level === 4 && requirement && !criteria && ['acceptance criteria', '인수 조건'].includes(label.toLowerCase())) { criteria = true; continue; }
      return fail(field, 'INVALID_HEADING');
    }
    if (section === 'goal') draft.goal += (draft.goal ? '\n' : '') + line;
    else if (section === 'requirements' && requirement && !criteria) requirement.description += (requirement.description ? '\n' : '') + line;
    else {
      const bullet = /^[-*]\s+(.+)$/.exec(line);
      if (!bullet) return fail(field, 'EXPECTED_LIST_ITEM');
      if (section === 'constraints') draft.constraints.push(bullet[1]);
      else if (section === 'openQuestions') draft.openQuestions.push(bullet[1]);
      else if (section === 'requirements' && requirement && criteria) requirement.acceptanceCriteria.push(bullet[1]);
      else return fail(field, 'UNEXPECTED_CONTENT');
    }
  }
  if (!titleSeen && text.trim()) return fail('title', 'MISSING_TITLE');
  return finish(draft);
}

/** Approval validation is separate: structurally valid incomplete drafts can be saved. */
export function approvalIssues(draft: PlanningDraft): Issue[] {
  const issues: Issue[] = [];
  if (!draft.title.trim()) issues.push({ field: 'title', code: 'REQUIRED' });
  if (!draft.goal.trim()) issues.push({ field: 'goal', code: 'REQUIRED' });
  if (!draft.requirements.length) issues.push({ field: 'requirements', code: 'REQUIRED' });
  draft.requirements.forEach((requirement, index) => {
    if (!requirement.description.trim()) issues.push({ field: `requirements.${index}.description`, code: 'REQUIRED' });
    if (!requirement.acceptanceCriteria.length || requirement.acceptanceCriteria.some(criterion => !criterion.trim())) issues.push({ field: `requirements.${index}.acceptanceCriteria`, code: 'REQUIRED' });
  });
  return issues;
}

function planningDocument(draft: PlanningDraft) {
  return { schema_version: '1.0', title: draft.title, goal: draft.goal,
    requirements: draft.requirements.map(requirement => ({ id: requirement.label, description: requirement.description, acceptance_criteria: requirement.acceptanceCriteria })),
    constraints: draft.constraints, open_questions: draft.openQuestions, decisions: [],
    source: { kind: draft.source === 'manual' ? 'in_app_manual' : 'file', provider_id: null, external_url: null } };
}

/**
 * Revalidate authoritative stored content with the same JSON schema. The input
 * byte cap belongs to parsePlanningDraft: formatting and escaping can expand a
 * legitimately saved draft. Callers must still compare the normalized result
 * with the exact stored shape and verify its content hash.
 */
export function normalizeStoredPlanningDraft(draft: PlanningDraft): PlanningParseResult {
  return normalizeJsonDocument(planningDocument(draft), draft.source);
}

/** Editable canonical JSON, containing no authority-bearing version fields. */
export function serializePlanningDraft(draft: PlanningDraft): string {
  return JSON.stringify(planningDocument(draft), null, 2);
}
