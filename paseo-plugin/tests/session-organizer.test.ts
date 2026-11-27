import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import type {PaseoApi} from '@getpaseo/client';
import {OrganizerService} from '../server/organizer/service.ts';
import {OrganizerSettings} from '../server/organizer/storage.ts';
import type {WorkspaceMaterial} from '../shared/organizer.ts';
import {sessionEvidence} from '../server/organizer/session-model.ts';

const pause=()=>new Promise(r=>setTimeout(r,5));
async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-session-'))),config=join(root,'project.json'),registry=join(root,'registry.json'),oldRegistry=process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY;
 writeFileSync(config,JSON.stringify({schemaVersion:1,project:{id:'session'},sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),repositories:[]}));writeFileSync(registry,JSON.stringify({configs:[config]}));process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY=registry;
 let title:string|null='原有业务标题',writes=0,delay=0,modelTitle='小时统计查询优化',failWrite=false,badSource=false,head=1,readDelay=0,messageText='优化统计慢查询',hasNewer=false;const inputs:any[]=[],reads:string[]=[];
 const materials:WorkspaceMaterial[]=Array.from({length:3},(_,i)=>({workspaceId:'w'+i,instance:'w'+i+':instance',name:'task-'+i,taskBrief:'统计查询优化',createdAt:'2026-01-01',activityAt:'2026-01-01',fingerprint:'fp-'+i,evidence:[{id:'commit:'+i,kind:'commit',text:'fix: use hourly summaries for statistics queries'}],state:'pending',complete:true,creatorAgentId:'agent',repositories:[{repositoryId:'one',repoPath:'one',productionRef:'production',state:'pending',covered:0,pending:1,uncertain:0,dirty:false,observedAt:'2026-01-01'}]}));
 const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}const parts=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts).toString()),input=JSON.parse(body.messages[1].content);inputs.push(input);if(delay)await new Promise(r=>setTimeout(r,delay));const result={workspaces:input.changedWorkspaces.map((w:any)=>({key:w.key,title:'统计查询优化',brief:'使用小时汇总减少重复扫描。',evidenceIds:[badSource?'fake':w.evidence[0].id]})),conversations:input.conversations.filter((c:any)=>c.evidence.length).map((c:any)=>({agentId:c.agentId,brief:'优化统计慢查询。',evidenceIds:[c.evidence[0].id]})),...(input.wantTitle?{title:{text:modelTitle,evidenceIds:['summary:'+(input.changedWorkspaces[0]?.key||input.workspaces.find((w:any)=>w.summary)?.key)]}}:{})};res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const settings=new OrganizerSettings(join(root,'settings'));settings.saveProfile(0,{id:'local',name:'Local',baseUrl:`http://127.0.0.1:${(server.address() as{port:number}).port}`,model:'fixture',contextTokens:16384,outputTokens:2048,timeoutMs:10000});
 const route={configPath:config,sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),treesRoot:join(root,'trees'),recordsRoot:join(root,'records'),socketPath:join(root,'s.sock'),displayName:'session'};
 settings.save('project',1,{profileId:'local',analysisIntervalSeconds:0,debounceSeconds:0},[],route);
 const agent={id:'agent',workspaceId:'native',cwd:root,archivedAt:null as string|null};let agentVisible=true;const api={agents:{list:async()=>({entries:agentVisible?[{agent}]:[],pageInfo:{hasMore:false}}),ref:()=>({timeline:{refetch:async(options:any)=>({epoch:'epoch',hasOlder:false,hasNewer:options.direction==='after'&&hasNewer,entries:options?.cursor?.seq>=head?[]:[{seqStart:head,seqEnd:head,item:{type:'user_message',text:messageText}}]})}})},workspaces:{list:async()=>({entries:[{id:'native',title}],pageInfo:{hasMore:false}}),ref:(id:string)=>({refresh:async()=>id==='native'?{id,title}:null,setTitle:async(value:string)=>{writes++;if(failWrite)throw Error('closed');title=value;}})}} as unknown as PaseoApi;
 const query=async({method,params}:any)=>{if(method==='repository.compare')return{ok:true,result:{refs:[]}};if(method==='workspace.list')return {ok:true,result:{workspaces:materials.map((m,i)=>({id:m.workspaceId,instanceKey:m.instance,displayName:m.name,creator:{agentId:m.creatorAgentId},createdAt:m.createdAt,managed:true,state:'active',latestCommitAt:`2026-01-0${i+1}T00:00:00Z`}))}};if(method==='notes.read')return{ok:true,result:{notes:[]}};if(method==='organizer.materials'){reads.push(params.workspaceId);if(readDelay)await new Promise(r=>setTimeout(r,readDelay));return {ok:true,result:structuredClone(materials.find(m=>m.workspaceId===params.workspaceId))};}throw Error(method);};
 let service=new OrganizerService({settings,api:async()=>api,query:query as any});const request=async(request:any)=>{const value=await service.request({projectConfig:config,request});if(!value.ok)throw Error(value.error);return value.result as any;};
 const done=async(j:any)=>{for(let i=0;i<1000;i++){const state=await request({action:'job',jobId:j.id});if(!['running','queued'].includes(state.state))return state;await pause();}throw Error('timeout');};
 return{root,route,settings,service,agent,hideAgent:()=>agentVisible=false,restart:async()=>{await service.close();service=new OrganizerService({settings,api:async()=>api,query:query as any});},request,done,materials,inputs,reads,counts:()=>({writes,calls:inputs.length}),title:(value?:string)=>{if(value)title=value;return title;},modelTitle:(value:string)=>{modelTitle=value;},delay:(value:number)=>{delay=value;},delayRead:(value:number)=>{readDelay=value;},longHistory:()=>{messageText="讨论统计查询与后续实现。".repeat(400);hasNewer=true;},advance:()=>head++,bad:()=>badSource=true,failWrite:()=>failWrite=true,recoverWrite:()=>failWrite=false,close:async()=>{await service.close();await new Promise<void>(r=>server.close(()=>r()));if(oldRegistry===undefined)delete process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY;else process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY=oldRegistry;rmSync(root,{recursive:true,force:true});}};
}
test('session view batches its own workspaces, leaves native titles alone, and caches unchanged summaries',async()=>{
 const f=await fixture();try{const job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(f.counts().calls,1);assert.equal(f.counts().writes,0);assert.equal(f.inputs[0].workspaces.find((w:any)=>w.key===f.inputs[0].latestWorkspace).name,'task-2');assert.equal(f.inputs[0].workspaces.length,3);assert.equal(f.inputs[0].wantTitle,true);
 const snapshot=await f.request({action:'snapshot',hostWorkspaceId:'native'});assert.equal(snapshot.workspaces.filter((w:any)=>w.digest).length,3);assert.equal(snapshot.targets[0].session.enabled,false);await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(f.counts().calls,1);
 }finally{await f.close();}
});
test('preview is independent from workspace titles and only explicit apply enables this session',async()=>{
 const f=await fixture();try{const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);const s=await f.request({action:'snapshot'}),t=s.targets[0];assert.equal(t.session.preview.body,'小时统计查询优化');assert.notEqual(t.session.preview.body,s.workspaces[0].digest.title);assert.equal(f.counts().writes,0);await f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id});assert.equal(f.title(),'○ 小时统计查询优化');assert.equal(f.counts().writes,1);
 f.modelTitle('统计读取边界修复');f.materials[2].fingerprint='new';const next=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(next.state,'complete',next.error);assert.equal(f.title(),'○ 统计读取边界修复');
 await f.request({action:'session.automatic',targetId:'native',enabled:false});f.materials[2].fingerprint='newer';await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(f.counts().writes,2);
 }finally{await f.close();}
});
test('unrelated or empty sessions never analyze other workspaces and empty baselines receive no invented digest',async()=>{
 const f=await fixture();try{await f.done(await f.request({action:'session.refresh',targetId:'missing'}));assert.equal(f.reads.length,0);assert.equal(f.counts().calls,0);f.materials[0].evidence=[];const j=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(j.state,'complete',j.error);const snapshot=await f.request({action:'snapshot'});assert.equal(snapshot.workspaces.find((w:any)=>w.material.workspaceId==='w0').digest,undefined);assert.equal(f.inputs[0].changedWorkspaces.length,2);
 }finally{await f.close();}
});
test('changed material, incoming messages and external names invalidate a frozen confirmation',async()=>{
 const f=await fixture();try{await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));let t=(await f.request({action:'snapshot'})).targets[0];f.advance();await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id}),/source_changed/);assert.equal(f.counts().writes,0);
 await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));t=(await f.request({action:'snapshot'})).targets[0];f.title('人工标题');await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id}),/external_title/);assert.equal(f.title(),'人工标题');assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('uncertain title writes pause maintenance and are never automatically replayed',async()=>{
 const f=await fixture();try{await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));const t=(await f.request({action:'snapshot'})).targets[0];f.failWrite();await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id}),/closed/);assert.equal(f.counts().writes,1);await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(f.counts().writes,1);assert.equal((await f.request({action:'snapshot'})).targets[0].session.enabled,false);
 }finally{await f.close();}
});
test('session cancellation and invalid model citations cannot publish a digest or a native title',async()=>{
 const f=await fixture();try{f.delay(100);const job=await f.request({action:'session.refresh',targetId:'native',preview:true});while(!f.inputs.length)await pause();await f.request({action:'cancel',jobId:job.id});assert.equal((await f.done(job)).state,'cancelled');assert.equal((await f.request({action:'snapshot'})).workspaces.some((w:any)=>w.digest),false);f.delay(0);f.bad();const bad=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(bad.state,'failed');assert.match(bad.error,/evidence_invalid/);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('legacy project switches do not enroll or rename sessions; changing prompt requires another preview',async()=>{
 const f=await fixture();try{let settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{enabled:true},[],f.route);await f.done(await f.request({action:'refresh'}));assert.equal(f.counts().writes,0);assert.equal(f.counts().calls,0);await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));let t=(await f.request({action:'snapshot'})).targets[0];await f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id});settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{namingMode:'overall'},[],f.route);await f.done(await f.request({action:'session.refresh',targetId:'native'}));t=(await f.request({action:'snapshot'})).targets[0];assert.equal(t.session.enabled,false);assert.equal(f.counts().writes,1);
 }finally{await f.close();}
});
test('evidence packing retains code after large notes and demotes release boilerplate',()=>{
 const input=[{id:'release',kind:'commit' as const,text:'release(prod): publish 2026'},{id:'note',kind:'note' as const,text:'重要说明'.repeat(3000)},{id:'code',kind:'diff' as const,text:'diff --git a/query.go b/query.go\n+select hourly_summary\n'},{id:'goal',kind:'goal' as const,text:'减少统计查询扫描'}];const packed=sessionEvidence(input,3000);assert.ok(packed.evidence.some(e=>e.id==='code'));assert.ok(packed.evidence.some(e=>e.id==='goal'));assert.ok(packed.evidence.findIndex(e=>e.id==='release')>packed.evidence.findIndex(e=>e.id==='goal'));assert.equal(packed.partial,true);
});
test('a preview reuses a precomputed suggestion without rereading an unfinished history or calling the model',async()=>{
 const f=await fixture();try{f.longHistory();let job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);let s=await f.request({action:'snapshot'});assert.equal(s.conversations[0].complete,false);assert.ok(s.conversations[0].pendingMessage);const cursor=s.conversations[0].pendingMessage.offset;
 job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);assert.equal(job.model.calls,0);assert.equal(f.counts().calls,1);s=await f.request({action:'snapshot'});assert.equal(s.conversations[0].pendingMessage.offset,cursor);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('more than four changed workspaces use bounded batches and the final title receives every workspace',async()=>{
 const f=await fixture();try{for(let i=3;i<6;i++){const m=structuredClone(f.materials[0]);m.workspaceId='w'+i;m.instance='w'+i+':instance';m.name='task-'+i;m.fingerprint='fp-'+i;f.materials.push(m);}const job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.deepEqual(f.inputs.map(i=>i.changedWorkspaces.length),[4,2]);assert.equal(f.inputs.at(-1).workspaces.length,6);assert.equal(f.inputs[0].wantTitle,false);assert.equal(f.inputs[1].wantTitle,true);assert.equal((await f.request({action:'snapshot'})).workspaces.filter((w:any)=>w.digest).length,6);
 }finally{await f.close();}
});
test('switching maintenance off while confirmation checks are in flight prevents a title write',async()=>{
 const f=await fixture();try{await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));const t=(await f.request({action:'snapshot'})).targets[0];f.delayRead(30);const applying=f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id});await pause();await f.request({action:'session.automatic',targetId:'native',enabled:false});await assert.rejects(applying,/cancelled/);assert.equal(f.counts().writes,0);assert.equal((await f.request({action:'snapshot'})).targets[0].session.enabled,false);
 }finally{await f.close();}
});
test('production-only state changes update the marker within the analysis interval without another model request',async()=>{
 const f=await fixture();try{await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));let t=(await f.request({action:'snapshot'})).targets[0];await f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id});const settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{analysisIntervalSeconds:300},[],f.route);for(const material of f.materials){material.state=material.repositories[0].state='deployed';}
 const job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(f.title(),'✓ 小时统计查询优化');assert.equal(f.counts().calls,1);assert.equal(f.counts().writes,2);
 }finally{await f.close();}
});
test('an uncertain write can only be attempted again after a fresh explicit preview confirmation',async()=>{
 const f=await fixture();try{await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));const before=(await f.request({action:'snapshot'})).targets[0];f.failWrite();await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId:before.session.preview.id}),/closed/);f.recoverWrite();await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId:before.session.preview.id}),/preview_changed/);assert.equal(f.counts().writes,1);
 const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);const after=(await f.request({action:'snapshot'})).targets[0];assert.notEqual(after.session.preview.id,before.session.preview.id);await f.request({action:'session.apply',targetId:'native',previewId:after.session.preview.id});assert.equal(f.counts().writes,2);assert.equal((await f.request({action:'snapshot'})).targets[0].uncertainWrites.length,1);
 }finally{await f.close();}
});
test('an empty baseline does not keep fully deployed work in a partially deployed state',async()=>{
 const f=await fixture();try{for(const m of f.materials)m.state=m.repositories[0].state='deployed';const baseline=structuredClone(f.materials[0]);baseline.workspaceId='baseline';baseline.instance='baseline:instance';baseline.taskBrief='';baseline.evidence=[];baseline.state=baseline.repositories[0].state='discussion';f.materials.push(baseline);
 const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);assert.equal((await f.request({action:'snapshot'})).targets[0].session.preview.title,'✓ 小时统计查询优化');
 }finally{await f.close();}
});
test('verified associations survive archived or missing Agents, reloads and legacy project refreshes',async()=>{
 const f=await fixture();try{
  const first=await f.request({action:'session.associations',targetId:'native'});assert.equal(first.workspaces.filter((w:any)=>w.linked).length,3);assert.equal(f.counts().calls,0);
  f.agent.archivedAt='2026-02-01';let view=await f.request({action:'session.associations',targetId:'native'});assert.equal(view.workspaces.filter((w:any)=>w.linked).length,3);
  f.hideAgent();await f.restart();view=await f.request({action:'session.associations',targetId:'native'});assert.equal(view.workspaces.filter((w:any)=>w.linked).length,3);
  assert.equal((await f.done(await f.request({action:'refresh'}))).state,'complete');assert.equal((await f.request({action:'snapshot',hostWorkspaceId:'native'})).targets[0].workspaceKeys.length,3);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('a session can explicitly associate legacy Workspaces without creators and preserve those links across refreshes',async()=>{
 const f=await fixture();try{
  for(const m of f.materials)delete m.creatorAgentId;
  const view=await f.request({action:'session.associations',targetId:'native'});assert.equal(view.workspaces.length,3);assert.equal(view.workspaces.some((w:any)=>w.linked),false);
  const saved=await f.request({action:'session.associations.save',targetId:'native',revision:view.revision,workspaceKeys:[view.workspaces[1].key]});assert.equal(saved.workspaces.filter((w:any)=>w.linked).length,1);assert.equal(saved.workspaces[1].source,'manual');assert.equal(f.counts().calls,0);assert.equal(f.counts().writes,0);
  assert.equal((await f.done(await f.request({action:'refresh'}))).state,'complete');await f.restart();assert.equal((await f.request({action:'session.associations',targetId:'native'})).workspaces[1].linked,true);
  const job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(f.inputs[0].workspaces.length,1);assert.equal(f.inputs[0].conversations.length,1);assert.deepEqual((await f.request({action:'snapshot'})).targets[0].agentIds,['agent']);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('deselecting an automatic association persists an exclusion and reselecting does not alter creator records',async()=>{
 const f=await fixture();try{
  let view=await f.request({action:'session.associations',targetId:'native'});view=await f.request({action:'session.associations.save',targetId:'native',revision:view.revision,workspaceKeys:view.workspaces.slice(1).map((w:any)=>w.key)});
  await f.restart();view=await f.request({action:'session.associations',targetId:'native'});assert.equal(view.workspaces[0].linked,false);assert.equal(view.workspaces[0].source,'manual');assert.equal((await f.done(await f.request({action:'refresh'}))).state,'complete');assert.equal((await f.request({action:'snapshot'})).targets[0].workspaceKeys.length,2);
  await f.request({action:'session.associations.save',targetId:'native',revision:view.revision,workspaceKeys:view.workspaces.map((w:any)=>w.key)});assert.equal(f.materials[0].creatorAgentId,'agent');assert.equal((await f.request({action:'snapshot'})).targets[0].workspaceKeys.length,3);
 }finally{await f.close();}
});
test('association selections reject stale scopes and foreign or duplicate Workspace instances atomically',async()=>{
 const f=await fixture();try{
  const view=await f.request({action:'session.associations',targetId:'native'}),keys=view.workspaces.map((w:any)=>w.key);
  await assert.rejects(f.request({action:'session.associations.save',targetId:'native',revision:view.revision,workspaceKeys:[...keys,'foreign:instance']}),/workspace_unavailable/);
  await assert.rejects(f.request({action:'session.associations.save',targetId:'native',revision:view.revision,workspaceKeys:[keys[0],keys[0]]}),/workspace_unavailable/);
  await f.request({action:'session.associations.save',targetId:'native',revision:view.revision,workspaceKeys:keys.slice(1)});
  await assert.rejects(f.request({action:'session.associations.save',targetId:'native',revision:view.revision,workspaceKeys:keys}),/associations_changed/);
  assert.equal((await f.request({action:'snapshot'})).targets[0].workspaceKeys.length,2);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('Workspace IDs reused by a new instance do not inherit a manual association',async()=>{
 const f=await fixture();try{
  for(const m of f.materials)delete m.creatorAgentId;let view=await f.request({action:'session.associations',targetId:'native'});await f.request({action:'session.associations.save',targetId:'native',revision:view.revision,workspaceKeys:[view.workspaces[0].key]});
  view=await f.request({action:'session.associations',targetId:'native'});f.materials[0].instance='w0:replacement';
  await assert.rejects(f.request({action:'session.associations.save',targetId:'native',revision:view.revision,workspaceKeys:[view.workspaces[0].key]}),/associations_changed/);
  const updated=await f.request({action:'session.associations',targetId:'native'});assert.equal(updated.workspaces.some((w:any)=>w.linked),false);assert.ok((await f.request({action:'snapshot'})).targets[0].workspaceLinks[view.workspaces[0].key]);
 }finally{await f.close();}
});
test('editing an association pauses title authorization and invalidates previously confirmed inputs',async()=>{
 const f=await fixture();try{
  await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));let t=(await f.request({action:'snapshot'})).targets[0];await f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id});const oldPreview=t.session.preview.id;
  const view=await f.request({action:'session.associations',targetId:'native'});await f.request({action:'session.associations.save',targetId:'native',revision:view.revision,workspaceKeys:view.workspaces.slice(1).map((w:any)=>w.key)});
  t=(await f.request({action:'snapshot'})).targets[0];assert.equal(t.session.enabled,false);assert.equal(t.session.preview,undefined);await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId:oldPreview}),/preview_changed/);assert.equal(f.counts().writes,1);
 }finally{await f.close();}
});
test('saving associations cancels an in-flight model result before it can publish',async()=>{
 const f=await fixture();try{
  f.delay(150);const job=await f.request({action:'session.refresh',targetId:'native',preview:true});while(!f.inputs.length)await pause();
  const view=await f.request({action:'session.associations',targetId:'native'});await f.request({action:'session.associations.save',targetId:'native',revision:view.revision,workspaceKeys:view.workspaces.slice(1).map((w:any)=>w.key)});
  assert.equal((await f.done(job)).state,'cancelled');assert.equal((await f.request({action:'snapshot'})).workspaces.some((w:any)=>w.digest),false);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
