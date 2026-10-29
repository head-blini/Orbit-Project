#!/usr/bin/env node
// Orchestrator-only: select the tests a change set must re-run (lesson 2026-10-29).
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, normalize, relative} from 'node:path';

const MANDATORY_TRIGGERS = ['server/controller.ts', 'server/http.ts', 'server/main.ts', 'server/integration-queue.ts', 'server/task-completion.ts', 'server/worker-scheduler.ts', 'server/worker-spaces.ts', 'server/parallel-workers.ts', 'server/project-progress.ts', 'shared/task-completion.ts'];
const MANDATORY_TESTS = ['tests/worker-http.test.ts', 'tests/worker-scheduler.test.ts', 'tests/integration-queue.test.ts', 'tests/cqg-operational.test.ts', 'tests/task-completion.test.ts', 'tests/task-completion-wiring.test.ts'];

const args = process.argv.slice(2);
const opts = {base: '', head: 'HEAD', depth: 3, json: false, run: false, also: []};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--base') opts.base = args[++i];
  else if (a === '--head') opts.head = args[++i];
  else if (a === '--depth') opts.depth = Number(args[++i]);
  else if (a === '--also') opts.also.push(args[++i]);
  else if (a === '--json') opts.json = true;
  else if (a === '--run') opts.run = true;
  else { console.error(`unknown argument: ${a}`); process.exit(2); }
}
if (!opts.base || !opts.head || !Number.isInteger(opts.depth) || opts.depth < 1) {
  console.error('usage: select-regression.mjs --base <ref> [--head <ref>] [--depth N] [--also <test>]... [--json] [--run]');
  process.exit(2);
}

const git = (...a) => execFileSync('git', a, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
const root = git('rev-parse', '--show-toplevel').trim();
const changed = git('diff', '--name-only', `${opts.base}...${opts.head}`).split('\n').filter(Boolean).sort();
const files = git('ls-files', '--', '*.ts', '*.tsx').split('\n').filter((f) => /^(server|shared|web|tests)\//.test(f) && existsSync(join(root, f)));
const isTest = (f) => f.startsWith('tests/') && f.endsWith('.test.ts');
const tests = files.filter(isTest);
const text = new Map(files.map((f) => [f, readFileSync(join(root, f), 'utf8')]));

// Reverse import graph from a simple regex scan (static, side-effect and dynamic imports).
// shortcut: regex scan misses computed specifiers; upgrade to a real parser if that bites.
const importers = new Map();
const spec = /(?:from\s*|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g;
for (const f of files) {
  for (const m of text.get(f).matchAll(spec)) {
    const target = normalize(join(dirname(f), m[1])).split('\\').join('/');
    if (!importers.has(target)) importers.set(target, new Set());
    importers.get(target).add(f);
  }
}

const reasons = new Map();
const add = (t, r) => { if (!reasons.has(t)) reasons.set(t, []); if (!reasons.get(t).includes(r)) reasons.get(t).push(r); };

for (const f of changed) if (isTest(f) && existsSync(join(root, f))) add(f, 'changed');

const sources = changed.filter((f) => /^(server|shared|web)\/.+\.tsx?$/.test(f));
for (const src of sources) {
  const seen = new Set([src]);
  let frontier = [src];
  for (let hop = 1; hop <= opts.depth && frontier.length; hop++) {
    const next = [];
    for (const n of frontier) for (const imp of importers.get(n) ?? []) {
      if (seen.has(imp)) continue;
      seen.add(imp);
      if (isTest(imp)) add(imp, `imports ${src} (${hop} hop${hop > 1 ? 's' : ''})`);
      else next.push(imp);
    }
    frontier = next;
  }
}
for (const src of sources) {
  const base = src.split('/').pop();
  for (const t of tests) if (text.get(t).includes(base)) add(t, `references ${base}`);
}
const trigger = changed.find((f) => MANDATORY_TRIGGERS.includes(f));
if (trigger) for (const t of MANDATORY_TESTS) if (existsSync(join(root, t))) add(t, `mandatory set (${trigger} changed)`);
for (const t of opts.also) add(normalize(relative(root, join(process.cwd(), t))).split('\\').join('/'), '--also');

const selected = [...reasons.keys()].sort();
if (opts.json) console.log(JSON.stringify({changed, tests: selected, reasons: Object.fromEntries(selected.map((t) => [t, reasons.get(t)]))}, null, 2));
else if (selected.length) console.log(selected.join('\n'));
if (opts.run) {
  if (!selected.length) process.exit(0);
  const r = spawnSync('node', ['--test', ...selected], {cwd: root, stdio: opts.json ? ['ignore', 2, 2] : 'inherit'});
  process.exit(r.status ?? 1);
}
