import test from 'node:test';
import assert from 'node:assert/strict';
import * as privacy from '../server/privacy.ts';

const credentials = [
  'AWS_SECRET_ACCESS_KEY=synthetic-fixture',
  'AWS_SESSION_TOKEN=synthetic-fixture',
  'OPENAI_API_KEY=synthetic-fixture',
  '"api_key":"synthetic-fixture"',
  'secret = synthetic-fixture',
  'ghp_SYNTHETICFIXTUREONLY',
  'glpat-SYNTHETICFIXTUREONLY',
  'sk-SYNTHETICFIXTUREONLY',
  'Bearer SYNTHETICFIXTUREONLY',
  'AKIASYNTHETICFIXTURE',
  'ASIASYNTHETICFIXTURE',
  'eyJSYNTHETIC.fixture.signature',
];

test('output masks credential forms accepted by the outbound detector and GitLab tokens', () => {
  for (const credential of credentials) {
    const text = privacy.safeText(`before ${credential} after`);
    assert.equal(text.includes('synthetic-fixture'), false);
    assert.equal(text.includes('SYNTHETICFIXTURE'), false);
    assert.equal(text.includes('eyJSYNTHETIC'), false);
    assert.ok(text.startsWith('before '));
    assert.ok(text.endsWith(' after'));
    assert.equal(privacy.containsCredential(credential), true);
  }
  assert.equal(privacy.safeText('normal answer'), 'normal answer');
});

test('PEM output masks the entire private key body, including unfinished blocks', () => {
  for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY']) {
    const start = `-----BEGIN ${label}-----\nSYNTHETIC_PRIVATE_BODY\n`;
    assert.equal(privacy.safeText(start), '[REDACTED]');
    assert.equal(privacy.safeText(`${start}-----END ${label}-----\nafter`), '[REDACTED]\nafter');
  }
});

test('cumulative stream snapshots never publish unfinished credential tokens or PEM bodies', () => {
  for (const credential of [...credentials, '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_BODY\n-----END PRIVATE KEY-----']) {
    const input = `before ${credential} after`;
    for (let end = 1; end <= input.length; end++) {
      const text = privacy.safeText(input.slice(0, end), false);
      assert.equal(text.includes('synthetic-fixture'), false);
      assert.equal(text.includes('SYNTHETICFIXTURE'), false);
      assert.equal(text.includes('SYNTHETIC_PRIVATE_BODY'), false);
    }
  }
});

test('raw item snapshots mask cross-item assignments and preserve unfinished interleaved tails', () => {
  const render=(privacy as unknown as {safeTextItems?:(items:readonly string[],final:boolean)=>string}).safeTextItems;
  assert.equal(typeof render, 'function');
  for(const final of [false,true]){
    assert.equal(render!(['AWS_SECRET_ACCESS_KEY=','synthetic-cross-item-secret '],final).includes('synthetic-cross-item-secret'),false);
    assert.equal(render!(['-----BEGIN PRIVATE KEY-----\n','SYNTHETIC_CROSS_ITEM_BODY\n-----END PRIVATE KEY-----\n'],final).includes('SYNTHETIC_CROSS_ITEM_BODY'),false);
  }
  assert.equal(render!(['AKIAAAAAAA','Other completed item'],false).includes('AKIAAAAAAA'),false);
  assert.equal(render!(['AKIA'+'A'.repeat(16)+'\n','Other completed item'],false).includes('AKIA'),false);
});

test('raw item snapshots retain cumulative fragments privately until their credential syntax is complete', () => {
  const render=(privacy as unknown as {safeTextItems?:(items:readonly string[],final:boolean)=>string}).safeTextItems;
  assert.equal(typeof render, 'function');
  let raw='';
  for (const delta of ['hello ', 'AWS_SECRET_', 'ACCESS_KEY=', 'synthetic-', 'fixture ', 'done']) {
    raw+=delta;
    assert.equal(render!([raw],false).includes('synthetic-'), false);
  }
  assert.equal(render!([raw],true), 'hello [REDACTED] done');
});

test('raw item snapshots bound the aggregate output and validate every item with fixed diagnostics', () => {
  const render=(privacy as unknown as {safeTextItems?:(items:readonly string[],final:boolean)=>string}).safeTextItems;
  assert.equal(typeof render, 'function');
  assert.ok(render!(['a '.repeat(40000),'b '.repeat(40000)],true).length<=64000);
  assert.ok(render!(['sk- '.repeat(20000)],true).length<=64000);
  assert.equal(render!(['a '.repeat(31997)+'AKIASYNTHETICFIXTURE'],true).includes('AKIA'),false);
  for(const invalid of [null,{},['safe',{}]])assert.throws(()=>render!(invalid as string[],true),/^Error: INVALID_OUTPUT_TEXT$/);
  const accessor=[] as string[];Object.defineProperty(accessor,0,{get(){throw new Error('SYNTHETIC_PRIVATE_DETAILS');}});
  assert.throws(()=>render!(accessor,true),/^Error: INVALID_OUTPUT_TEXT$/);
});

test('invalid output input produces a fixed diagnostic without inspecting input details', () => {
  const input = {toString(){throw new Error('SYNTHETIC_PRIVATE_DETAILS');}};
  assert.throws(() => privacy.safeText(input as unknown as string), /^Error: INVALID_OUTPUT_TEXT$/);
});
