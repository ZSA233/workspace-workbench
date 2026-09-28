import test from 'node:test';
import assert from 'node:assert/strict';
import { BasicReads } from '../server/backend/basic-reads.ts';
import { Git } from '../server/backend/git.ts';

test('basic metadata consumers share computation and cancel independently', async () => {
  const original=Git.prototype.run, pool=new BasicReads();
  let commands=0, finish!:()=>void, signal:AbortSignal|undefined;
  Git.prototype.run=function(){commands++;signal=this.signal;return new Promise(resolve=>{finish=()=>resolve({stdout:'main\n',stderr:'',code:0,bytes:5,truncated:false});});};
  try {
    const first=new AbortController(),second=new AbortController();
    const a=pool.read('/fixture','version-1',['symbolic-ref','HEAD'],true,30000,first.signal);
    const b=pool.read('/fixture','version-1',['symbolic-ref','HEAD'],true,30000,second.signal);
    first.abort();await assert.rejects(a,/subscriber cancelled/);
    assert.equal(signal?.aborted,false);assert.equal(commands,1);
    finish();assert.equal((await b).stdout,'main\n');
  } finally {Git.prototype.run=original;await pool.close();}
});
