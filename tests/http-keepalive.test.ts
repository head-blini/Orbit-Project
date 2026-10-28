import test from 'node:test';
import assert from 'node:assert/strict';
import {createHttpServer} from '../server/http.ts';
import type {Controller} from '../server/controller.ts';
import {Store} from '../server/store.ts';

// Root cause of the intermittent "fetch failed / ECONNRESET" in heavy HTTP tests: a synchronous
// stall (e.g. git) longer than Node's default 5 s keep-alive lets the server close an idle socket
// exactly when the client reuses it. Full-suite measurements showed 7-15 s stalls in those files.
test('idle keep-alive connections outlive the synchronous stalls observed in the server process',async()=>{
  const store=new Store(':memory:');
  const server=createHttpServer({store,snapshot:()=>({provider:'disconnected'})} as unknown as Controller,'unused');
  try{
    assert.ok(server.keepAliveTimeout>=60_000,`keepAliveTimeout ${server.keepAliveTimeout}`);
    // Request limits stay unchanged: slow or incomplete requests are still cut off.
    assert.equal(server.requestTimeout,15_000);assert.equal(server.headersTimeout,10_000);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
    assert.equal((await fetch(origin+'/api/session')).status,200);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5_500); // stall past the old 5 s default
    assert.equal((await fetch(origin+'/api/session')).status,200);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});
