import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient } from './rpc.mjs';

test('stdio framing handles split lines, interleaved server requests and response correlation', async () => {
  const script = `let b=''; process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){const x=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(x.method){process.stdout.write(JSON.stringify({id:9,method:'item/fileChange/requestApproval',params:{}})+'\\n'); const r=JSON.stringify({id:x.id,result:{ok:true}})+'\\n';process.stdout.write(r.slice(0,4));setTimeout(()=>process.stdout.write(r.slice(4)),5);}else if(x.id===9 && x.result.decision!=='decline')process.exit(2);}});`;
  const c = new RpcClient(process.execPath,['-e',script]);
  try { assert.deepEqual(await c.request('fixture',{}),{ok:true}); assert.equal(c.requestCount,1); }
  finally { await c.close(); }
});
test('process exit rejects pending RPC instead of reporting successful completion', async () => {
  const c = new RpcClient(process.execPath,['-e',"process.stdin.once('data',()=>process.exit(7))"]);
  await assert.rejects(c.request('fixture',{}),/transport closed/);
  assert.equal((await c.close()).code,7);
});
test('RPC timeout is bounded', async () => {
  const c = new RpcClient(process.execPath,['-e',"process.stdin.resume()"]);
  try { await assert.rejects(c.request('fixture',{},40),/timeout/); }
  finally { await c.close(); }
});
