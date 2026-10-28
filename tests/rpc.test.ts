import test from 'node:test';
import assert from 'node:assert/strict';
import { Rpc, denyRequest } from '../server/rpc.ts';

test('production stdio parser correlates split responses and denies server approvals',async()=>{
  const script=`let b='';process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){const e=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(e.method==='fixture'){process.stdout.write(JSON.stringify({id:'approval',method:'item/commandExecution/requestApproval',params:{command:'not logged'}})+'\\n');const s=JSON.stringify({id:e.id,result:{ok:true}})+'\\n';process.stdout.write(s.slice(0,4));setTimeout(()=>process.stdout.write(s.slice(4)),5);}else if(e.id==='approval'){setTimeout(()=>process.stdout.write(JSON.stringify({method:'fixture/decision',params:{decision:e.result.decision}})+'\\n'),20);}}});`;
  const rpc=new Rpc(process.execPath,['-e',script],process.cwd());
  assert.equal(rpc.evidenceSource,undefined,'generic subprocess transport is not native-provider evidence');
  const notification=new Promise<any>(r=>rpc.once('notification',r));
  try{assert.deepEqual(await rpc.request('fixture',{}),{ok:true});assert.equal((await notification).params.decision,'decline');}
  finally{await rpc.close();}
});
test('malformed stdout closes transport and rejects pending requests without leaking raw text',async()=>{
  const rpc=new Rpc(process.execPath,['-e',"process.stdin.on('data',()=>process.stdout.write('private invalid JSON\\n'))"],process.cwd());
  await assert.rejects(rpc.request('fixture',{}),{message:'TRANSPORT_CLOSED'});await rpc.close();
});
test('production RPC timeout and unknown requests fail closed',async()=>{
  const rpc=new Rpc(process.execPath,['-e','process.stdin.resume()'],process.cwd(),50);
  try{await assert.rejects(rpc.request('fixture',{}),{message:'RPC_TIMEOUT'});}finally{await rpc.close();}
  assert.deepEqual(denyRequest({id:1,method:'item/permissions/requestApproval'}),{id:1,result:{permissions:{},scope:'turn'}});
  assert.equal((denyRequest({id:2,method:'unknown'}) as any).error.code,-32601);
});
