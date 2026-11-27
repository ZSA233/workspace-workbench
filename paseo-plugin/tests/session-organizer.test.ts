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
import {sessionJobProgress} from '../shared/session-progress.ts';

const pause=()=>new Promise(r=>setTimeout(r,5));
async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-session-'))),config=join(root,'project.json'),registry=join(root,'registry.json'),oldRegistry=process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY;
 writeFileSync(config,JSON.stringify({schemaVersion:1,project:{id:'session'},sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),repositories:[]}));writeFileSync(registry,JSON.stringify({configs:[config]}));process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY=registry;
 let title:string|null='原有业务标题',writes=0,delay=0,modelTitle='小时统计查询优化',failWrite=false,badSource=false,head=1,readDelay=0,messageText='优化统计慢查询',hasNewer=false,echoCached=false,unknownWorkspace=false,extraTitle=false,summaryCitation=false,versionCache=false,toolHead=0;const inputs:any[]=[],reads:string[]=[];
 const materials:WorkspaceMaterial[]=Array.from({length:3},(_,i)=>({workspaceId:'w'+i,instance:'w'+i+':instance',name:'task-'+i,taskBrief:'统计查询优化',createdAt:'2026-01-01',activityAt:'2026-01-01',fingerprint:'fp-'+i,evidence:[{id:'commit:'+i,kind:'commit',text:'fix: use hourly summaries for statistics queries'}],state:'pending',complete:true,creatorAgentId:'agent',repositories:[{repositoryId:'one',repoPath:'one',productionRef:'production',state:'pending',covered:0,pending:1,uncertain:0,dirty:false,observedAt:'2026-01-01'}]}));
 const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}const parts=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts).toString()),input=JSON.parse(body.messages[1].content);inputs.push(input);if(delay)await new Promise(r=>setTimeout(r,delay));const result={workspaces:input.changedWorkspaces.map((w:any)=>({key:w.key,title:'统计查询优化',brief:'使用小时汇总减少重复扫描。',evidenceIds:[badSource?'fake':summaryCitation?w.key+'S':w.evidence[0].id]})),conversations:input.conversations.filter((c:any)=>c.evidence.length).map((c:any)=>({agentId:c.agentId,brief:'优化统计慢查询。',evidenceIds:[c.evidence[0].id]})),...(input.wantTitle?{title:{text:modelTitle,evidenceIds:['summary:'+(input.changedWorkspaces[0]?.key||input.workspaces.find((w:any)=>w.summary)?.key)]}}:{})};if(extraTitle&&!input.wantTitle)(result as any).title={text:'不应采用的额外标题',evidenceIds:['invalid-title-evidence']};if(echoCached){const cached=input.workspaces.find((w:any)=>w.summary);if(cached)result.workspaces.push({key:unknownWorkspace?'W999':cached.key,title:'不应发布的缓存改写',brief:'不应覆盖已有摘要。',evidenceIds:[cached.summary.sourceId]});}res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const settings=new OrganizerSettings(join(root,'settings'));settings.saveProfile(0,{id:'local',name:'Local',baseUrl:`http://127.0.0.1:${(server.address() as{port:number}).port}`,model:'fixture',contextTokens:16384,outputTokens:2048,timeoutMs:10000});
 const route={configPath:config,sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),treesRoot:join(root,'trees'),recordsRoot:join(root,'records'),socketPath:join(root,'s.sock'),displayName:'session'};
 settings.save('project',1,{profileId:'local',analysisIntervalSeconds:0,debounceSeconds:0},[],route);
 const agent={id:'agent',workspaceId:'native',cwd:root,archivedAt:null as string|null};let agentVisible=true;const api={agents:{list:async()=>({entries:agentVisible?[{agent}]:[],pageInfo:{hasMore:false}}),ref:()=>({timeline:{refetch:async(options:any)=>{let entries:any[]=options?.cursor?.seq>=head?[]:[{seqStart:head,seqEnd:head,item:{type:'user_message',text:messageText}}];if(toolHead>head&&(!options?.cursor||options.cursor.seq<toolHead))entries.push({seqStart:toolHead,seqEnd:toolHead,item:{type:'tool_call',name:'read'}});if(options.direction==='before'&&options.limit===1)entries=entries.slice(-1);return{epoch:'epoch',hasOlder:false,hasNewer:options.direction==='after'&&hasNewer,entries};}}})},workspaces:{list:async()=>({entries:[{id:'native',title}],pageInfo:{hasMore:false}}),ref:(id:string)=>({refresh:async()=>id==='native'?{id,title}:null,setTitle:async(value:string)=>{writes++;if(failWrite)throw Error('closed');title=value;}})}} as unknown as PaseoApi;
 const query=async({method,params}:any)=>{if(method==='organizer.versions'&&versionCache)return{ok:true,result:{instanceId:'backend-generation',notesRevision:'notes-generation',materialTokens:Object.fromEntries(materials.map(m=>[m.workspaceId,JSON.stringify(m)]))}};if(method==='repository.compare')return{ok:true,result:{refs:[]}};if(method==='workspace.list')return {ok:true,result:{workspaces:materials.map((m,i)=>({id:m.workspaceId,instanceKey:m.instance,displayName:m.name,creator:{agentId:m.creatorAgentId},createdAt:m.createdAt,managed:true,state:'active',latestCommitAt:`2026-01-0${i+1}T00:00:00Z`}))}};if(method==='notes.read')return{ok:true,result:{notes:[]}};if(method==='organizer.materials'){reads.push(params.workspaceId);if(readDelay)await new Promise(r=>setTimeout(r,readDelay));return {ok:true,result:structuredClone(materials.find(m=>m.workspaceId===params.workspaceId))};}throw Error(method);};
 let service=new OrganizerService({settings,api:async()=>api,query:query as any});const request=async(request:any)=>{const value=await service.request({projectConfig:config,request});if(!value.ok)throw Error(value.error);return value.result as any;};
 const done=async(j:any)=>{for(let i=0;i<1000;i++){const state=await request({action:'job',jobId:j.id});if(!['running','queued'].includes(state.state))return state;await pause();}throw Error('timeout');};
 return{root,route,settings,service,agent,enableCache:(value=true)=>versionCache=value,echoCache:(unknown=false)=>{echoCached=true;unknownWorkspace=unknown;},echoTitle:()=>extraTitle=true,citeSummary:(value:boolean)=>summaryCitation=value,hideAgent:()=>agentVisible=false,restart:async()=>{await service.close();service=new OrganizerService({settings,api:async()=>api,query:query as any});},request,done,materials,inputs,reads,counts:()=>({writes,calls:inputs.length}),title:(value?:string)=>{if(value)title=value;return title;},modelTitle:(value:string)=>{modelTitle=value;},delay:(value:number)=>{delay=value;},delayRead:(value:number)=>{readDelay=value;},longHistory:()=>{messageText="讨论统计查询与后续实现。".repeat(400);hasNewer=true;},toolActivity:()=>toolHead=Math.max(head,toolHead)+1,advance:()=>head=Math.max(head,toolHead)+1,bad:()=>badSource=true,failWrite:()=>failWrite=true,recoverWrite:()=>failWrite=false,close:async()=>{await service.close();await new Promise<void>(r=>server.close(()=>r()));if(oldRegistry===undefined)delete process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY;else process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY=oldRegistry;rmSync(root,{recursive:true,force:true});}};
}
test('session view batches its own workspaces, leaves native titles alone, and caches unchanged summaries',async()=>{
 const f=await fixture();try{const job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(f.counts().calls,1);assert.equal(f.counts().writes,0);assert.equal(f.inputs[0].workspaces.find((w:any)=>w.key===f.inputs[0].latestWorkspace).name,'task-2');assert.equal(f.inputs[0].workspaces.length,3);assert.equal(f.inputs[0].wantTitle,true);
 const snapshot=await f.request({action:'snapshot',hostWorkspaceId:'native'});assert.equal(snapshot.workspaces.filter((w:any)=>w.digest).length,3);assert.equal(snapshot.targets[0].session.enabled,false);await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(f.counts().calls,1);
 }finally{await f.close();}
});
test('reentering an enabled session and opening previews reuse verified Git materials and unfinished summaries across reloads',async()=>{
 const f=await fixture();try{
  f.enableCache();f.longHistory();let job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);
  let snapshot=await f.request({action:'snapshot'});const offset=snapshot.conversations[0].pendingMessage.offset;
  await f.request({action:'session.apply',targetId:'native',previewId:snapshot.targets[0].session.preview.id});const before=f.reads.length;
  for(const preview of [false,false,true]){job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview}));assert.equal(job.state,'complete',job.error);assert.equal(job.model.calls,0);assert.equal(job.result.previewReady,true);assert.ok(job.input.workspaces.every((w:any)=>w.materialCached));assert.ok(!job.events.some((e:any)=>['materials','verifying','titles'].includes(e.stage)));}
  assert.equal(f.reads.length,before);assert.equal(f.counts().writes,1);await f.restart();job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(f.reads.length,before);assert.equal(job.model.calls,0);
  snapshot=await f.request({action:'snapshot'});assert.equal(snapshot.conversations[0].pendingMessage.offset,offset);assert.equal(snapshot.targets[0].session.enabled,true);
 }finally{await f.close();}
});
test('source changes reload only the affected Workspace and degraded versions fall back to full verification',async()=>{
 const f=await fixture();try{
  f.enableCache();assert.equal((await f.done(await f.request({action:'session.refresh',targetId:'native'}))).state,'complete');f.reads.length=0;
  f.materials[1].fingerprint='changed';const changed=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(changed.state,'complete',changed.error);assert.deepEqual(f.reads,['w1','w1']);assert.equal(changed.model.calls,1);assert.equal(changed.input.workspaces.filter((w:any)=>!w.materialCached).length,1);
  f.enableCache(false);f.reads.length=0;const degraded=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(degraded.state,'complete',degraded.error);assert.deepEqual(f.reads,['w0','w1','w2']);assert.equal(degraded.model.calls,0);
 }finally{await f.close();}
});
test('expired material proofs and explicit force refreshes cannot silently reuse a previous Git check',async()=>{
 const f=await fixture();try{
  f.enableCache();await f.done(await f.request({action:'session.refresh',targetId:'native'}));f.service.store(f.route).update(l=>{for(const w of Object.values(l.workspaces))w.materialCache!.at='2000-01-01';});f.reads.length=0;
  const expired=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(expired.state,'complete',expired.error);assert.equal(expired.model.calls,0);assert.equal(f.reads.length,3);assert.ok(expired.input.workspaces.every((w:any)=>!w.materialCached));
  f.reads.length=0;const forced=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true,force:true}));assert.equal(forced.state,'complete',forced.error);assert.equal(f.reads.length,3);assert.equal(forced.model.calls,1);
 }finally{await f.close();}
});
test('tool-only timeline activity permits confirmation and cached entry while new public messages still invalidate a preview',async()=>{
 const f=await fixture();try{
  f.enableCache();const initial=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(initial.state,'complete',initial.error);let view=await f.request({action:'snapshot'});const cursor=view.conversations[0].cursor;
  f.toolActivity();f.toolActivity();await f.request({action:'session.apply',targetId:'native',previewId:view.targets[0].session.preview.id});assert.equal(f.counts().writes,1);
  for(const preview of [false,true]){f.toolActivity();const next=await f.done(await f.request({action:'session.refresh',targetId:'native',preview}));assert.equal(next.state,'complete',next.error);assert.equal(next.model.calls,0);assert.equal(next.input.history.pages,0);assert.equal(next.result.previewReady,true);}
  view=await f.request({action:'snapshot'});assert.deepEqual(view.conversations[0].cursor,cursor);assert.equal(view.targets[0].session.enabled,true);
  f.advance();await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId:view.targets[0].session.preview.id}),/source_changed/);assert.equal(f.counts().writes,1);
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
test('a local packing failure does not start the model cooldown or block the first real request',async()=>{
 const f=await fixture();try{
  let settings=f.settings.response(f.route);const profile=settings.profiles[0];f.settings.save('project',settings.revision,{analysisIntervalSeconds:300},[],f.route);
  settings=f.settings.response(f.route);f.settings.saveProfile(settings.revision,{...profile,contextTokens:2048,outputTokens:2048});
  const failed=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(failed.state,'failed');assert.match(failed.error,/context_allocation_invalid/);assert.equal(failed.model.calls,0);assert.equal((await f.request({action:'snapshot'})).targets[0].session.lastAttemptAt,undefined);
  settings=f.settings.response(f.route);f.settings.saveProfile(settings.revision,profile);
  const retried=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(retried.state,'complete',retried.error);assert.equal(retried.model.calls,1);assert.equal(retried.result.previewReady,true);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('changed workspace summaries exclude stale cached prose and must cite current original evidence',async()=>{
 const f=await fixture();try{
  assert.equal((await f.done(await f.request({action:'session.refresh',targetId:'native'}))).state,'complete');
  const previous=(await f.request({action:'snapshot'})).workspaces.find((w:any)=>w.material.workspaceId==='w0').digest.fingerprint;
  f.materials[0].fingerprint='changed';f.materials[0].evidence.push({id:'commit:new',kind:'commit',text:'fix: preserve refunds during relationship migration'});f.citeSummary(true);
  const bad=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(bad.state,'failed');assert.match(bad.error,/evidence_invalid/);
  const input=f.inputs.at(-1),changed=input.changedWorkspaces[0];assert.equal(input.workspaces.find((w:any)=>w.key===changed.key).summary,undefined);assert.equal(input.workspaces.filter((w:any)=>w.summary).length,2);
  assert.equal((await f.request({action:'snapshot'})).workspaces.find((w:any)=>w.material.workspaceId==='w0').digest.fingerprint,previous);assert.equal(f.counts().writes,0);
  f.citeSummary(false);const retried=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(retried.state,'complete',retried.error);assert.equal(retried.result.previewReady,true);
  const workspace=(await f.request({action:'snapshot'})).workspaces.find((w:any)=>w.material.workspaceId==='w0'),digest=workspace.digest;assert.equal(digest.fingerprint,workspace.material.fingerprint);assert.notEqual(digest.fingerprint,previous);assert.ok(digest.evidenceIds.every((id:string)=>f.materials[0].evidence.some(e=>e.id===id)));assert.equal(f.counts().writes,0);
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
test('title-only generations discard echoed cached workspace results without replacing summaries',async()=>{
 const f=await fixture();try{
  await f.done(await f.request({action:'session.refresh',targetId:'native'}));const before=await f.request({action:'snapshot'});f.echoCache();f.advance();
  const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);assert.equal(job.result.previewReady,true);assert.equal(f.inputs.at(-1).changedWorkspaces.length,0);assert.equal(f.inputs.at(-1).wantTitle,true);
  const after=await f.request({action:'snapshot'});assert.deepEqual(after.workspaces.map((w:any)=>w.digest),before.workspaces.map((w:any)=>w.digest));assert.equal(after.targets[0].session.preview.body,'小时统计查询优化');assert.equal(after.targets[0].session.error,undefined);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('unrequested workspace echoes with unknown identities still fail instead of being silently discarded',async()=>{
 const f=await fixture();try{
  await f.done(await f.request({action:'session.refresh',targetId:'native'}));f.echoCache(true);f.advance();const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'failed');assert.match(job.error,/workspace_invalid/);assert.equal(job.result.failed,1);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('a newly associated session prepares its own title even when every Workspace summary is cached',async()=>{
 const f=await fixture();try{
  await f.done(await f.request({action:'session.refresh',targetId:'native'}));f.service.store(f.route).update(l=>{delete l.targets.native.session!.preview;});
  const job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(job.result.previewReady,true);assert.equal(job.result.analyzed,0);assert.equal(job.result.cached,3);assert.equal(f.inputs.at(-1).wantTitle,true);assert.equal(f.inputs.at(-1).changedWorkspaces.length,0);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('progress distinguishes material reads, history pages, real model requests and a ready title',async()=>{
 const f=await fixture();try{
  f.delayRead(50);f.delay(200);const job=await f.request({action:'session.refresh',targetId:'native'});let reading:any,requesting:any;
  for(let i=0;i<500;i++){const current=await f.request({action:'job',jobId:job.id});if(current.stage==='materials')reading=current;if(current.stage==='requesting'){requesting=current;break;}await pause();}
  assert.equal(sessionJobProgress(reading).label,'读取提交与差异');assert.equal(reading.model.calls,0);assert.ok(reading.current.workspaceId);
  assert.equal(sessionJobProgress(requesting).label,'生成标题和摘要');assert.equal(requesting.model.calls,1);assert.equal(requesting.input.workspaces.length,3);assert.equal(requesting.input.history.pages,1);assert.ok(requesting.input.history.fragments>0);
  const done=await f.done(job);assert.equal(done.result.previewReady,true);assert.equal(sessionJobProgress(done).label,'标题建议已就绪');assert.match(sessionJobProgress(done).detail,/本地模型 1 次/);assert.ok(done.events.some((e:any)=>e.stage==='conversation'));assert.ok(done.events.some((e:any)=>e.stage==='verifying'));assert.ok(done.events.some((e:any)=>e.current?.workspaceId));
 }finally{await f.close();}
});
test('an extra title in a summary-only batch is discarded and only the final requested title is accepted',async()=>{
 const f=await fixture();try{
  for(let i=3;i<6;i++){const m=structuredClone(f.materials[0]);m.workspaceId='w'+i;m.instance='w'+i+':instance';m.fingerprint='fp-'+i;f.materials.push(m);}f.echoTitle();
  const job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(f.inputs[0].wantTitle,false);assert.equal(job.model.calls,2);assert.equal((await f.request({action:'snapshot'})).targets[0].session.preview.body,'小时统计查询优化');assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('explicit title preview remains read-only even while automatic title maintenance is enabled',async()=>{
 const f=await fixture();try{
  await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));const before=(await f.request({action:'snapshot'})).targets[0];await f.request({action:'session.apply',targetId:'native',previewId:before.session.preview.id});const accepted=f.title();
  f.modelTitle('统计边界问题修复');f.materials[0].fingerprint='new-material';const preview=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(preview.state,'complete',preview.error);assert.equal(preview.result.previewReady,true);assert.equal((await f.request({action:'snapshot'})).targets[0].session.preview.body,'统计边界问题修复');assert.equal(f.title(),accepted);assert.equal(f.counts().writes,1);
 }finally{await f.close();}
});
