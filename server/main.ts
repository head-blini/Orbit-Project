import { mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
import { createWorkspace, assertWorkspace } from './workspace.ts';
import { Controller } from './controller.ts';
import { codexFactory } from './codex.ts';
import { createHttpServer } from './http.ts';
import { acquireInstance } from './instance.ts';

const dataDir=resolve('.local');mkdirSync(dataDir,{recursive:true});
const port=Number(process.env.AICC_PORT??4317);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('AICC_PORT must be 1024..65535');
if(!existsSync(resolve('dist/index.html')))throw new Error('Run npm run build first');
const release=acquireInstance(join(dataDir,'instance.sqlite'));
const store=new Store(join(dataDir,'control-center.sqlite'));
let workspace=store.getMeta('workspace');
if(!workspace){workspace=createWorkspace(tmpdir());store.setMeta('workspace',workspace);}
try{assertWorkspace(workspace);}catch{store.close();throw new Error('The disposable workspace was removed or changed. See README recovery instructions.');}
const controller=new Controller(store,workspace,codexFactory(workspace));
const server=createHttpServer(controller,resolve('dist'));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await controller.close();store.close();release();}
server.on('error',()=>{console.error('Local server could not bind. Check AICC_PORT and whether another instance is running.');void controller.close().finally(()=>{store.close();release();process.exitCode=1;});});
process.on('SIGINT',()=>{void stop();});process.on('SIGTERM',()=>{void stop();});
server.listen(port,'127.0.0.1',()=>console.log(`AI Coding Control Center: http://127.0.0.1:${port} (read-only test workspace)`));
