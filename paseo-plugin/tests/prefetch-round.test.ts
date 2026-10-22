import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrefetchRound } from '../client/prefetch-round.ts';
for(const size of [128,129,500]) test(`prewarming ${size} repositories finishes independently of cache eviction`,()=>{
  const round=createPrefetchRound(),keys=Array.from({length:size},(_,n)=>`repo-${n}`);
  round.reconcile('instance-1',keys,true);
  for(const key of keys){assert.equal(round.next(keys),key);round.complete(key,true);}
  assert.equal(round.next(keys),undefined);
  round.reconcile('instance-1',[...keys,'added'],true);assert.equal(round.next([...keys,'added']),'added');round.complete('added',false);
  round.reconcile('instance-1',[...keys,'added'],false);round.reconcile('instance-1',[...keys,'added'],true);assert.equal(round.next([...keys,'added']),'added');
  round.complete('added',true);round.reconcile('instance-2',keys,true);assert.equal(round.next(keys),keys[0]);
});
