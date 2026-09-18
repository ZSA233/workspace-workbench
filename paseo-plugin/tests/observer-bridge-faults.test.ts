import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObserverBridge } from '../server/observer.ts';
async function fixture(reply: (socket:Socket)=>void) {
  const root=mkdtempSync(join(tmpdir(),'wb-bridge-')), path=join(root,'s.sock');
  let calls=0;const sockets=new Set<Socket>();
  const server=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('data',()=>{calls++;reply(socket);});});
  await new Promise<void>(r=>server.listen(path,r));
  const prior=process.env.WORKSPACE_WORKBENCH_SOCKET;process.env.WORKSPACE_WORKBENCH_SOCKET=path;
  const bridge=new ObserverBridge();
  return {bridge,sockets,calls:()=>calls,close:async()=>{bridge.close();for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));if(prior===undefined)delete process.env.WORKSPACE_WORKBENCH_SOCKET;else process.env.WORKSPACE_WORKBENCH_SOCKET=prior;rmSync(root,{recursive:true,force:true});}};
}
test('invalid JSON rejects immediately rather than settling before parsing and hanging forever',async()=>{
  const f=await fixture(socket=>socket.write('{broken\n'));
  try {await assert.rejects(f.bridge.call({method:'workspace.list',params:{}}), /invalid JSON/);assert.equal(f.calls(),1);}
  finally{await f.close();}
});
test('lost mutation response is uncertain and is never replayed',async()=>{
  const f=await fixture(socket=>socket.destroy());
  try {const response=await f.bridge.call({method:'workspace.create',params:{name:'test'}});assert.equal(response.ok,false);assert.equal(response.error?.code,'request_uncertain_retry_same_identity');assert.equal(f.calls(),1);}
  finally{await f.close();}
});
test('bridge shutdown aborts outstanding reads and releases sockets',async()=>{
  const f=await fixture(()=>{});
  try {const request=f.bridge.call({method:'workspace.list',params:{}});await new Promise(r=>setTimeout(r,10));f.bridge.close();await assert.rejects(request,/bridge closed/);await new Promise(r=>setTimeout(r,10));assert.equal(f.sockets.size,0);}
  finally{await f.close();}
});

test('a version change cannot be hidden by the bridge response TTL',async()=>{
  let generation=0;
  const f=await fixture(socket=>socket.write(JSON.stringify({ok:true,result:{generation:++generation}})+'\n'));
  try {
    const first=await f.bridge.call({method:'repository.diff',params:{workspaceId:'w',path:'file'}});
    const second=await f.bridge.call({method:'repository.diff',params:{workspaceId:'w',path:'file'}});
    assert.equal((first.result as {generation:number}).generation,1);
    assert.equal((second.result as {generation:number}).generation,2);
    assert.equal(f.calls(),2);
  } finally {await f.close();}
});

test('short bridge cache evicts old unique responses instead of retaining them indefinitely',async()=>{
  const f=await fixture(socket=>socket.write(JSON.stringify({ok:true,result:{observation:{state:'ready'},value:'x'.repeat(1024)}})+'\n'));
  try {
    for(let i=0;i<200;i++) await f.bridge.call({method:'workspace.list',params:{view:i}});
    const cache=(f.bridge as unknown as {cache:Map<string,unknown>}).cache;
    assert.ok(cache.size<=128);
    await new Promise(r=>setTimeout(r,1100));
    await f.bridge.call({method:'workspace.list',params:{view:'fresh'}});
    assert.equal(cache.size,1);
  } finally {await f.close();}
});

test('read admission rejects excess distinct queries while versions remain available',async()=>{
  const f=await fixture(socket=>{socket.write(JSON.stringify({ok:true,result:{revision:1}})+'\n');});
  try {
    // Hold distinct reads by delaying the fixture's next responses.
    const pending:Promise<unknown>[]=[];
    const original=(f.bridge as unknown as {request:(request:unknown,timeout:number)=>Promise<unknown>}).request.bind(f.bridge);
    (f.bridge as unknown as {request:(request:unknown,timeout:number)=>Promise<unknown>}).request=async(request,timeout)=>{
      if((request as {method:string}).method==='workspace.list') return new Promise(()=>{});
      return original(request,timeout);
    };
    for(let i=0;i<16;i++) pending.push(f.bridge.call({method:'workspace.list',params:{i}}));
    const busy=await f.bridge.call({method:'workspace.list',params:{i:17}});
    assert.equal(busy.error?.code,'observer_busy');
    const versions=await f.bridge.call({method:'observer.versions',params:{workspaceIds:['w']}});
    assert.equal(versions.ok,true);
    // The fixture owns unresolved fake requests; do not await them.
    assert.equal(pending.length,16);
  } finally {await f.close();}
});
