// Exercise the standalone UI entrypoint independently of web/main.tsx; write no build artifacts.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const result = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: [fileURLToPath(new URL('web/planning/index.tsx', root))],
  tsconfig: fileURLToPath(new URL('tsconfig.json', root)),
  bundle: true, write: false,
  outdir: fileURLToPath(new URL('web/planning/build-check', root)),
  platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'info',
});
console.log('Planning browser bundle:', result.outputFiles.map(file => ({ bytes: file.contents.length })));
