// Focused rendering smoke test. This is not a bundle or interactive browser test.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const parserUrl = new URL('../../../server/planning/parser.ts', import.meta.url);
const componentUrl = new URL('../../../web/planning/PlanningStudio.tsx', import.meta.url);
const parser = await transform(await readFile(parserUrl, 'utf8'), { loader: 'ts', format: 'esm', sourcefile: fileURLToPath(parserUrl) });
const component = await transform(await readFile(componentUrl, 'utf8'), { loader: 'tsx', format: 'esm', jsx: 'automatic', sourcefile: fileURLToPath(componentUrl) });
const componentCode = component.code
  .replace('import "./planning.css";', '')
  .replaceAll('"../../server/planning/parser.ts"', JSON.stringify(moduleUrl(parser.code)))
  .replaceAll('"react"', JSON.stringify(pathToFileURL(require.resolve('react')).href))
  .replaceAll('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve('react/jsx-runtime')).href));
const { PlanningStudio, PlanningPreview } = await import(moduleUrl(componentCode));
const hostile = '<script>synthetic()</script><img src="https://example.invalid/pixel" onerror="synthetic()">';
const markup = renderToStaticMarkup(createElement(PlanningPreview, { draft: {
  schemaVersion: '1.0', title: hostile, goal: hostile, source: 'import',
  requirements: [{ label: 'REQ-01', description: hostile, acceptanceCriteria: [hostile] }],
  constraints: [hostile], openQuestions: [hostile],
} }));
assert.ok(markup.includes('&lt;script&gt;'));
assert.doesNotMatch(markup, /<script|<img|<[^>]*\s(?:href|src|onerror)=/i);
assert.ok(markup.includes('Constraints'));
assert.ok(markup.includes('Open questions'));
const unavailable = async () => { throw new Error('Callbacks must not run during server rendering'); };
const studio = renderToStaticMarkup(createElement(PlanningStudio, {
  projectId: 'project-a', list: unavailable, create: unavailable, revise: unavailable, approve: unavailable, toTasks: unavailable,
}));
assert.match(studio, /Planning Studio/);
assert.match(studio, /Approve saved version/);
assert.match(studio, /Create task drafts/);
assert.match(studio, /aria-busy="true"/);
assert.ok([...studio.matchAll(/<button\b[^>]*>/g)].every(match => match[0].includes('disabled')));
console.log('PASS: TSX transform; inert preview HTML; provider-free initial UI; initial actions disabled. Interactive browser behavior and full bundling are not tested by this check.');
