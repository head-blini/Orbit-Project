// No inference: inspect only the public account status, never credential files.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RpcClient } from './rpc.mjs';
const entry=process.argv[2];
if(!entry) throw new Error('Pass the installed codex.js entry');
const schema=JSON.parse(readFileSync('.phase0-schema/v2/GetAccountResponse.json','utf8'));
const knownPlans=schema.definitions.PlanType.enum;
const c=new RpcClient(process.execPath,[entry,'app-server','--listen','stdio://']);
const result={timestamp:new Date().toISOString()};
try {
  await c.initialize();
  const r=await c.request('account/read',{refreshToken:false});
  result.authType=r.account?.type==='chatgpt'?'chatgpt':'unknown';
  result.planType=knownPlans.includes(r.account?.planType)?r.account.planType:'unknown';
} finally { result.processExit=await c.close(); }
writeFileSync(resolve('spikes/phase0/account-evidence.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
