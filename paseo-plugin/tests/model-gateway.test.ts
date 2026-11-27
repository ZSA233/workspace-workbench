import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {ModelGateway,withModelContext} from '../server/organizer/model-gateway.ts';
import {OrganizerModelQueue} from '../server/organizer/model-queue.ts';
import {ModelMetrics} from '../server/organizer/model-metrics.ts';
import {modelProfileSchema} from '../shared/organizer.ts';
const profile=modelProfileSchema.parse({id:'local',name:'local',baseUrl:'http://127.0.0.1:1',model:'local'});
const input={kind:'session',owner:'native',prompt:'task',input:'material'};
const pause=()=>new Promise(r=>setTimeout(r,5));
test('one host queue prioritizes manual work, bounds concurrency and removes cancelled waiters',async()=>{
 const queue=new OrganizerModelQueue(()=>1),order:string[]=[];let release!:()=>void;
 const first=queue.run(()=>new Promise<void>(r=>release=r));await pause();
 const background=queue.run(async()=>{order.push('background');},{priority:2}),manual=queue.run(async()=>{order.push('manual');},{priority:0}),abort=new AbortController();
 const cancelled=queue.run(async()=>{assert.fail('cancelled work ran');},{signal:abort.signal});abort.abort();await assert.rejects(cancelled,/cancelled/);assert.equal(queue.status().running,1);assert.equal(queue.status().waiting,2);
 release();await Promise.all([first,background,manual]);assert.deepEqual(order,['manual','background']);await queue.idle();
});
test('identical local requests share one producer and cancelling one subscriber preserves the other',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wb-model-gateway-')),gateway=new ModelGateway(root,()=>1);let calls=0,release!:()=>void;
 const a=new AbortController(),b=new AbortController(),work=async()=>{calls++;await new Promise<void>(r=>release=r);return{title:'result'};};
 try{const first=withModelContext({gateway,trigger:'automatic'},()=>gateway.run(profile,'',input,a.signal,work)),second=withModelContext({gateway,trigger:'preview'},()=>gateway.run(profile,'',input,b.signal,work));await pause();assert.equal(calls,1);a.abort();await assert.rejects(first,/cancelled/);release();assert.deepEqual(await second,{title:'result'});assert.equal(gateway.metrics.summary().today.reused,1);}
 finally{await gateway.close();rmSync(root,{recursive:true,force:true});}
});
test('retry cooldowns persist, manual retry is explicit and output failures do not loop',()=>{
 const root=mkdtempSync(join(tmpdir(),'wb-model-metrics-'));let now=Date.UTC(2026,0,1,12);const metrics=new ModelMetrics(root,()=>now);
 try{metrics.failure('input','connection',Error('The operation was aborted due to timeout'));assert.throws(()=>metrics.gate('input','connection',false),/cooling/);now+=60_001;assert.throws(()=>new ModelMetrics(root,()=>now).gate('input','connection',false),/backoff/);metrics.gate('input','connection',true);now+=300_000;metrics.gate('input','connection',false);metrics.failure('input','connection',Error('organizer_model_evidence_invalid'));assert.throws(()=>metrics.gate('input','connection',false),/paused/);metrics.success('input','connection');metrics.gate('input','connection',false);}
 finally{rmSync(root,{recursive:true,force:true});}
});
test('real POST attempts are counted once and rolling-hour counts exclude the earlier part of an hour',()=>{
 const root=mkdtempSync(join(tmpdir(),'wb-model-counts-'));let now=Date.UTC(2026,0,1,12,45);const metrics=new ModelMetrics(root,()=>now),at=(hour:number,minute:number)=>new Date(Date.UTC(2026,0,1,hour,minute)).toISOString();
 try{for(const [id,stamp]of [['old',at(11,10)],['current',at(12,5)]]){const run={id,at:stamp,requestedAt:stamp,kind:'session' as const,owner:'native',profileId:'local',model:'local',prompt:'',input:'',truncated:false};metrics.record(run,'key',{trigger:'automatic'},0);metrics.record({...run,finishedAt:stamp,state:'complete'},'key',{trigger:'automatic'},0);metrics.record({...run,finishedAt:stamp,state:'complete'},'key',{trigger:'automatic'},0);}const summary=metrics.summary();assert.equal(summary.lastHour.requests,1);assert.equal(summary.lastHour.complete,1);assert.equal(summary.today.requests,2);assert.equal(summary.today.complete,2);}
 finally{rmSync(root,{recursive:true,force:true});}
});
test('reloading retains unknown POST outcomes and cools the original input before replay',()=>{
 const root=mkdtempSync(join(tmpdir(),'wb-model-recover-'));let now=Date.UTC(2026,0,1,12,59);const metrics=new ModelMetrics(root,()=>now),stamp=new Date(now).toISOString();
 try{metrics.record({id:'pending',at:stamp,requestedAt:stamp,kind:'session',owner:'native',profileId:'local',prompt:'',input:'',truncated:false},'request',{trigger:'automatic'},0,'business','connection');now+=120000;new ModelMetrics(root,()=>now).recover();const result=metrics.summary();assert.equal(result.hours['2026-01-01T12'].unknown,1);assert.equal(result.hours['2026-01-01T13'].unknown,0);assert.throws(()=>metrics.gate('business','connection',false),/cooling/);now+=60001;assert.throws(()=>metrics.gate('business','connection',false),/backoff/);metrics.gate('business','connection',true);metrics.gate('new-commit','connection',false);}
 finally{rmSync(root,{recursive:true,force:true});}
});
test('a queued shared request survives cancellation of its first owner and rechecks the remaining owner',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wb-model-owner-')),gateway=new ModelGateway(root,()=>1);let release!:()=>void,checked=0,calls=0;const a=new AbortController(),b=new AbortController();
 try{const blocked=gateway.queue.run(()=>new Promise<void>(r=>release=r));await pause();const work=async()=>{calls++;return 'done';},first=withModelContext({gateway,trigger:'automatic',assertCurrent:()=>{if(a.signal.aborted)throw Error('cancelled');}},()=>gateway.run(profile,'',input,a.signal,work)),second=withModelContext({gateway,trigger:'preview',beforeStart:async()=>{checked++;}},()=>gateway.run(profile,'',input,b.signal,work));a.abort();await assert.rejects(first,/cancelled/);release();await blocked;assert.equal(await second,'done');assert.equal(checked,1);assert.equal(calls,1);}
 finally{await gateway.close();rmSync(root,{recursive:true,force:true});}
});
