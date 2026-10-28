import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Offline projections from the installed CLI, not a live App Server transcript.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/codex-0.162.1-model-schema.json', import.meta.url), 'utf8'));
const schema = (name: string) => fixture.schemas[name].projection;

test('Codex 0.162.1 schema projections retain reproducible generated-source provenance', () => {
  assert.equal(fixture.cliVersion, '0.162.1');
  for (const [name, entry] of Object.entries(fixture.schemas) as Array<[string, any]>) {
    assert.match(entry.source.jsonSha256, /^[a-f0-9]{64}$/);
    assert.match(entry.source.typescriptSha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.source.typescriptFile, `v2/${name}.ts`);
    const projection = entry.projection;
    if (projection.properties) {
      for (const key of Object.keys(projection.properties)) assert.ok(projection.propertyNames.includes(key));
      for (const key of projection.required ?? []) assert.ok(projection.propertyNames.includes(key));
    }
  }
});

test('catalog, requested override and server thread configuration are distinct contracts', () => {
  assert.equal(schema('ModelListResponse').properties.data.items.$ref, '#/definitions/Model');
  assert.equal(schema('Model').properties.model.type, 'string');
  assert.match(schema('TurnStartParams').properties.model.description, /Override the model for this turn and subsequent turns/);
  assert.ok(!schema('TurnStartParams').required.includes('model'));
  for (const name of ['ThreadStartResponse', 'ThreadResumeResponse']) {
    assert.equal(schema(name).properties.model.type, 'string');
    assert.equal(schema(name).properties.modelProvider.type, 'string');
  }
  assert.equal(schema('ThreadReadResponse').properties.thread.$ref, '#/definitions/Thread');
  assert.deepEqual(schema('Thread').properties.model.type, ['string', 'null']);
  assert.match(schema('Thread').properties.model.description, /not per-turn execution telemetry/);
  assert.equal(schema('Thread').properties.sessionId.type, 'string');
  assert.equal(schema('ThreadSettingsUpdatedNotification').properties.threadSettings.$ref, '#/definitions/ThreadSettings');
});

test('turn start, completion and persisted history contain no per-turn model attribution', () => {
  for (const name of ['TurnStartResponse', 'TurnStartedNotification', 'TurnCompletedNotification']) {
    assert.equal(schema(name).properties.turn.$ref, '#/definitions/Turn');
    assert.ok(!schema(name).propertyNames.includes('model'));
  }
  assert.equal(schema('Thread').properties.turns.items.$ref, '#/definitions/Turn');
  assert.ok(!schema('Turn').propertyNames.includes('model'));
  assert.ok(!schema('Turn').propertyNames.includes('modelProvider'));
  assert.equal(schema('Turn').properties.id.type, 'string');
});

test('routing, cyber verification and raw usage events do not establish final execution model', () => {
  for (const name of ['ModelReroutedNotification', 'ModelVerificationNotification', 'ModelSafetyBufferingUpdatedNotification', 'RawResponseCompletedNotification']) {
    assert.equal(schema(name).properties.threadId.type, 'string');
    assert.equal(schema(name).properties.turnId.type, 'string');
  }
  assert.equal(schema('ModelReroutedNotification').properties.toModel.type, 'string');
  assert.deepEqual(schema('ModelVerification').enum, ['trustedAccessForCyber']);
  assert.equal(schema('ModelSafetyBufferingUpdatedNotification').properties.model.type, 'string');
  assert.ok(!schema('RawResponseCompletedNotification').propertyNames.includes('model'));
  assert.match(schema('RawResponseCompletedNotification').description, /Internal-only/);
  assert.ok(!schema('ResponseUsageMetadata').propertyNames.includes('model'));
});
