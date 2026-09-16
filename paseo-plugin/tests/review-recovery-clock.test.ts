import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewRecoveryClock } from '../server/review-recovery-clock.ts';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('inactive reviews do not poll; an expired deadline fires once before fallback',async()=>{
  let ticks=0;const clock=new ReviewRecoveryClock(async()=>{ticks++;},200);
  await delay(60);assert.equal(ticks,0);
  clock.update('review',true,Date.now()-1);await delay(60);assert.equal(ticks,1);
  clock.update('review',false);await delay(230);assert.equal(ticks,1);clock.close();
});
test('a slow recovery tick is not overlapped',async()=>{
  let active=0,max=0;const clock=new ReviewRecoveryClock(async()=>{active++;max=Math.max(max,active);await delay(60);active--;},25);
  clock.update('review',true);await delay(180);clock.close();await delay(70);assert.equal(max,1);
});
