import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateProduction, aggregateRepositoryProduction,aggregateRepositoryCoverage, representativeWorkspace, formatOrganizerTitle, stripOrganizerMarker, organizerPolicySchema, organizerStep, type OrganizerJob, type WorkspaceAnalysis,type RepositoryCoverage } from '../shared/organizer.ts';
import { OrganizerModelQueue } from '../server/organizer/model-queue.ts';
import {organizerErrorLabel} from '../client/organizer-errors.ts';
test('production aggregates uncertainty and new discussion instead of declaring all shipped',()=>{
 assert.equal(aggregateProduction(['deployed','deployed']),'deployed');assert.equal(aggregateProduction(['deployed','pending']),'partial');assert.equal(aggregateProduction(['pending','unknown']),'pending');assert.equal(aggregateProduction(['deployed','discussion']),'partial');assert.equal(aggregateProduction([]),'discussion');
 const row=(key:string,state:string,activityAt:string)=>({key,material:{state,activityAt}} as WorkspaceAnalysis);
 assert.equal(representativeWorkspace([row('recent-shipped','deployed','2026'),row('old-pending','pending','2020')])?.key,'old-pending');assert.equal(representativeWorkspace([row('old','deployed','2020'),row('recent','deployed','2026')])?.key,'recent');
 const policy=organizerPolicySchema.parse({markers:{deployed:'🟢',partial:'半',pending:'待',unknown:'?',discussion:'·'}});assert.equal(stripOrganizerMarker('🟢 保留人工主旨',policy),'保留人工主旨');assert.equal(formatOrganizerTitle('很长的人工标题正文保持内容不被默认长度截断','deployed',policy,true),'🟢 很长的人工标题正文保持内容不被默认长度截断');
});
test('translated preview failures keep their actionable message when displayed again',()=>{
 for(const code of ['organizer_preview_changed','organizer_source_changed','organizer_settings_changed']){const label=organizerErrorLabel(code);assert.match(label,/刷新预览/);assert.equal(organizerErrorLabel(label,'generic failure'),label);}
 assert.equal(organizerErrorLabel('unknown internal error','更新未完成'),'更新未完成');
});
test('production aggregation preserves confirmed coverage and missing changes without treating unavailable references as fresh evidence',()=>{
 const row=(state:string,covered:number,pending:number,referenceUnavailable=false)=>({state,covered,pending,referenceUnavailable} as RepositoryCoverage);
 assert.equal(aggregateRepositoryCoverage([row('unknown',141,0),row('pending',0,19)]),'partial');assert.equal(aggregateRepositoryCoverage([row('unknown',0,0),row('pending',0,1)]),'pending');assert.equal(aggregateRepositoryCoverage([row('unknown',141,0)]),'unknown');
 assert.equal(aggregateRepositoryCoverage([row('unknown',20,1,true)]),'unknown');assert.equal(aggregateProduction(['partial','unknown']),'partial');assert.equal(aggregateProduction(['deployed','unknown']),'unknown');
});
test('host model queue bounds concurrency and drains after individual failures',async()=>{
 const queue=new OrganizerModelQueue(()=>2);let active=0,peak=0;const work=(fail=false)=>queue.run(async()=>{peak=Math.max(peak,++active);try{await new Promise(resolve=>setTimeout(resolve,10));if(fail)throw Error('failure');return true;}finally{active--;}});
 const results=await Promise.allSettled([work(),work(true),work(),work()]);await queue.idle();assert.equal(peak,2);assert.equal(active,0);assert.equal(results.filter(r=>r.status==='fulfilled').length,3);
});
test('unchanged repositories do not prevent shipment while a separate new discussion Workspace remains visible',()=>{
 assert.equal(aggregateRepositoryProduction(['deployed','discussion','discussion']),'deployed');
 assert.equal(aggregateRepositoryProduction(['discussion','discussion']),'discussion');
 assert.equal(aggregateRepositoryProduction(['deployed','unknown','discussion']),'unknown');
 assert.equal(aggregateProduction(['deployed','discussion']),'partial');
});
test('the workflow never highlights model generation during a Git-only or initial material read',()=>{
 const job={state:'running',stage:'materials',kind:'refresh',model:{state:'not-requested',calls:0,completed:0}} as OrganizerJob;
 assert.equal(organizerStep(job,false,false),0);assert.equal(organizerStep({...job,kind:'analysis'},false,false),0);
 assert.equal(organizerStep({...job,stage:'requesting',model:{state:'requesting',calls:1,completed:0}},false,false),1);
 assert.equal(organizerStep({...job,stage:'requesting',model:{state:'requesting',calls:1,completed:0}},true,true),1);
 assert.equal(organizerStep(undefined,false,true),0);
 assert.equal(organizerStep({...job,state:'complete'},true,false),2);assert.equal(organizerStep(undefined,true,true),4);
});
test('representative activity compares instants across commit offsets and UTC dirty-file timestamps',()=>{
 const row=(key:string,at:string)=>({key,material:{state:'pending',activityAt:at}} as WorkspaceAnalysis);
 assert.equal(representativeWorkspace([row('local-commit','2026-11-26T23:30:00+08:00'),row('later-edit','2026-11-26T16:00:00Z')])?.key,'later-edit');
 assert.equal(representativeWorkspace([row('old','2026-11-27T00:30:00+08:00'),row('new','2026-11-26T17:00:00Z')])?.key,'new');
});
