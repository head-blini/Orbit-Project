import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectOutbound, createOutboundGuardrail } from '../server/guardrails/outbound.ts';
import { createProviderAdapters } from '../server/providers/connections.ts';

const ids = ['bedrock', 'litellm', 'vllm', 'freellmapi'] as const;
const policy = (action = 'mask', providerId = 'litellm') => ({
  destinationId: 'fixture', providerId, classification: 'external',
  endpoint: 'https://provider.example.test/v1', action,
});
const email = 'person@example.test';
const secret = 'api_key="synthetic-value-only"';

test('inspection exposes only kinds and UTF-16 ranges, including repeated and overlapping matches', () => {
  const input = `😀 ${email} ${email} 010-1234-5678 900101-1234567 ${secret}`;
  const findings = inspectOutbound(input);
  assert.equal(findings.filter(f => f.kind === 'email').length, 2);
  assert.equal(findings[0].start, 3);
  for (const f of findings) {
    assert.deepEqual(Object.keys(f).sort(), ['end', 'kind', 'start']);
    assert.ok(f.end > f.start && f.end <= input.length);
  }
  assert.ok(findings.some(f => f.kind === 'phone'));
  assert.ok(findings.some(f => f.kind === 'national_id'));
  assert.ok(findings.some(f => f.kind === 'credential'));
  assert.equal(JSON.stringify(findings).includes(email), false);
});

test('block, mask and explicit allow policies handle personal data; credentials always deny', () => {
  for (const action of ['block', 'mask', 'allow']) {
    const guard = createOutboundGuardrail([policy(action)]);
    assert.deepEqual(guard.evaluateOutbound('fixture', secret), {allowed:false, code:'CREDENTIAL_DETECTED'});
    const decision = guard.evaluateOutbound('fixture', email);
    if (action === 'block') assert.deepEqual(decision, {allowed:false, code:'PERSONAL_DATA_BLOCKED'});
    else assert.deepEqual(decision, {allowed:true, payload:action === 'mask' ? '[REDACTED]' : email});
    assert.deepEqual(guard.evaluateOutbound('fixture', 'ordinary text'), {allowed:true, payload:'ordinary text'});
  }
});

test('credential patterns are blocked for every action and local destinations too', () => {
  const samples = [secret, '"refresh_token": "synthetic"', 'Bearer synthetic',
    'sk-synthetic-fixture', 'AKIAABCDEFGHIJKLMNOP', 'ghp_syntheticfixture',
    'eyJfixture.payload.signature', '-----BEGIN RSA PRIVATE KEY-----', 'password = fixture',
    'AWS_SECRET_ACCESS_KEY=synthetic', 'AWS_SESSION_TOKEN=synthetic',
    'OPENAI_API_KEY=synthetic', 'LITELLM_API_KEY=synthetic'];
  for (const action of ['block', 'mask', 'allow']) {
    const guard = createOutboundGuardrail([{...policy(action), classification:'local', endpoint:'http://127.0.0.1:8000/v1'}]);
    for (const sample of samples) assert.deepEqual(guard.evaluateOutbound('fixture', sample), {allowed:false, code:'CREDENTIAL_DETECTED'});
  }
});

test('masking covers all overlapping spans and preserves surrounding text', () => {
  const guard = createOutboundGuardrail([policy()]);
  const input = 'Start 01012345678@example.test, 010-1234-5678, 900101-1234567; end';
  assert.deepEqual(guard.evaluateOutbound('fixture', input), {allowed:true, payload:'Start [REDACTED], [REDACTED], [REDACTED]; end'});
});

test('unknown destinations, non-text and oversized UTF-8 payloads fail closed', () => {
  const guard = createOutboundGuardrail([policy()]);
  for (const destination of ['missing', '__proto__', {}, null])
    assert.deepEqual(guard.evaluateOutbound(destination, email), {allowed:false, code:'UNKNOWN_DESTINATION'});
  for (const text of [null, {}, ['text'], 1])
    assert.deepEqual(guard.evaluateOutbound('fixture', text), {allowed:false, code:'INVALID_PAYLOAD'});
  assert.deepEqual(guard.evaluateOutbound('fixture', '한'.repeat(90000)), {allowed:false, code:'PAYLOAD_TOO_LARGE'});
  assert.deepEqual(createOutboundGuardrail([]).evaluateOutbound('fixture', 'text'), {allowed:false, code:'UNKNOWN_DESTINATION'});
});

test('invalid configuration fails closed, including duplicate destinations and endpoint tricks', () => {
  const invalid = [null, {}, {...policy(), action:'unknown'}, {...policy(), providerId:'codex'},
    {...policy(), classification:'unknown'}, {...policy(), injected:true},
    ...['http://provider.example.test', 'file:///tmp/file', 'https://user:pass@provider.example.test',
      'https://provider.example.test/?key=synthetic', 'https://provider.example.test/#fragment',
      'https://127.0.0.1', 'https://localhost', ' https://provider.example.test',
      'https://provider.example.test\\@evil.test', 'https://provider.example.test:99999',
      'https://provider.example.test/%0a'].map(endpoint => ({...policy(), endpoint})),
    {...policy(), classification:'local', endpoint:'http://127.1:8000'},
    {...policy(), classification:'local', endpoint:'https://external.example.test'},
  ];
  for (const entry of invalid)
    assert.deepEqual(createOutboundGuardrail([entry]).evaluateOutbound('fixture', 'safe'), {allowed:false, code:'INVALID_CONFIGURATION'});
  assert.deepEqual(createOutboundGuardrail([policy(), policy()]).evaluateOutbound('fixture', 'safe'), {allowed:false, code:'INVALID_CONFIGURATION'});
});

for (const id of ids) test(`${id}: only sanitized payload and exact server destination reach injected transport`, async () => {
  const calls: unknown[] = [];
  const configuration = policy('mask', id);
  const adapters = createProviderAdapters([configuration], {send:async request => {calls.push(request); return {text:'mock response'};}});
  configuration.endpoint = 'https://mutated.example.test';
  configuration.action = 'allow';
  const adapter = adapters[id];
  assert.equal(adapter.status, 'mock_only');
  assert.deepEqual(await adapter.send({destinationId:'fixture', text:email}), {ok:true, text:'mock response'});
  assert.deepEqual(calls, [{destinationId:'fixture', providerId:id, endpoint:policy().endpoint, payload:'[REDACTED]'}]);
});

test('rejection never calls transport, and payload cannot override destination policy', async () => {
  let calls = 0;
  const adapters = createProviderAdapters([policy('block')], {send:async () => {calls++; return {text:'ok'};}});
  const inputs = [null, {destinationId:'fixture', text:email}, {destinationId:'fixture', text:secret},
    {destinationId:'missing', text:'safe'}, {destinationId:'fixture', text:'safe', endpoint:'https://evil.test'},
    {destinationId:'fixture', text:'safe', action:'allow'}, {destinationId:'fixture', text:'safe', providerId:'bedrock'}];
  for (const input of inputs) assert.equal((await adapters.litellm.send(input)).ok, false);
  assert.deepEqual(await adapters.bedrock.send({destinationId:'fixture', text:'safe'}), {ok:false, code:'PROVIDER_MISMATCH'});
  assert.equal(calls, 0);
});

test('transport failures and invalid responses expose fixed codes without the underlying values', async () => {
  for (const send of [async () => {throw new Error(`${email} ${secret}`);}, async () => {throw email;},
    async () => ({text:42}), async () => null]) {
    const adapters = createProviderAdapters([policy()], {send:send as never});
    assert.deepEqual(await adapters.litellm.send({destinationId:'fixture', text:'safe'}), {ok:false, code:'PROVIDER_ERROR'});
  }
});

test('accessor input is rejected without executing it', async () => {
  let reads = 0;
  const input = {destinationId:'fixture', get text() {reads++; return email;}};
  const adapters = createProviderAdapters([policy()], {send:async () => ({text:'ok'})});
  assert.deepEqual(await adapters.litellm.send(input), {ok:false, code:'INVALID_REQUEST'});
  assert.equal(reads, 0);
});

test('maximum-size ordinary ASCII text is inspected without quadratic retries', {timeout:3000}, () => {
  const input = 'a'.repeat(256 * 1024);
  const started = performance.now();
  assert.deepEqual(inspectOutbound(input), []);
  assert.ok(performance.now() - started < 2000, 'maximum-size scan exceeded generous two-second bound');
});

test('invalid server policy configuration and oversize input never reach transport', async () => {
  let calls = 0;
  const transport = {send:async () => {calls++; return {text:'mock'};}};
  for (const configuration of [[{...policy(), action:'unknown'}], [policy(), policy()], [{...policy(), endpoint:'http://evil.test'}]]) {
    const adapters = createProviderAdapters(configuration, transport);
    assert.deepEqual(await adapters.litellm.send({destinationId:'fixture', text:'safe'}), {ok:false, code:'INVALID_CONFIGURATION'});
  }
  assert.deepEqual(await createProviderAdapters([policy()], transport).litellm.send({destinationId:'fixture', text:'x'.repeat(262145)}), {ok:false, code:'PAYLOAD_TOO_LARGE'});
  assert.equal(calls, 0);
});

test('local IPv4 and IPv6 literals work, and destination snapshots cannot be altered', () => {
  for (const endpoint of ['http://127.0.0.1:8000/v1', 'https://[::1]:8443/v1']) {
    const guard = createOutboundGuardrail([{...policy(), classification:'local', endpoint}]);
    const snapshot = guard.destination('fixture')!;
    assert.equal(Object.isFrozen(snapshot), true);
    assert.throws(() => Object.assign(snapshot, {action:'allow'}), TypeError);
    assert.deepEqual(guard.evaluateOutbound('fixture', email), {allowed:true, payload:'[REDACTED]'});
  }
});
