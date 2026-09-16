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
