import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore shared runtime module
import { createRequestScheduler } from '../shared/request-scheduler.mjs';
const flush = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
test('deadlines respond once, retain running slots through cleanup, and never dispatch expired work', async () => {
  let time = 0, next = 0, calls = 0;
  const timers = new Map<number, () => void>(), replies: any[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const scheduler = createRequestScheduler({ concurrency: 1, now: () => time,
    schedule: (fn: () => void) => { timers.set(++next, fn); return next; }, unschedule: (id: number) => timers.delete(id) });
  scheduler.submit({ id: 1, deadline: 10, run: async (ctx: any) => { ctx.diagnose({phase:'rpc'}); await held; return 'late'; }, respond: (error: any, value: any) => replies.push({id:1,error,value}) });
  scheduler.submit({ id: 2, deadline: 10, run: () => { calls++; }, respond: (error: any) => replies.push({id:2,error}) });
  await flush(); time = 11; for (const fn of [...timers.values()]) fn();
  assert.equal(scheduler.health().active, 1);
  assert.equal(calls, 0);
  assert.match(replies.find(r=>r.id===1).error.message, /uncertain/);
  assert.match(replies.find(r=>r.id===2).error.message, /queue_timeout/);
  scheduler.submit({ id:3, control:true, deadline:20, run:()=> 'ping', respond: (_e:any,value:any)=>replies.push({id:3,value}) });
  await flush(); assert.equal(replies.find(r=>r.id===3).value,'ping');
  release(); await flush(); assert.equal(replies.filter(r=>r.id===1).length,1);
  assert.deepEqual(scheduler.health(),{active:0,queued:0}); scheduler.close();
});

test('queued cancellation and shutdown finish once without dispatching and bound control admission', async () => {
  const replies: any[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const scheduler = createRequestScheduler({concurrency:1,controlConcurrency:1,queueLimit:1});
  let invoked = 0;
  const submit = (id: number, control = false) => scheduler.submit({id,control,deadline:Date.now()+10000,
    run: async () => {invoked++;await held;}, respond:(error:any)=>replies.push({id,error})});
  submit(1);submit(2);submit(3);submit(4,true);submit(5,true);submit(6,true);
  await flush(); assert.equal(invoked,2);
  assert.match(replies.find(r=>r.id===3).error.message,/busy/);
  assert.match(replies.find(r=>r.id===6).error.message,/busy/);
  scheduler.cancel(2);scheduler.close();release();await flush();
  assert.equal(invoked,2); assert.equal(replies.length,6);
  assert.deepEqual(scheduler.health(),{active:0,queued:0});
});
