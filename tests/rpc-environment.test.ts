import test from 'node:test';
import assert from 'node:assert/strict';
import { Rpc } from '../server/rpc.ts';
import { buildChildEnv } from '../server/child-env.ts';

const blocked = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN', 'UNKNOWN_ORBIT_TEST_SECRET', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'OPENAI_BASE_URL', 'CODEX_API_BASE_URL', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES', 'SSL_CERT_FILE', 'GIT_CONFIG_COUNT', 'ORBIT_ALLOWED_PROJECTS',
  'AICC_CODEX_BIN', 'AICC_PORT', 'CODEX_UNSAFE_ALLOW_NO_SANDBOX'];

test('RPC child excludes unknown secrets and execution overrides while preserving auth discovery', async () => {
  const homeKeys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME'];
  const keys = [...blocked, ...homeKeys];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let rpc: Rpc | undefined;
  try {
    for (const key of blocked) process.env[key] = 'synthetic-fixture-only';
    // Valid Node option: the parent test runner is already running. A copied
    // environment would enable it in the real RPC child, without executing code.
    process.env.NODE_OPTIONS = '--no-warnings';
    // Avoid OS loader diagnostics in the probe; the pure policy test covers these.
    delete process.env.LD_PRELOAD; delete process.env.DYLD_INSERT_LIBRARIES;
    for (const key of homeKeys) process.env[key] = `fixture-location-${key}`;
    const script = `process.stdin.on('data', c => {
      const e = JSON.parse(c.toString());
      const blocked = ${JSON.stringify(blocked)};
      const homes = ${JSON.stringify(homeKeys)};
      const result = { leakedNames: blocked.filter(k => process.env[k] !== undefined),
        authLocationsPreserved: homes.every(k => process.env[k] === 'fixture-location-' + k) };
      process.stdout.write(JSON.stringify({id:e.id,result})+'\\n');
    });`;
    rpc = new Rpc(process.execPath, ['-e', script], process.cwd());
    const result = await rpc.request('environment/probe', {});
    assert.deepEqual(result.leakedNames, []);
    assert.equal(result.authLocationsPreserved, true);
    assert.equal(process.env.UNKNOWN_ORBIT_TEST_SECRET, 'synthetic-fixture-only');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rpc?.close();
  }
});

test('child environment copies only explicitly allowed own values without modifying the source', () => {
  const source = Object.assign(Object.create({ HOME: 'inherited-not-allowed' }), {
    PATH: 'fixture-bin', SYSTEMROOT: 'fixture-system', TMP: 'fixture-temp',
    USERPROFILE: 'fixture-profile', CODEX_HOME: 'fixture-codex', LANG: 'C.UTF-8',
    LC_ALL: '', LC_CTYPE: undefined,
    ...Object.fromEntries(blocked.map(key => [key, 'synthetic-fixture-only']))
  });
  Object.defineProperty(source, 'UNLISTED_SECRET', {enumerable:true, get() {throw new Error('Must not read secret values');}});
  Object.freeze(source);
  assert.deepEqual(buildChildEnv(source, 'win32'), {
    PATH:'fixture-bin', SYSTEMROOT:'fixture-system', TMP:'fixture-temp',
    USERPROFILE:'fixture-profile', CODEX_HOME:'fixture-codex', LANG:'C.UTF-8', LC_ALL:''
  });
  assert.deepEqual(buildChildEnv({}, 'win32'), {});
  assert.equal(source.GITHUB_TOKEN, 'synthetic-fixture-only');
});

test('Windows auth and runtime names are case-insensitive with one canonical key', () => {
  assert.deepEqual(buildChildEnv({Path:'bin', PATH:'bin', SystemRoot:'system',
    userprofile:'profile', codex_home:'codex', APPDATA:'app', LocalAppData:'local',
    openai_api_key:'fixture', nOdE_oPtIoNs:'fixture'}, 'win32'), {
    PATH:'bin', SYSTEMROOT:'system', USERPROFILE:'profile', CODEX_HOME:'codex', APPDATA:'app', LOCALAPPDATA:'local'
  });
});

test('conflicting Windows aliases fail closed without exposing values', () => {
  for (const [key, alias] of [['PATH','Path'], ['CODEX_HOME','codex_home']]) {
    assert.throws(() => buildChildEnv({[key]:'fixture-one', [alias]:'fixture-two'}, 'win32'),
      {message:'CHILD_ENV_CONFLICT'});
  }
});

test('non-Windows keys remain case-sensitive and undefined values are omitted', () => {
  assert.deepEqual(buildChildEnv({PATH:'bin', Path:'ignore', HOME:'home', home:'ignore',
    CODEX_HOME:undefined, LANG:'C', LD_PRELOAD:'fixture', DYLD_INSERT_LIBRARIES:'fixture'}, 'linux'),
    {PATH:'bin', HOME:'home', LANG:'C'});
});
