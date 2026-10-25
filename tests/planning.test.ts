import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePlanningDraft, MAX_PLANNING_BYTES, serializePlanningDraft } from '../server/planning/parser.ts';
import { InMemoryPlanningRepository, toTaskDrafts } from '../server/planning/repository.ts';

const artifact = () => ({
  schema_version: '1.0', title: '검색 기능', goal: 'Find an item',
  requirements: [{ id: 'REQ-01', description: 'Search items', acceptance_criteria: ['Results appear'] }],
  constraints: ['Keep the public API'], open_questions: [], decisions: [],
  source: { kind: 'external_web', provider_id: null, external_url: null },
});
const input = () => ({ format: 'json' as const, text: JSON.stringify(artifact()), source: 'import' as const });
const markdown = '# Search\n\n## Goal\nFind an item\n\n## Requirements\n### REQ-01\nSearch items\n#### Acceptance criteria\n- Results appear\n\n## Constraints\n- Keep the public API\n\n## Open questions\n';

test('canonical v1 maps snake_case explicitly and normalizes provenance without providers', () => {
  const parsed = parsePlanningDraft(input());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.draft.schemaVersion, '1.0');
  assert.equal(parsed.draft.source, 'import');
  assert.deepEqual(parsed.draft.requirements, [{ label: 'REQ-01', description: 'Search items', acceptanceCriteria: ['Results appear'] }]);
  assert.equal(parsePlanningDraft({ ...input(), source: 'manual' }).ok, true);
});

test('documented Markdown and Korean section names map requirements and criteria', () => {
  const result = parsePlanningDraft({ format: 'markdown', text: markdown, source: 'manual' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.draft.requirements[0].acceptanceCriteria, ['Results appear']);
  const korean = markdown.replace('Goal', '목표').replace('Requirements', '요구사항').replace('Acceptance criteria', '인수 조건').replace('Constraints', '제약').replace('Open questions', '질문');
  assert.equal(parsePlanningDraft({ format: 'markdown', text: korean, source: 'manual' }).ok, true);
});

test('rejects old schemas, malformed JSON, unknown authority fields and lossy decisions', () => {
  for (const text of ['{', JSON.stringify({ ...artifact(), schema_version: '0.2' }),
    ...['id', 'projectId', 'revision', 'state', 'contentHash', 'approved'].map(key => JSON.stringify({ ...artifact(), [key]: 'forged' })),
    JSON.stringify({ ...artifact(), decisions: ['Keep this decision'] }),
    JSON.stringify({ ...artifact(), requirements: [{ id: 'R', description: 'x', acceptance_criteria: 'wrong' }] }),
    JSON.stringify({ ...artifact(), requirements: [artifact().requirements[0], artifact().requirements[0]] }),
  ]) assert.equal(parsePlanningDraft({ ...input(), text }).ok, false);
});

test('input cap is UTF-8 bytes and accepts exactly the limit', () => {
  const base = input();
  const text = base.text + ' '.repeat(MAX_PLANNING_BYTES - Buffer.byteLength(base.text));
  assert.equal(parsePlanningDraft({ ...base, text }).ok, true);
  assert.equal(parsePlanningDraft({ ...base, text: text + ' ' }).ok, false);
  assert.equal(parsePlanningDraft({ ...base, text: '한'.repeat(100_000) }).ok, false);
});

test('malformed Markdown is rejected without returning source text in diagnostics', () => {
  for (const text of ['## Unknown\nprivate-fixture', markdown + '\n## Goal\nduplicate', markdown + '\n## constructor', markdown + '\n## __proto__', markdown.replace('### REQ-01', '### REQ-01\n#### Unknown')]) {
    const parsed = parsePlanningDraft({ format: 'markdown', text, source: 'import' });
    assert.equal(parsed.ok, false);
    assert.equal(JSON.stringify(parsed).includes('private-fixture'), false);
  }
});

test('documented fixtures parse equivalently and canonical editor serialization preserves content', () => {
  const md = parsePlanningDraft({ format: 'markdown', text: readFileSync(new URL('./fixtures/planning/valid.md', import.meta.url), 'utf8'), source: 'manual' });
  const json = parsePlanningDraft({ format: 'json', text: readFileSync(new URL('./fixtures/planning/valid.json', import.meta.url), 'utf8'), source: 'manual' });
  assert.equal(md.ok, true);
  assert.deepEqual(md, json);
  if (md.ok) assert.deepEqual(parsePlanningDraft({ format: 'json', text: serializePlanningDraft(md.draft), source: 'manual' }), md);
});

test('runtime boundary rejects invalid envelopes, types and nested authority fields', () => {
  for (const bad of [null, {}, { ...input(), format: 'html' }, { ...input(), source: 'agent' }, { ...input(), text: 42 }, { ...input(), approved: true }]) {
    assert.equal(parsePlanningDraft(bad as Parameters<typeof parsePlanningDraft>[0]).ok, false);
  }
  for (const change of [{ requirements: [null] }, { constraints: [42] }, { open_questions: null }, { source: { kind: 'file', state: 'approved' } },
    { requirements: [{ ...artifact().requirements[0], state: 'approved' }] }]) {
    assert.equal(parsePlanningDraft({ ...input(), text: JSON.stringify({ ...artifact(), ...change }) }).ok, false);
  }
});

test('HTML, commands and URLs remain inert strings in Markdown and task drafts', () => {
  const repo = new InMemoryPlanningRepository();
  const text = markdown.replace('Search items', '<script>synthetic()</script> [link](https://example.invalid) $(synthetic)');
  const saved = repo.create('project-a', { format: 'markdown', text, source: 'import' });
  const approved = repo.approve('project-a', saved.id, saved.revision);
  assert.match(repo.toTasks('project-a', approved.id)[0].description, /<script>/);
});

test('incomplete drafts can be saved but cannot be approved or converted', () => {
  const repo = new InMemoryPlanningRepository();
  const saved = repo.create('project-a', { format: 'markdown', text: '# Draft\n', source: 'manual' });
  assert.equal(saved.state, 'draft');
  assert.throws(() => repo.approve('project-a', saved.id, 1), /INCOMPLETE_DRAFT/);
  assert.throws(() => repo.toTasks('project-a', saved.id), /NOT_APPROVED/);
  assert.throws(() => toTaskDrafts(saved), /NOT_APPROVED/);
});

test('approval and task conversion use saved versions with server-generated identity and hash', () => {
  const repo = new InMemoryPlanningRepository();
  const saved = repo.create('project-a', input());
  assert.equal(saved.revision, 1);
  assert.match(saved.contentHash, /^[a-f0-9]{64}$/);
  const approved = repo.approve('project-a', saved.id, 1);
  assert.equal(saved.state, 'draft');
  const tasks = repo.toTasks('project-a', saved.id);
  assert.deepEqual(tasks, toTaskDrafts(approved));
  assert.deepEqual(tasks[0].requirementLabels, ['REQ-01']);
  assert.equal(tasks[0].planningVersionId, saved.id);
  assert.equal('runId' in tasks[0], false);
});

test('caller mutations cannot alter stored versions or forge approval', () => {
  const repo = new InMemoryPlanningRepository();
  const saved = repo.create('project-a', input());
  saved.state = 'approved';
  saved.draft.requirements[0].acceptanceCriteria.push('forged');
  assert.throws(() => toTaskDrafts(saved), /UNTRUSTED_VERSION/);
  assert.throws(() => repo.toTasks('project-a', saved.id), /NOT_APPROVED/);
  const approved = repo.approve('project-a', saved.id, 1);
  assert.throws(() => toTaskDrafts(structuredClone(approved)), /UNTRUSTED_VERSION/);
  const listed = repo.list('project-a');
  listed[0].draft.title = 'tampered';
  assert.notEqual(repo.list('project-a')[0].draft.title, 'tampered');
  const tasks = repo.toTasks('project-a', saved.id);
  tasks[0].acceptanceCriteria.push('tampered');
  assert.deepEqual(repo.toTasks('project-a', saved.id)[0].acceptanceCriteria, ['Results appear']);
});

test('serialization hooks cannot forge approval or replace approved task content', () => {
  const repo = new InMemoryPlanningRepository();
  const saved = repo.create('project-a', input());
  const original = structuredClone(saved);
  saved.state = 'approved';
  Object.defineProperty(saved, 'toJSON', { value: () => original });
  assert.throws(() => toTaskDrafts(saved), /UNTRUSTED_VERSION/);
  const approved = repo.approve('project-a', saved.id, 1);
  const approvedOriginal = structuredClone(approved);
  approved.draft.requirements[0].description = 'forged';
  Object.defineProperty(approved, 'toJSON', { value: () => approvedOriginal });
  assert.throws(() => toTaskDrafts(approved), /UNTRUSTED_VERSION/);
});

test('revisions preserve previous approval and require a fresh approval', () => {
  const repo = new InMemoryPlanningRepository();
  const first = repo.create('project-a', input());
  repo.approve('project-a', first.id, 1);
  const next = repo.revise('project-a', first.id, 1, { ...input(), text: JSON.stringify({ ...artifact(), title: 'Revised' }) });
  assert.notEqual(next.id, first.id);
  assert.equal(next.revision, 2);
  assert.equal(next.state, 'draft');
  assert.notEqual(next.contentHash, first.contentHash);
  assert.equal(repo.list('project-a')[0].state, 'approved');
  assert.throws(() => repo.toTasks('project-a', next.id), /NOT_APPROVED/);
  assert.throws(() => repo.approve('project-a', first.id, 1), /REVISION_CONFLICT/);
  assert.throws(() => repo.revise('project-a', first.id, 1, input()), /REVISION_CONFLICT/);
  assert.throws(() => repo.approve('project-a', next.id, 1), /REVISION_CONFLICT/);
  assert.equal(repo.approve('project-a', next.id, 2).state, 'approved');
});

test('unapproved old revisions are superseded; independent plans have separate heads', () => {
  const repo = new InMemoryPlanningRepository();
  const first = repo.create('project-a', input());
  const secondPlan = repo.create('project-a', input());
  repo.revise('project-a', first.id, 1, input());
  assert.equal(repo.list('project-a')[0].state, 'superseded');
  assert.equal(repo.approve('project-a', secondPlan.id, 1).state, 'approved');
});

test('cross-project and path-like identifiers cannot access a stored version', () => {
  const repo = new InMemoryPlanningRepository();
  const saved = repo.create('project-a', input());
  for (const call of [() => repo.approve('project-b', saved.id, 1), () => repo.revise('project-b', saved.id, 1, input()), () => repo.toTasks('project-b', saved.id)]) assert.throws(call, /VERSION_NOT_FOUND/);
  assert.deepEqual(repo.list('project-b'), []);
  for (const id of ['', '../escape', 'C:\\private', '--option', 'a/b']) assert.throws(() => repo.create(id, input()), /INVALID_ID/);
});

test('invalid revision and failed revision input leave state intact; approval is idempotent', () => {
  const repo = new InMemoryPlanningRepository();
  const first = repo.create('project-a', input());
  for (const revision of [NaN, Infinity, -1, 0, 1.5]) assert.throws(() => repo.approve('project-a', first.id, revision), /REVISION_CONFLICT/);
  assert.throws(() => repo.revise('project-a', first.id, 1, { ...input(), text: '{' }), /INVALID_DRAFT/);
  assert.equal(repo.list('project-a').length, 1);
  assert.deepEqual(repo.approve('project-a', first.id, 1), repo.approve('project-a', first.id, 1));
});
