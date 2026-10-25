import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['web/main.tsx'],bundle:true,outfile:'dist/app.js',platform:'browser',format:'esm',target:'es2022',minify:true,define:{'process.env.NODE_ENV':'"production"'},logLevel:'info'});
await copyFile('web/index.html','dist/index.html');
