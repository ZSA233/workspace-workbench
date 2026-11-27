import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionProduction} from '../server/organizer/session-production.ts';
import {organizerPolicySchema,type WorkspaceMaterial} from '../shared/organizer.ts';

const policy=organizerPolicySchema.parse({});
function material():WorkspaceMaterial{return{workspaceId:'task',instance:'task:instance',name:'Task',taskBrief:'Requirement',createdAt:'2026-01-01',activityAt:'2026-01-01',fingerprint:'stable-source',evidence:[],complete:true,state:'deployed',repositories:[{repositoryId:'repo',sourcePath:'/source',repoPath:'repo',productionRef:'origin/main',head:'head',productionSha:'production',committedState:'deployed',state:'deployed',coverageComplete:true,covered:2,pending:0,uncertain:0,dirty:false,observedAt:'2026-01-01'}]};}
test('a failed fetch preserves confirmed deployment and exposes refresh health separately',async()=>{
 const production=new SessionProduction(),input=material();let fetches=0;
 const read=async(method:string)=>method==='repository.fetch'?(fetches++,{state:'failed'}):{refs:[{kind:'remote',shortName:'origin/main'}],fetch:{state:'failed'}};
 const value=await production.refresh('project',input,policy,'job',read,async()=>material(),new AbortController().signal,()=>{});
 assert.equal(value.state,'deployed');assert.equal(value.repositories[0].committedState,'deployed');assert.equal(value.repositories[0].referenceUnavailable,undefined);assert.match(value.repositories[0].refreshError!,/沿用本地 origin\/main/);
 await production.refresh('project',value,policy,'next',read,async()=>material(),new AbortController().signal,()=>{});assert.equal(fetches,1);
});
test('a successful persisted receipt recovers a failed memo without another network fetch',async()=>{
 const production=new SessionProduction();let ready=false,fetches=0,reloads=0;
 const read=async(method:string)=>method==='repository.fetch'?(fetches++,{state:'failed'}):{refs:[{kind:'remote',shortName:'origin/main'}],fetch:ready?{state:'ready',ref:'origin/main',lastFetchedAt:new Date().toISOString()}:{state:'failed'}};
 const refresh=(input:WorkspaceMaterial)=>production.refresh('project',input,policy,'job',read,async()=>{reloads++;return material();},new AbortController().signal,()=>{});
 const failed=await refresh(material());ready=true;const recovered=await refresh(failed);assert.equal(recovered.state,'deployed');assert.equal(recovered.repositories[0].refreshError,undefined);assert.equal(fetches,1);assert.equal(reloads,1);
 const peer=material();peer.workspaceId='peer';peer.repositories[0].refreshError='old failure';assert.equal((await refresh(peer)).repositories[0].refreshError,undefined);assert.equal(fetches,1);
});
test('missing production objects cannot become deployed because a refresh failure is only a warning',async()=>{
 const production=new SessionProduction(),input=material();Object.assign(input.repositories[0],{productionSha:undefined,committedState:'unknown',state:'unknown',referenceUnavailable:true});input.state='pending';
 const value=await production.refresh('project',input,policy,'job',async(method)=>method==='repository.fetch'?{state:'failed'}:{refs:[{kind:'remote',shortName:'origin/main'}]},async()=>input,new AbortController().signal,()=>{});
 assert.equal(value.state,'pending');assert.equal(value.repositories[0].referenceUnavailable,true);assert.equal(value.repositories[0].committedState,'unknown');
});
test('a cached legacy refresh failure never overwrites a valid local commit proof',async()=>{
 const production=new SessionProduction();await production.refresh('project',material(),policy,'job',async(method)=>method==='repository.fetch'?{state:'failed'}:{refs:[{kind:'remote',shortName:'origin/main'}]},async()=>material(),new AbortController().signal,()=>{});
 const legacy=material();Object.assign(legacy.repositories[0],{state:'unknown',reason:'生产引用获取未确认',referenceUnavailable:true});const value=production.applyCached('project',legacy);assert.equal(value.state,'deployed');assert.equal(value.repositories[0].referenceUnavailable,undefined);assert.ok(value.repositories[0].refreshError);
});
