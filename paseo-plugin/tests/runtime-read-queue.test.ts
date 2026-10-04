import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeReadQueue } from '../server/backend/runtime-read-queue.ts';
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};

test('environment reads share work while cancellation belongs to each consumer',async()=>{
 const queue=new RuntimeReadQueue(),work=gate(),started=gate(),a=new AbortController();let reads=0;
 const run=async()=>{reads++;started.release();await work.promise;return 7;};
 const first=queue.read('same',Date.now()+5000,a.signal,run).catch(error=>error);
 const second=queue.read('same',Date.now()+5000,undefined,run);
 await started.promise;a.abort();await first;assert.equal(reads,1);work.release();assert.equal(await second,7);await queue.close();
});

test('environment admission is bounded and cancelled queued work never runs',async()=>{
 const queue=new RuntimeReadQueue(),work=gate(),started=gate();let running=0,ranQueued=false;
 const run=async()=>{if(++running===2)started.release();await work.promise;};
 const active=[queue.read('one',Date.now()+5000,undefined,run),queue.read('two',Date.now()+5000,undefined,run)];
 await started.promise;const abort=new AbortController();
 const cancelled=queue.read('cancel',Date.now()+5000,abort.signal,async()=>{ranQueued=true;}).catch(error=>error);
 const waiting=Array.from({length:31},(_,i)=>queue.read(`pending-${i}`,Date.now()+5000,undefined,async()=>{}).catch(error=>error));
 await assert.rejects(queue.read('overflow',Date.now()+5000,undefined,async()=>{}),/busy/);
 assert.deepEqual(queue.health(),{active:2,queued:32});abort.abort();await cancelled;
 work.release();await Promise.all([...active,...waiting]);assert.equal(ranQueued,false);await queue.close();
});

test('environment shutdown stops admission and waits for active cleanup',async()=>{
 const queue=new RuntimeReadQueue(),work=gate(),started=gate();let cleaned=false;
 const read=queue.read('active',Date.now()+5000,undefined,async()=>{started.release();await work.promise;cleaned=true;}).catch(()=>{});
 await started.promise;let closed=false;const closing=queue.close().then(()=>{closed=true;});await read;
 assert.equal(closed,false);work.release();await closing;assert.equal(cleaned,true);
});
