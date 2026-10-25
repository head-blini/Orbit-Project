import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Separate bundle check: the application's existing entry does not import this UI yet.
await build({
  absWorkingDir:fileURLToPath(new URL('../../../',import.meta.url)),
  entryPoints:['web/visualization/index.tsx'],
  bundle:true,write:false,outdir:'tests/fixtures/visualization/build',
  platform:'browser',format:'esm',target:'es2022',
  define:{'process.env.NODE_ENV':'"production"'},logLevel:'info',
});
console.log('Visualization browser bundle verified in memory.');
