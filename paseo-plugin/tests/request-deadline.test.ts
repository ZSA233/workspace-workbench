import test from 'node:test';
import assert from 'node:assert/strict';
import { response } from '../server/backend/transport.ts';
import type { Service } from '../server/backend/service.ts';
import { boundedDeadline, remainingMs } from '../shared/request-deadline.mjs';

test('nested budgets never extend an upstream deadline', () => {
  assert.equal(boundedDeadline(120, 80, 100),120);
  assert.equal(remainingMs(120,5,100),15);
  assert.equal(remainingMs(120,5,130),0);
});

test('backend refuses expired reads and passes only remaining read time to observation', async () => {
  const calls: any[] = [];
  const service = {handle: async (...args: any[]) => {calls.push(args);return {};}} as unknown as Service;
  const expired = await response(service,JSON.stringify({id:'expired',method:'workspace.detail',deadline:Date.now()-1}));
  assert.equal(expired.ok,false); assert.equal(calls.length,0);
  assert.equal(expired.error.code,'observation_timeout');
  await response(service,JSON.stringify({id:'valid',method:'workspace.detail',deadline:Date.now()+1000,params:{observationBudgetMs:5000}}));
  assert.ok(calls[0][1].observationBudgetMs<=1000);
  await response(service,JSON.stringify({id:'legacy',method:'workspace.detail',params:{observationBudgetMs:5000}}));
  assert.equal(calls[1][1].observationBudgetMs,5000);
});
