import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateProduction, representativeWorkspace, formatOrganizerTitle, stripOrganizerMarker, organizerPolicySchema, type WorkspaceAnalysis } from '../shared/organizer.ts';
import { OrganizerModelQueue } from '../server/organizer/model-queue.ts';
test('production aggregates uncertainty and new discussion instead of declaring all shipped',()=>{
 assert.equal(aggregateProduction(['deployed','deployed']),'deployed');assert.equal(aggregateProduction(['deployed','pending']),'partial');assert.equal(aggregateProduction(['pending','unknown']),'unknown');assert.equal(aggregateProduction(['deployed','discussion']),'partial');assert.equal(aggregateProduction([]),'discussion');
 const row=(key:string,state:string,activityAt:string)=>({key,material:{state,activityAt}} as WorkspaceAnalysis);
 assert.equal(representativeWorkspace([row('recent-shipped','deployed','2026'),row('old-pending','pending','2020')])?.key,'old-pending');assert.equal(representativeWorkspace([row('old','deployed','2020'),row('recent','deployed','2026')])?.key,'recent');
 const policy=organizerPolicySchema.parse({markers:{deployed:'🟢',partial:'半',pending:'待',unknown:'?',discussion:'·'}});assert.equal(stripOrganizerMarker('🟢 保留人工主旨',policy),'保留人工主旨');assert.equal(formatOrganizerTitle('很长的人工标题正文保持内容不被默认长度截断','deployed',policy,true),'🟢 很长的人工标题正文保持内容不被默认长度截断');
});
test('host model queue bounds concurrency and drains after individual failures',async()=>{
 const queue=new OrganizerModelQueue(()=>2);let active=0,peak=0;const work=(fail=false)=>queue.run(async()=>{peak=Math.max(peak,++active);try{await new Promise(resolve=>setTimeout(resolve,10));if(fail)throw Error('failure');return true;}finally{active--;}});
 const results=await Promise.allSettled([work(),work(true),work(),work()]);await queue.idle();assert.equal(peak,2);assert.equal(active,0);assert.equal(results.filter(r=>r.status==='fulfilled').length,3);
});
test('representative activity compares instants across commit offsets and UTC dirty-file timestamps',()=>{
 const row=(key:string,at:string)=>({key,material:{state:'pending',activityAt:at}} as WorkspaceAnalysis);
 assert.equal(representativeWorkspace([row('local-commit','2026-11-26T23:30:00+08:00'),row('later-edit','2026-11-26T16:00:00Z')])?.key,'later-edit');
 assert.equal(representativeWorkspace([row('old','2026-11-27T00:30:00+08:00'),row('new','2026-11-26T17:00:00Z')])?.key,'new');
});
