import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

const script = join(import.meta.dirname, '..', 'scripts', 'orchestrator', 'select-regression.mjs');

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'regsel-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {cwd: dir, encoding: 'utf8'});
  const write = (m: Record<string, string>) => { for (const [f, c] of Object.entries(m)) { mkdirSync(dirname(join(dir, f)), {recursive: true}); writeFileSync(join(dir, f), c); } };
  git('init', '-q', '-b', 'main');
  write(files);
  git('add', '.'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  return {
    dir, base,
    change(m: Record<string, string>) { write(m); git('add', '.'); git('commit', '-q', '-m', 'change'); },
    select(...extra: string[]) {
      const out = execFileSync('node', [script, '--base', base, ...extra], {cwd: dir, encoding: 'utf8'});
      return out.split('\n').filter(Boolean);
    },
    cleanup() { rmSync(dir, {recursive: true, force: true}); },
  };
}

const base = {
  'server/a.ts': 'export const a=1;\n',
  'server/b.ts': "import {a} from './a.ts';\nexport const b=a;\n",
  'server/c.ts': "import {b} from './b.ts';\nexport const c=b;\n",
  'server/d.ts': "import {c} from './c.ts';\nexport const d=c;\n",
  'server/unrelated.ts': 'export const u=1;\n',
  'shared/s.ts': 'export const s=1;\n',
  'server/integration-queue.ts': 'export const q=1;\n',
  'tests/direct.test.ts': "import {a} from '../server/a.ts';\n",
  'tests/trans2.test.ts': "import {c} from '../server/c.ts';\n",
  'tests/trans4.test.ts': "import {d} from '../server/d.ts';\n",
  'tests/dyn.test.ts': "const s = await import('../shared/s.ts');\n",
  'tests/reads.test.ts': "readFileSync(new URL('../server/integration-queue.ts', import.meta.url));\n",
  'tests/worker-http.test.ts': "// standalone\n",
  'tests/other.test.ts': "import {u} from '../server/unrelated.ts';\n",
  'tests/changed.test.ts': '// v1\n',
};

test('a: changed test file selected', () => {
  const f = fixture(base);
  try { f.change({'tests/changed.test.ts': '// v2\n'}); assert.deepEqual(f.select(), ['tests/changed.test.ts']); } finally { f.cleanup(); }
});

test('b: direct, dynamic and transitive importers; depth limit', () => {
  const f = fixture(base);
  try {
    f.change({'server/a.ts': 'export const a=2;\n'});
    // a <- b <- c <- d: trans2 is 3 hops, trans4 is 4 hops
    assert.deepEqual(f.select(), ['tests/direct.test.ts', 'tests/trans2.test.ts']);
    assert.deepEqual(f.select('--depth', '1'), ['tests/direct.test.ts']);
    assert.deepEqual(f.select('--depth', '4'), ['tests/direct.test.ts', 'tests/trans2.test.ts', 'tests/trans4.test.ts']);
    f.change({'shared/s.ts': 'export const s=2;\n'});
    assert.ok(f.select().includes('tests/dyn.test.ts'));
  } finally { f.cleanup(); }
});

test('c: tests reading a changed source by basename', () => {
  const f = fixture({...base, 'server/integration-queue.ts': 'export const q=1;\n'});
  try {
    f.change({'server/integration-queue.ts': 'export const q=2;\n'});
    assert.ok(f.select().includes('tests/reads.test.ts'));
  } finally { f.cleanup(); }
});

for (const ext of ['ts', 'tsx']) test(`web .${ext}: static imports, dynamic view helper, transitive imports and depth`, () => {
  const source = `web/component.${ext}`;
  const f = fixture({
    ...base,
    [source]: 'export const component=1;\n',
    'web/panel.tsx': `export {component} from './component.${ext}';\n`,
    'server/bridge.ts': "export {component} from '../web/panel.tsx';\n",
    'shared/bridge.ts': "export {component} from '../server/bridge.ts';\n",
    'tests/web-direct.test.ts': `import {component} from '../web/component.${ext}';\n`,
    'tests/web-dynamic.test.ts': `async function view(){return await import('../web/component.${ext}');}\nawait view();\n`,
    'tests/web-transitive.test.ts': "import {component} from '../web/panel.tsx';\n",
    'tests/web-cross.test.ts': "import {component} from '../shared/bridge.ts';\n",
  });
  try {
    f.change({[source]: 'export const component=2;\n'});
    assert.deepEqual(f.select('--depth', '1'), ['tests/web-direct.test.ts', 'tests/web-dynamic.test.ts']);
    assert.deepEqual(f.select(), ['tests/web-direct.test.ts', 'tests/web-dynamic.test.ts', 'tests/web-transitive.test.ts']);
    assert.deepEqual(f.select('--depth', '4'), ['tests/web-cross.test.ts', 'tests/web-direct.test.ts', 'tests/web-dynamic.test.ts', 'tests/web-transitive.test.ts']);
    const json = JSON.parse(execFileSync('node', [script, '--base', f.base, '--json'], {cwd: f.dir, encoding: 'utf8'}));
    for (const name of ['direct', 'dynamic']) assert.ok(json.reasons[`tests/web-${name}.test.ts`].includes(`imports ${source} (1 hop)`));
  } finally { f.cleanup(); }
});

test('web basename references select tests without imports; unrelated web source selects nothing', () => {
  const f = fixture({
    ...base,
    'web/component.tsx': 'export const component=1;\n',
    'web/unused.tsx': 'export const unused=1;\n',
    'tests/web-reads.test.ts': "readFileSync(new URL('../web/component.tsx', import.meta.url));\n",
  });
  try {
    f.change({'web/unused.tsx': 'export const unused=2;\n'});
    assert.deepEqual(f.select(), []);
    f.change({'web/component.tsx': 'export const component=2;\n'});
    assert.deepEqual(f.select(), ['tests/web-reads.test.ts']);
  } finally { f.cleanup(); }
});

test('d: mandatory set for gate files, only existing tests', () => {
  const f = fixture(base);
  try {
    f.change({'server/integration-queue.ts': 'export const q=2;\n'});
    const out = f.select();
    assert.ok(out.includes('tests/worker-http.test.ts'));
    assert.ok(!out.includes('tests/worker-scheduler.test.ts'));
    const json = JSON.parse(execFileSync('node', [script, '--base', f.base, '--json'], {cwd: f.dir, encoding: 'utf8'}));
    assert.deepEqual(json.changed, ['server/integration-queue.ts']);
    assert.match(json.reasons['tests/worker-http.test.ts'][0], /mandatory/);
  } finally { f.cleanup(); }
});

test('--also appends and never shrinks; unrelated change selects nothing extra', () => {
  const f = fixture(base);
  try {
    f.change({'web/readme.txt': 'x\n'});
    assert.deepEqual(f.select(), []);
    assert.deepEqual(f.select('--also', 'tests/other.test.ts'), ['tests/other.test.ts']);
    f.change({'server/a.ts': 'export const a=3;\n'});
    assert.deepEqual(f.select('--also', 'tests/other.test.ts'), ['tests/direct.test.ts', 'tests/other.test.ts', 'tests/trans2.test.ts']);
  } finally { f.cleanup(); }
});
