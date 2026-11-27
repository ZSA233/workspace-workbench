import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import type {PaseoApi} from '@getpaseo/client';
import {OrganizerService} from '../server/organizer/service.ts';
import {OrganizerSettings,organizerHash} from '../server/organizer/storage.ts';
import type {WorkspaceMaterial} from '../shared/organizer.ts';
import {sessionEvidence} from '../server/organizer/session-model.ts';
import {sessionJobProgress} from '../shared/session-progress.ts';

const pause=()=>new Promise(r=>setTimeout(r,5));
async function fixture(count=3){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-session-'))),config=join(root,'project.json'),registry=join(root,'registry.json'),oldRegistry=process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY;
 writeFileSync(config,JSON.stringify({schemaVersion:1,project:{id:'session'},sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),repositories:[]}));writeFileSync(registry,JSON.stringify({configs:[config]}));process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY=registry;
 let title:string|null='原有业务标题',writes=0,delay=0,modelTitle='小时统计查询优化',failWrite=false,badSource=false,head=1,readDelay=0,messageText='优化统计慢查询',hasNewer=false,echoCached=false,unknownWorkspace=false,extraTitle=false,summaryCitation=false,versionCache=false,factsMode=false,toolHead=0,afterModel:(()=>void)|undefined,failedRead:string|undefined;const inputs:any[]=[],reads:string[]=[];
 const materials:WorkspaceMaterial[]=Array.from({length:count},(_,i)=>({workspaceId:'w'+i,instance:'w'+i+':instance',name:'task-'+i,taskBrief:'统计查询优化',createdAt:'2026-01-01',activityAt:new Date(Date.UTC(2026,0,i+1)).toISOString(),fingerprint:'fp-'+i,evidence:[{id:'commit:'+i,kind:'commit',text:'fix: use hourly summaries for statistics queries'}],state:'pending',complete:true,creatorAgentId:'agent',repositories:[{repositoryId:'one',repoPath:'one',productionRef:'production',state:'pending',covered:0,pending:1,uncertain:0,dirty:false,observedAt:'2026-01-01'}]}));
 const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}const parts=[];for await(const p of req)parts.push(p);const body=JSON.parse(Buffer.concat(parts).toString()),input=JSON.parse(body.messages[1].content);inputs.push(input);if(delay)await new Promise(r=>setTimeout(r,delay));afterModel?.();const result={workspaces:input.changedWorkspaces.map((w:any)=>({key:w.key,title:'统计查询优化',brief:'使用小时汇总减少重复扫描。',evidenceIds:[badSource?'fake':summaryCitation?w.key+'S':w.evidence[0].id]})),conversations:input.conversations.filter((c:any)=>c.evidence.length).map((c:any)=>({agentId:c.agentId,brief:'优化统计慢查询。',evidenceIds:[c.evidence[0].id]})),...(input.wantTitle?{title:{text:modelTitle,evidenceIds:['summary:'+(input.changedWorkspaces[0]?.key||input.workspaces.find((w:any)=>w.summary)?.key)]}}:{})};if(extraTitle&&!input.wantTitle)(result as any).title={text:'不应采用的额外标题',evidenceIds:['invalid-title-evidence']};if(echoCached){const cached=input.workspaces.find((w:any)=>w.summary);if(cached)result.workspaces.push({key:unknownWorkspace?'W999':cached.key,title:'不应发布的缓存改写',brief:'不应覆盖已有摘要。',evidenceIds:[cached.summary.sourceId]});}res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const settings=new OrganizerSettings(join(root,'settings'));settings.saveProfile(0,{id:'local',name:'Local',baseUrl:`http://127.0.0.1:${(server.address() as{port:number}).port}`,model:'fixture',contextTokens:16384,outputTokens:2048,timeoutMs:10000});
 const route={configPath:config,sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),treesRoot:join(root,'trees'),recordsRoot:join(root,'records'),socketPath:join(root,'s.sock'),displayName:'session'};
 settings.save('project',1,{profileId:'local',analysisIntervalSeconds:0,debounceSeconds:0},[],route);
 const agent={id:'agent',workspaceId:'native',cwd:root,archivedAt:null as string|null};let agentVisible=true;const api={agents:{list:async()=>({entries:agentVisible?[{agent}]:[],pageInfo:{hasMore:false}}),ref:()=>({timeline:{refetch:async(options:any)=>{let entries:any[]=options?.cursor?.seq>=head?[]:[{seqStart:head,seqEnd:head,item:{type:'user_message',text:messageText}}];if(toolHead>head&&(!options?.cursor||options.cursor.seq<toolHead))entries.push({seqStart:toolHead,seqEnd:toolHead,item:{type:'tool_call',name:'read'}});if(options.direction==='before'&&options.limit===1)entries=entries.slice(-1);return{epoch:'epoch',hasOlder:false,hasNewer:options.direction==='after'&&hasNewer,entries};}}})},workspaces:{list:async()=>({entries:[{id:'native',title}],pageInfo:{hasMore:false}}),ref:(id:string)=>({refresh:async()=>id==='native'?{id,title}:null,setTitle:async(value:string)=>{writes++;if(failWrite)throw Error('closed');title=value;}})}} as unknown as PaseoApi;
 const query=async({method,params}:any)=>{if(method==='organizer.versions'&&factsMode&&params.factsOnly)return{ok:true,result:{facts:Object.fromEntries(materials.map(m=>[m.workspaceId,{ready:true,commitKey:organizerHash(m.repositories.map(r=>[r.repositoryId,r.baseSha,r.head])),productionKey:organizerHash(m.repositories.map(r=>[r.repositoryId,r.productionRef,r.productionSha])),repositories:m.repositories.map(r=>({...r}))}]))}};if(method==='organizer.versions'&&versionCache)return{ok:true,result:{instanceId:'backend-generation',notesRevision:'notes-generation',materialTokens:Object.fromEntries(materials.map(m=>[m.workspaceId,JSON.stringify(m)]))}};if(method==='repository.compare')return{ok:true,result:{refs:[]}};if(method==='workspace.list')return {ok:true,result:{workspaces:materials.map((m,i)=>({id:m.workspaceId,instanceKey:m.instance,displayName:m.name,creator:{agentId:m.creatorAgentId},createdAt:m.createdAt,managed:true,state:'active',latestCommitAt:new Date(Date.UTC(2026,0,i+1)).toISOString()}))}};if(method==='notes.read')return{ok:true,result:{notes:[]}};if(method==='organizer.materials'){reads.push(params.workspaceId);if(failedRead===params.workspaceId){failedRead=undefined;return{ok:false,error:{code:'observer_timeout',message:'material read timed out'}};}if(readDelay)await new Promise(r=>setTimeout(r,readDelay));const material=structuredClone(materials.find(m=>m.workspaceId===params.workspaceId))!;if(factsMode&&params.committedOnly)material.fingerprint=material.committedFingerprint!;return {ok:true,result:material};}throw Error(method);};
 let service=new OrganizerService({settings,api:async()=>api,query:query as any});const request=async(request:any)=>{const value=await service.request({projectConfig:config,request});if(!value.ok)throw Error(value.error);return value.result as any;};
 const done=async(j:any)=>{for(let i=0;i<1000;i++){const state=await request({action:'job',jobId:j.id});if(!['running','queued'].includes(state.state))return state;await pause();}throw Error('timeout');};
 return{root,route,settings,service,agent,afterModel:(fn:()=>void)=>afterModel=fn,failReadOnce:(id:string)=>failedRead=id,checkSources:()=> (service as any).sessions.checkSources(route),enableCache:(value=true)=>versionCache=value,enableFacts:()=>{factsMode=true;versionCache=true;for(const m of materials){m.committedFingerprint=m.fingerprint;for(const r of m.repositories){r.head='head-'+m.workspaceId;r.baseSha='base';r.productionSha='production';r.committedState='pending';}}},commit:(index:number)=>{const m=materials[index];m.fingerprint+='-commit';m.committedFingerprint=m.fingerprint;m.repositories[0].head+='-commit';m.evidence.push({id:'commit:'+m.fingerprint,kind:'commit',text:'fix: repair committed business behavior'});},echoCache:(unknown=false)=>{echoCached=true;unknownWorkspace=unknown;},echoTitle:()=>extraTitle=true,citeSummary:(value:boolean)=>summaryCitation=value,hideAgent:()=>agentVisible=false,restart:async()=>{await service.close();service=new OrganizerService({settings,api:async()=>api,query:query as any});},request,done,materials,inputs,reads,counts:()=>({writes,calls:inputs.length}),title:(value?:string)=>{if(value)title=value;return title;},modelTitle:(value:string)=>{modelTitle=value;},delay:(value:number)=>{delay=value;},delayRead:(value:number)=>{readDelay=value;},longHistory:()=>{messageText="讨论统计查询与后续实现。".repeat(400);hasNewer=true;},toolActivity:()=>toolHead=Math.max(head,toolHead)+1,advance:()=>head=Math.max(head,toolHead)+1,bad:()=>badSource=true,failWrite:()=>failWrite=true,recoverWrite:()=>failWrite=false,close:async()=>{await service.close();await new Promise<void>(r=>server.close(()=>r()));if(oldRegistry===undefined)delete process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY;else process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY=oldRegistry;rmSync(root,{recursive:true,force:true});}};
}
test('session view batches its own workspaces, leaves native titles alone, and caches unchanged summaries',async()=>{
 const f=await fixture();try{const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);assert.equal(f.counts().calls,1);assert.equal(f.counts().writes,0);assert.equal(f.inputs[0].workspaces.find((w:any)=>w.key===f.inputs[0].latestWorkspace).name,'task-2');assert.equal(f.inputs[0].workspaces.length,3);assert.equal(f.inputs[0].wantTitle,true);
 const snapshot=await f.request({action:'snapshot',hostWorkspaceId:'native'});assert.equal(snapshot.workspaces.filter((w:any)=>w.digest).length,3);assert.equal(snapshot.targets[0].session.enabled,false);await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(f.counts().calls,1);
 }finally{await f.close();}
});
test('21 linked Workspaces authorize a cached title without repeating Git reads and reentry makes no model request',async()=>{
 const f=await fixture(21);try{
  f.enableCache();const preview=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(preview.state,'complete',preview.error);assert.equal(f.reads.length,21);assert.equal(f.counts().calls,6);
  f.reads.length=0;await f.request({action:'session.automatic',targetId:'native',enabled:true});const job=await f.done((await f.request({action:'snapshot'})).jobs[0]);assert.equal(job.state,'complete',job.error);assert.equal(f.title(),'○ 小时统计查询优化');assert.equal(job.result.titleWrites,1);assert.equal(job.model.calls,0);assert.equal(f.reads.length,0);
  const warm=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(warm.state,'complete',warm.error);assert.equal(warm.model.calls,0);assert.equal(f.reads.length,0);assert.equal(f.counts().writes,1);
 }finally{await f.close();}
});
test('an enabled title job reconciles Git and public messages that change during generation instead of leaving automatic stuck',async()=>{
 const f=await fixture(21);try{
  f.enableCache();await f.request({action:'session.associations',targetId:'native'});let changed=false;f.afterModel(()=>{if(changed)return;changed=true;f.materials[0].fingerprint='new-edit-during-generation';f.advance();});
  await f.request({action:'session.automatic',targetId:'native',enabled:true});const job=await f.done((await f.request({action:'snapshot'})).jobs[0]);assert.equal(job.state,'complete',job.error);assert.ok(job.events.some((e:any)=>e.stage==='retrying'));assert.equal(f.counts().writes,1);assert.equal(f.title(),'○ 小时统计查询优化');
  const t=(await f.request({action:'snapshot'})).targets[0];assert.equal(t.session.enabled,true);assert.equal(t.session.autoStart,undefined);assert.equal(t.session.error,undefined);assert.equal(job.total,21);assert.equal(job.completed,21);assert.equal(f.reads.filter(id=>id==='w0').length,3);assert.ok(f.materials.slice(1).every(w=>f.reads.filter(id=>id===w.workspaceId).length===1));
 }finally{await f.close();}
});
test('new public messages do not restart an authorized committed title while it is generated',async()=>{
 const f=await fixture();try{
  f.enableCache();await f.request({action:'session.associations',targetId:'native'});let moved=false;f.afterModel(()=>{if(!moved){moved=true;f.advance();}});
  const settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{analysisIntervalSeconds:300},[],f.route);await f.request({action:'session.automatic',targetId:'native',enabled:true});const job=await f.done((await f.request({action:'snapshot'})).jobs[0]);assert.equal(job.state,'complete',job.error);assert.equal(job.model.calls,1);assert.equal(f.counts().writes,1);assert.ok(!job.events.some((e:any)=>e.stage==='retrying'));assert.equal(f.reads.length,3);
 }finally{await f.close();}
});
test('a parallel material refresh cannot attach an old model result to a newer fingerprint',async()=>{
 const f=await fixture();try{
  f.enableCache();let changed=false;f.afterModel(()=>{if(changed)return;changed=true;f.materials[0].fingerprint='parallel-edit';f.service.store(f.route).update(l=>{l.workspaces[f.materials[0].instance].material.fingerprint='parallel-edit';});});
  const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'failed');assert.equal(job.error,'organizer_source_changed');assert.equal(f.counts().writes,0);assert.equal((await f.request({action:'snapshot'})).workspaces.find((w:any)=>w.key===f.materials[0].instance).digest,undefined);
 }finally{await f.close();}
});
test('public message changes alone do not restart automatic generation or drain old history',async()=>{
 const f=await fixture();try{
  f.enableCache();await f.request({action:'session.associations',targetId:'native'});f.afterModel(()=>f.advance());await f.request({action:'session.automatic',targetId:'native',enabled:true});const job=await f.done((await f.request({action:'snapshot'})).jobs[0]);assert.equal(job.state,'complete',job.error);assert.equal(f.counts().calls,1);assert.equal(f.counts().writes,1);await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(f.counts().calls,1);assert.equal((await f.request({action:'snapshot'})).targets[0].session.enabled,true);
 }finally{await f.close();}
});
test('a transient material timeout resumes an enabled job and stopping retries prevents any native title write',async()=>{
 for(const stop of [false,true]){const f=await fixture();try{
  f.enableCache();await f.request({action:'session.associations',targetId:'native'});f.failReadOnce('w1');await f.request({action:'session.automatic',targetId:'native',enabled:true});const job=(await f.request({action:'snapshot'})).jobs[0];
  if(stop){for(let i=0;i<300;i++){if((await f.request({action:'job',jobId:job.id})).stage==='retrying')break;await pause();}await f.request({action:'session.automatic',targetId:'native',enabled:false});}
  const finished=await f.done(job);assert.equal(finished.state,stop?'cancelled':'complete',finished.error);assert.equal(f.counts().writes,stop?0:1);if(!stop)assert.deepEqual(f.reads,['w2','w1','w1','w0']);
 }finally{await f.close();}}
});
test('turning Off detaches from a slow shared material read without waiting for its background budget',async()=>{
 const f=await fixture();try{
  f.enableCache();await f.request({action:'session.associations',targetId:'native'});f.delayRead(1000);await f.request({action:'session.automatic',targetId:'native',enabled:true});const job=(await f.request({action:'snapshot'})).jobs[0];for(let i=0;i<200&&!f.reads.length;i++)await pause();assert.ok(f.reads.length);
  const start=Date.now();await f.request({action:'session.automatic',targetId:'native',enabled:false});assert.equal((await f.done(job)).state,'cancelled');assert.ok(Date.now()-start<500);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('material changes observed during model cooldown run automatically when that cooldown expires',async()=>{
 const f=await fixture();try{
  f.enableCache();await f.request({action:'session.associations',targetId:'native'});const settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{analysisIntervalSeconds:1},[],f.route);await f.request({action:'session.automatic',targetId:'native',enabled:true});await f.done((await f.request({action:'snapshot'})).jobs[0]);f.materials[1].fingerprint='cooldown-edit';
  const checked=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(checked.model.calls,0);assert.equal(checked.model.reason,'interval');
  for(let i=0;i<600;i++){const s=await f.request({action:'snapshot'}),w=s.workspaces.find((w:any)=>w.material.workspaceId==='w1');if(w.digest?.fingerprint===w.material.fingerprint&&s.jobs[0].state==='complete')break;await pause();}
  const s=await f.request({action:'snapshot'});assert.equal(s.workspaces.find((w:any)=>w.material.workspaceId==='w1').digest.fingerprint,s.workspaces.find((w:any)=>w.material.workspaceId==='w1').material.fingerprint);assert.equal(f.counts().calls,2);assert.equal(s.targets[0].session.enabled,true);
 }finally{await f.close();}
});
test('turning automatic on during an existing model request returns immediately and reuses that exact job',async()=>{
 const f=await fixture();try{
  f.enableCache();f.delay(1000);const job=await f.request({action:'session.refresh',targetId:'native',preview:true});for(let i=0;i<200&&!f.counts().calls;i++)await pause();
  const start=Date.now(),target=await f.request({action:'session.automatic',targetId:'native',enabled:true});assert.equal(target.session.enabled,true);assert.ok(Date.now()-start<500);assert.equal(f.counts().writes,0);
  let view=await f.request({action:'snapshot'});assert.ok(view.jobs.filter((j:any)=>['queued','running'].includes(j.state)).length<=2);await f.request({action:'session.automatic',targetId:'native',enabled:true});assert.equal((await f.request({action:'snapshot'})).jobs.length,view.jobs.length);
  await f.done(job);const finished=await f.done((await f.request({action:'snapshot'})).jobs.find((j:any)=>j.id!==job.id)||job);assert.equal(finished.state,'complete',finished.error);assert.equal(f.counts().calls,1);assert.equal(f.counts().writes,1);assert.equal(f.title(),'○ 小时统计查询优化');view=await f.request({action:'snapshot'});assert.equal(view.targets[0].session.autoStart,undefined);
 }finally{await f.close();}
});
test('automatic can be enabled before materials finish, disabled immediately, and cannot write after shutdown of its control',async()=>{
 const f=await fixture();try{
  await f.request({action:'session.associations',targetId:'native'});f.delayRead(100);const enabled=await f.request({action:'session.automatic',targetId:'native',enabled:true});assert.equal(enabled.session.enabled,true);assert.equal(f.counts().calls,0);
  const view=await f.request({action:'snapshot'}),job=view.jobs[0],disabled=await f.request({action:'session.automatic',targetId:'native',enabled:false});assert.equal(disabled.session.enabled,false);assert.equal(disabled.session.autoStart,undefined);assert.equal((await f.done(job)).state,'cancelled');assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('one-click automatic consumes a valid cached suggestion and adopts an unchanged native title without regeneration',async()=>{
 const f=await fixture();try{
  f.enableCache();await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));let settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{analysisIntervalSeconds:300},[],f.route);
  for(let n=0;n<2;n++){const target=await f.request({action:'session.automatic',targetId:'native',enabled:true});assert.equal(target.session.enabled,true);const view=await f.request({action:'snapshot'}),job=await f.done(view.jobs[0]);assert.equal(job.state,'complete',job.error);assert.equal(f.counts().calls,1);assert.equal(f.counts().writes,1);assert.equal((await f.request({action:'snapshot'})).targets[0].session.autoStart,undefined);await f.request({action:'session.automatic',targetId:'native',enabled:false});}
  settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{markers:{...settings.effective.markers,pending:'🔴'}},[],f.route);await f.request({action:'session.automatic',targetId:'native',enabled:true});const job=await f.done((await f.request({action:'snapshot'})).jobs[0]);assert.equal(job.state,'complete',job.error);assert.equal(f.title(),'🔴 小时统计查询优化');assert.equal(f.counts().calls,1);
 }finally{await f.close();}
});
test('one-click authorization preserves a title changed after the click and may explicitly resume a visible manual title',async()=>{
 const f=await fixture();try{
  await f.request({action:'session.associations',targetId:'native'});f.title('外部新标题');await f.request({action:'session.automatic',targetId:'native',enabled:true});let job=await f.done((await f.request({action:'snapshot'})).jobs[0]);assert.equal(job.state,'complete',job.error);let target=(await f.request({action:'snapshot'})).targets[0];assert.equal(target.session.enabled,false);assert.equal(f.title(),'外部新标题');assert.equal(f.counts().writes,0);
  await f.request({action:'session.automatic',targetId:'native',enabled:true});job=await f.done((await f.request({action:'snapshot'})).jobs[0]);assert.equal(job.state,'complete',job.error);target=(await f.request({action:'snapshot'})).targets[0];assert.equal(target.session.enabled,true);assert.equal(f.title(),'○ 小时统计查询优化');
 }finally{await f.close();}
});
test('model failure leaves automatic enabled with a visible error but does not retry unchanged material every observation',async()=>{
 const f=await fixture();try{
  f.enableCache();await f.request({action:'session.associations',targetId:'native'});f.bad();await f.request({action:'session.automatic',targetId:'native',enabled:true});const job=await f.done((await f.request({action:'snapshot'})).jobs[0]);assert.equal(job.state,'failed');const target=(await f.request({action:'snapshot'})).targets[0];assert.equal(target.session.enabled,true);assert.ok(target.session.error);const calls=f.counts().calls;await f.checkSources();await f.checkSources();await pause();assert.equal(f.counts().calls,calls);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('reentering an enabled session and opening previews reuse verified Git materials and unfinished summaries across reloads',async()=>{
 const f=await fixture();try{
  f.enableCache();f.longHistory();await f.request({action:'session.associations',targetId:'native'});await f.done(await f.request({action:'session.history',targetId:'native'}));let job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);
  let snapshot=await f.request({action:'snapshot'});const offset=snapshot.conversations[0].pendingMessage.offset;
  await f.request({action:'session.apply',targetId:'native',previewId:snapshot.targets[0].session.preview.id});const before=f.reads.length;
  for(const preview of [false,false,true]){job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview}));assert.equal(job.state,'complete',job.error);assert.equal(job.model.calls,0);assert.equal(job.result.previewReady,true);assert.ok(job.input.workspaces.every((w:any)=>w.materialCached));assert.ok(!job.events.some((e:any)=>['materials','verifying','titles'].includes(e.stage)));}
  assert.equal(f.reads.length,before);assert.equal(f.counts().writes,1);await f.restart();job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);assert.equal(f.reads.length,before);assert.equal(job.model.calls,0);
  snapshot=await f.request({action:'snapshot'});assert.equal(snapshot.conversations[0].pendingMessage.offset,offset);assert.equal(snapshot.targets[0].session.enabled,true);
 }finally{await f.close();}
});
test('source changes reload only the affected Workspace and degraded versions fall back to full verification',async()=>{
 const f=await fixture();try{
  f.enableCache();assert.equal((await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}))).state,'complete');f.reads.length=0;
  f.materials[1].fingerprint='changed';const changed=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(changed.state,'complete',changed.error);assert.deepEqual(f.reads,['w1']);assert.equal(changed.model.calls,1);assert.equal(changed.input.workspaces.filter((w:any)=>!w.materialCached).length,1);
  f.enableCache(false);f.reads.length=0;const degraded=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(degraded.state,'complete',degraded.error);assert.deepEqual(f.reads,['w2','w1','w0']);assert.equal(degraded.model.calls,0);
 }finally{await f.close();}
});
test('a finished preview is marked stale when a later interval check discovers new source material',async()=>{
 const f=await fixture();try{
  f.enableCache();let settings=await f.request({action:'settings.get'});await f.request({action:'settings.save',scope:'project',revision:settings.revision,patch:{analysisIntervalSeconds:300},reset:[]});
  const initial=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));let snapshot=await f.request({action:'snapshot'});const oldId=snapshot.targets[0].session.preview.id;assert.equal(initial.result.previewId,oldId);assert.equal(snapshot.previewStates.native,'ready');await f.request({action:'session.apply',targetId:'native',previewId:oldId});
  f.materials[0].fingerprint='actual-edit';const checked=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(checked.state,'complete',checked.error);assert.equal(checked.model.calls,0);assert.equal(checked.result.previewReady,false);assert.equal(checked.result.previewId,undefined);
  snapshot=await f.request({action:'snapshot'});assert.equal(snapshot.previewStates.native,'source');assert.equal(snapshot.targets[0].session.preview.id,oldId);await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId:oldId}),/organizer_preview_changed/);assert.equal(f.counts().writes,1);
  const refreshed=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));snapshot=await f.request({action:'snapshot'});assert.equal(snapshot.previewStates.native,'ready');assert.equal(refreshed.result.previewId,snapshot.targets[0].session.preview.id);assert.notEqual(refreshed.result.previewId,oldId);await f.request({action:'session.apply',targetId:'native',previewId:refreshed.result.previewId});assert.equal((await f.request({action:'snapshot'})).targets[0].session.enabled,true);
  settings=await f.request({action:'settings.get'});await f.request({action:'settings.save',scope:'project',revision:settings.revision,patch:{prompt:'新的命名指令'},reset:[]});assert.equal((await f.request({action:'snapshot'})).previewStates.native,'configuration');
 }finally{await f.close();}
});
test('a legacy production refresh retains session ordering metadata and does not expire its preview',async()=>{
 const f=await fixture();try{
  await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));const before=await f.request({action:'snapshot'}),id=before.targets[0].session.preview.id;
  assert.equal((await f.done(await f.request({action:'refresh'}))).state,'complete');const after=await f.request({action:'snapshot'});assert.equal(after.previewStates.native,'ready');assert.deepEqual(after.workspaces.map((w:any)=>w.material.latestCommitAt),before.workspaces.map((w:any)=>w.material.latestCommitAt));assert.equal(f.counts().calls,1);
  await f.request({action:'session.apply',targetId:'native',previewId:id});assert.equal((await f.request({action:'snapshot'})).targets[0].session.enabled,true);
 }finally{await f.close();}
});
test('the whole requirement stays unshipped until every Workspace committed change is deployed, with a separate working hint',async()=>{
 const f=await fixture();try{
  for(const m of f.materials){m.state='deployed';Object.assign(m.repositories[0],{state:'partial',committedState:'deployed',dirty:true,covered:1,pending:1,coverageComplete:true});}
  let job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true})),target=(await f.request({action:'snapshot'})).targets[0];assert.equal(job.state,'complete',job.error);assert.equal(target.state,'deployed');assert.equal(target.hasUncommittedChanges,true);assert.equal(target.session.preview.title,'✓ ✎ 小时统计查询优化');await f.request({action:'session.apply',targetId:'native',previewId:target.session.preview.id});
  f.materials[0].state='pending';Object.assign(f.materials[0].repositories[0],{committedState:'pending',pending:2});job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));target=(await f.request({action:'snapshot'})).targets[0];assert.equal(job.model.calls,0);assert.equal(target.state,'pending');assert.equal(f.title(),'○ ✎ 小时统计查询优化');
 }finally{await f.close();}
});
test('changing title markers previews the cached body without a model request and still requires confirmation',async()=>{
 const f=await fixture();try{
  f.enableCache();await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));let target=(await f.request({action:'snapshot'})).targets[0];
  await f.request({action:'session.apply',targetId:'native',previewId:target.session.preview.id});const title=f.title(),counts=f.counts(),oldPreviewId=target.session.preview.id;
  f.service.store(f.route).update(l=>{delete l.targets.native.session!.preview!.contentConfigurationFingerprint;});assert.equal((await f.done(await f.request({action:'session.refresh',targetId:'native'}))).model.calls,0);
  let settings=await f.request({action:'settings.get'});await f.request({action:'settings.save',scope:'project',revision:settings.revision,patch:{markers:{...settings.effective.markers,pending:'🔴'}},reset:[]});
  await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId:oldPreviewId}),/organizer_preview_changed/);
  const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);assert.equal(job.model.calls,0);assert.equal(job.result.previewReady,true);assert.equal(f.title(),title);assert.deepEqual(f.counts(),counts);
  target=(await f.request({action:'snapshot'})).targets[0];assert.equal(target.session.enabled,false);assert.notEqual(target.session.preview.id,oldPreviewId);assert.equal(target.session.preview.title,'🔴 小时统计查询优化');
  await f.request({action:'session.apply',targetId:'native',previewId:target.session.preview.id});assert.equal(f.title(),'🔴 小时统计查询优化');assert.equal(f.counts().calls,counts.calls);assert.equal((await f.request({action:'snapshot'})).targets[0].session.enabled,true);
  settings=await f.request({action:'settings.get'});await f.request({action:'settings.save',scope:'project',revision:settings.revision,patch:{prompt:'按业务对象与问题命名，避免实现细节。'},reset:[]});
  const changed=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(changed.state,'complete',changed.error);assert.equal(changed.model.calls,1);assert.equal((await f.request({action:'snapshot'})).targets[0].session.enabled,false);
 }finally{await f.close();}
});
test('expired material proofs and explicit force refreshes cannot silently reuse a previous Git check',async()=>{
 const f=await fixture();try{
  f.enableCache();await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));f.service.store(f.route).update(l=>{for(const w of Object.values(l.workspaces))w.materialCache!.at='2000-01-01';});f.reads.length=0;
  const expired=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(expired.state,'complete',expired.error);assert.equal(expired.model.calls,0);assert.equal(f.reads.length,3);assert.ok(expired.input.workspaces.every((w:any)=>!w.materialCached));
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
 const f=await fixture();try{f.enableFacts();const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);const s=await f.request({action:'snapshot'}),t=s.targets[0];assert.equal(t.session.preview.body,'小时统计查询优化');assert.notEqual(t.session.preview.body,s.workspaces[0].digest.title);assert.equal(f.counts().writes,0);await f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id});assert.equal(f.title(),'○ 小时统计查询优化');assert.equal(f.counts().writes,1);
 f.modelTitle('统计读取边界修复');f.commit(2);const next=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(next.state,'complete',next.error);assert.equal(f.title(),'○ 统计读取边界修复');
 await f.request({action:'session.automatic',targetId:'native',enabled:false});f.commit(2);await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(f.counts().writes,2);
 }finally{await f.close();}
});
test('unrelated or empty sessions never analyze other workspaces and empty baselines receive no invented digest',async()=>{
 const f=await fixture();try{await f.done(await f.request({action:'session.refresh',targetId:'missing'}));assert.equal(f.reads.length,0);assert.equal(f.counts().calls,0);f.materials[0].evidence=[];const j=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(j.state,'complete',j.error);const snapshot=await f.request({action:'snapshot'});assert.equal(snapshot.workspaces.find((w:any)=>w.material.workspaceId==='w0').digest,undefined);assert.equal(f.inputs[0].changedWorkspaces.length,2);
 }finally{await f.close();}
});
test('changed material, incoming messages and external names invalidate a frozen confirmation',async()=>{
 const f=await fixture();try{await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));let t=(await f.request({action:'snapshot'})).targets[0];f.advance();await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id}),/source_changed/);assert.equal(f.counts().writes,0);
 await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));t=(await f.request({action:'snapshot'})).targets[0];f.title('人工标题');await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id}),/external_title/);assert.equal(f.title(),'人工标题');assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('uncertain title writes pause maintenance and are never automatically replayed',async()=>{
 const f=await fixture();try{await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));const t=(await f.request({action:'snapshot'})).targets[0];f.failWrite();await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id}),/closed/);assert.equal(f.counts().writes,1);await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(f.counts().writes,1);assert.equal((await f.request({action:'snapshot'})).targets[0].session.enabled,false);
 await assert.rejects(f.request({action:'session.automatic',targetId:'native',enabled:true}),/write_uncertain/);assert.equal(f.counts().writes,1);
 }finally{await f.close();}
});
test('rapid on-off-on preserves the final intent and a pending first update resumes after restart',async()=>{
 const f=await fixture();try{
  f.enableCache();await f.request({action:'session.associations',targetId:'native'});f.delayRead(40);await f.request({action:'session.automatic',targetId:'native',enabled:true});await f.request({action:'session.automatic',targetId:'native',enabled:false});await f.request({action:'session.automatic',targetId:'native',enabled:true});
  let view=await f.request({action:'snapshot'});await f.done(view.jobs[0]);assert.equal(f.counts().writes,1);assert.equal(view.targets[0].session.enabled,true);
  await f.request({action:'session.automatic',targetId:'native',enabled:false});f.materials[0].fingerprint+='-new';await f.request({action:'session.automatic',targetId:'native',enabled:true});await f.restart();await f.request({action:'snapshot'});await f.checkSources();for(let i=0;i<500;i++){view=await f.request({action:'snapshot'});if(!view.targets[0].session.autoStart)break;await pause();}assert.equal(view.targets[0].session.autoStart,undefined);assert.equal(view.targets[0].session.enabled,true);
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
 const f=await fixture();try{f.longHistory();await f.request({action:'session.associations',targetId:'native'});await f.done(await f.request({action:'session.history',targetId:'native'}));let job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);let s=await f.request({action:'snapshot'});assert.equal(s.conversations[0].complete,false);assert.ok(s.conversations[0].pendingMessage);const cursor=s.conversations[0].pendingMessage.offset;
 job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);assert.equal(job.model.calls,0);assert.equal(f.counts().calls,2);s=await f.request({action:'snapshot'});assert.equal(s.conversations[0].pendingMessage.offset,cursor);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('more than four changed workspaces use bounded batches and the first title receives every workspace',async()=>{
 const f=await fixture();try{for(let i=3;i<6;i++){const m=structuredClone(f.materials[0]);m.workspaceId='w'+i;m.instance='w'+i+':instance';m.name='task-'+i;m.fingerprint='fp-'+i;f.materials.push(m);}const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);assert.deepEqual(f.inputs.map(i=>i.changedWorkspaces.length),[4,2]);assert.equal(f.inputs[0].workspaces.length,6);assert.equal(f.inputs[0].wantTitle,true);assert.equal(f.inputs[1].wantTitle,false);assert.equal(f.inputs[1].workspaces.length,2);assert.equal((await f.request({action:'snapshot'})).workspaces.filter((w:any)=>w.digest).length,6);
 }finally{await f.close();}
});
test('switching maintenance off while confirmation checks are in flight prevents a title write',async()=>{
 const f=await fixture();try{await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));const t=(await f.request({action:'snapshot'})).targets[0];f.delayRead(30);const applying=f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id});await pause();await f.request({action:'session.automatic',targetId:'native',enabled:false});await assert.rejects(applying,/cancelled/);assert.equal(f.counts().writes,0);assert.equal((await f.request({action:'snapshot'})).targets[0].session.enabled,false);
 }finally{await f.close();}
});
test('production-only state changes update the marker within the analysis interval without another model request',async()=>{
 const f=await fixture();try{await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));let t=(await f.request({action:'snapshot'})).targets[0];await f.request({action:'session.apply',targetId:'native',previewId:t.session.preview.id});const settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{analysisIntervalSeconds:300},[],f.route);for(const material of f.materials){material.state='deployed';Object.assign(material.repositories[0],{state:'deployed',covered:1,pending:0,uncertain:0});}
 const job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(f.title(),'✓ 小时统计查询优化');assert.equal(f.counts().calls,1);assert.equal(f.counts().writes,2);
 }finally{await f.close();}
});
test('source observation removes and restores the working marker during model cooldown without accepting a stale preview',async()=>{
 const f=await fixture();try{
  f.enableCache();const settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{analysisIntervalSeconds:300},[],f.route);
  for(const m of f.materials){m.repositories[0].dirty=true;m.fingerprint+='-dirty';}
  await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));let view=await f.request({action:'snapshot'}),previewId=view.targets[0].session.preview.id;
  await f.request({action:'session.apply',targetId:'native',previewId});assert.equal(f.title(),'○ ✎ 小时统计查询优化');const calls=f.counts().calls,writes=f.counts().writes;
  for(const m of f.materials){m.repositories[0].dirty=false;m.fingerprint+='-clean';}
  await f.checkSources();
  for(let i=0;i<200&&f.counts().writes===writes;i++)await pause();
  assert.equal(f.title(),'○ 小时统计查询优化');assert.equal(f.counts().calls,calls);view=await f.request({action:'snapshot'});assert.equal(view.previewStates.native,'source');assert.equal(view.targets[0].session.preview.id,previewId);assert.equal(view.targets[0].session.acceptedBody,'小时统计查询优化');
  await assert.rejects(f.request({action:'session.apply',targetId:'native',previewId}),/preview_changed/);
  const reads=f.reads.length,jobs=view.jobs.length;await f.checkSources();await f.checkSources();await pause();view=await f.request({action:'snapshot'});assert.equal(view.jobs.length,jobs);assert.equal(f.reads.length,reads);
  f.materials[1].repositories[0].dirty=true;f.materials[1].fingerprint+='-new-edit';await f.checkSources();for(let i=0;i<200&&f.title()==='○ 小时统计查询优化';i++)await pause();assert.equal(f.title(),'○ ✎ 小时统计查询优化');assert.equal(f.counts().calls,calls);
  await f.request({action:'session.automatic',targetId:'native',enabled:false});f.materials[1].repositories[0].dirty=false;f.materials[1].fingerprint+='-clean';const stopped=f.counts().writes;await f.checkSources();await pause();assert.equal(f.counts().writes,stopped);
 }finally{await f.close();}
});
test('background status maintenance retains external titles and pauses the session',async()=>{
 const f=await fixture();try{
  f.enableCache();await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));let target=(await f.request({action:'snapshot'})).targets[0];await f.request({action:'session.apply',targetId:'native',previewId:target.session.preview.id});const writes=f.counts().writes;
  f.title('用户新标题');f.materials[0].repositories[0].dirty=true;f.materials[0].fingerprint+='-edit';await f.checkSources();for(let i=0;i<200;i++){target=(await f.request({action:'snapshot'})).targets[0];if(!target.session.enabled)break;await pause();}
  assert.equal(f.title(),'用户新标题');assert.equal(f.counts().writes,writes);assert.equal(target.session.enabled,false);
 }finally{await f.close();}
});
test('a local packing failure does not start the model cooldown or block the first real request',async()=>{
 const f=await fixture();try{
  let settings=f.settings.response(f.route);const profile=settings.profiles[0];f.settings.save('project',settings.revision,{analysisIntervalSeconds:300},[],f.route);
  settings=f.settings.response(f.route);f.settings.saveProfile(settings.revision,{...profile,contextTokens:2048,outputTokens:2048});
  const failed=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(failed.state,'failed');assert.match(failed.error,/context_allocation_invalid/);assert.equal(failed.model.calls,0);assert.equal((await f.request({action:'snapshot'})).targets[0].session.lastAttemptAt,undefined);
  settings=f.settings.response(f.route);f.settings.saveProfile(settings.revision,profile);
  const retried=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(retried.state,'complete',retried.error);assert.equal(retried.model.calls,1);assert.equal(retried.result.previewReady,true);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('changed workspace summaries exclude stale cached prose and must cite current original evidence',async()=>{
 const f=await fixture();try{
  assert.equal((await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}))).state,'complete');
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
 const f=await fixture();try{for(const m of f.materials){m.state='deployed';Object.assign(m.repositories[0],{state:'deployed',covered:1,pending:0,uncertain:0});}const baseline=structuredClone(f.materials[0]);baseline.workspaceId='baseline';baseline.instance='baseline:instance';baseline.taskBrief='同步生产基线';baseline.evidence=[{id:'goal:baseline',kind:'goal',text:'同步生产基线'}];baseline.state=baseline.repositories[0].state='discussion';f.materials.push(baseline);
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
  const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);assert.equal(f.inputs[0].workspaces.length,1);assert.equal(f.inputs[0].conversations.length,1);assert.deepEqual((await f.request({action:'snapshot'})).targets[0].agentIds,['agent']);assert.equal(f.counts().writes,0);
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
  await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));const before=await f.request({action:'snapshot'});f.echoCache();f.advance();
  const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);assert.equal(job.result.previewReady,true);assert.equal(f.inputs.at(-1).changedWorkspaces.length,0);assert.equal(f.inputs.at(-1).wantTitle,true);
  const after=await f.request({action:'snapshot'});assert.deepEqual(after.workspaces.map((w:any)=>w.digest),before.workspaces.map((w:any)=>w.digest));assert.equal(after.targets[0].session.preview.body,'小时统计查询优化');assert.equal(after.targets[0].session.error,undefined);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('unrequested workspace echoes with unknown identities still fail instead of being silently discarded',async()=>{
 const f=await fixture();try{
  await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));f.echoCache(true);f.advance();const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'failed');assert.match(job.error,/workspace_invalid/);assert.equal(job.result.failed,1);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('a newly associated session prepares its own title even when every Workspace summary is cached',async()=>{
 const f=await fixture();try{
  await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));f.service.store(f.route).update(l=>{delete l.targets.native.session!.preview;});
  const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);assert.equal(job.result.previewReady,true);assert.equal(job.result.analyzed,0);assert.equal(job.result.cached,3);assert.equal(f.inputs.at(-1).wantTitle,true);assert.equal(f.inputs.at(-1).changedWorkspaces.length,0);assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('progress distinguishes material reads, history pages, real model requests and a ready title',async()=>{
 const f=await fixture();try{
  f.delayRead(50);f.delay(200);const job=await f.request({action:'session.refresh',targetId:'native',preview:true});let reading:any,requesting:any;
  for(let i=0;i<500;i++){const current=await f.request({action:'job',jobId:job.id});if(current.stage==='materials')reading=current;if(current.stage==='requesting'){requesting=current;break;}await pause();}
  assert.equal(sessionJobProgress(reading).label,'读取提交与差异');assert.equal(reading.model.calls,0);assert.ok(reading.current.workspaceId);
  assert.equal(sessionJobProgress(requesting).label,'生成标题和摘要');assert.equal(requesting.model.calls,1);assert.equal(requesting.input.workspaces.length,3);assert.equal(requesting.input.history.pages,1);assert.ok(requesting.input.history.fragments>0);
  const done=await f.done(job);assert.equal(done.result.previewReady,true);assert.equal(sessionJobProgress(done).label,'标题建议已就绪');assert.match(sessionJobProgress(done).detail,/本地模型 1 次/);assert.ok(done.events.some((e:any)=>e.stage==='conversation'));assert.ok(done.events.some((e:any)=>e.stage==='verifying'));assert.ok(done.events.some((e:any)=>e.current?.workspaceId));
 }finally{await f.close();}
});
test('latest naming returns a title in the first batch and ignores unrequested titles in later summaries',async()=>{
 const f=await fixture();try{
  for(let i=3;i<6;i++){const m=structuredClone(f.materials[0]);m.workspaceId='w'+i;m.instance='w'+i+':instance';m.fingerprint='fp-'+i;f.materials.push(m);}f.echoTitle();
  const job=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(job.state,'complete',job.error);assert.equal(f.inputs[0].wantTitle,true);assert.equal(f.inputs[1].wantTitle,false);assert.equal(job.model.calls,2);assert.equal((await f.request({action:'snapshot'})).targets[0].session.preview.body,'小时统计查询优化');assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('explicit title preview remains read-only even while automatic title maintenance is enabled',async()=>{
 const f=await fixture();try{
  await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));const before=(await f.request({action:'snapshot'})).targets[0];await f.request({action:'session.apply',targetId:'native',previewId:before.session.preview.id});const accepted=f.title();
  f.modelTitle('统计边界问题修复');f.materials[0].fingerprint='new-material';f.materials[0].repositories[0].dirty=true;const preview=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(preview.state,'complete',preview.error);assert.equal(preview.result.previewReady,true);assert.equal((await f.request({action:'snapshot'})).targets[0].session.preview.body,'统计边界问题修复');assert.equal(f.title(),accepted);assert.equal(f.counts().writes,1);
 }finally{await f.close();}
});

test('ordinary entry and Git changes make zero model requests while this session is off',async()=>{
 const f=await fixture();try{f.enableFacts();for(let i=0;i<3;i++){f.commit(0);const job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete');assert.equal(job.model.reason,'automatic-off');}assert.equal(f.counts().calls,0);assert.equal(f.reads.length,0);assert.equal(f.counts().writes,0);}
 finally{await f.close();}
});
test('automatic only handles linked Workspaces and ignores edits, upstream merges, messages and production-only changes',async()=>{
 const f=await fixture(4);try{
  f.enableFacts();f.materials[3].creatorAgentId='unrelated-agent';await f.request({action:'session.associations',targetId:'native'});await f.request({action:'session.automatic',targetId:'native',enabled:true});let view=await f.request({action:'snapshot'});assert.equal((await f.done(view.jobs[0])).state,'complete');const calls=f.counts().calls;assert.equal(calls,1);assert.ok(!f.reads.includes('w3'));assert.ok(f.inputs.every(input=>!input.workspaces.some((w:any)=>w.name==='task-3')));
  f.reads.length=0;f.materials[0].fingerprint='uncommitted-edit';f.materials[0].repositories[0].dirty=true;f.advance();let job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(f.counts().calls,calls);assert.equal(f.reads.length,0);assert.match(f.title()!,/✎/);
  f.materials[0].repositories[0].head+='-incoming-merge';job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(f.counts().calls,calls);
  for(const m of f.materials.slice(0,3)){m.state='deployed';m.repositories[0].productionSha='production-new';m.repositories[0].committedState='deployed';}job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(f.counts().calls,calls);assert.match(f.title()!,/^✓/);
  f.commit(1);job=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(f.counts().calls,calls+1);assert.equal(job.result.analyzed,1);
  await f.request({action:'session.automatic',targetId:'native',enabled:false});f.commit(1);await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(f.counts().calls,calls+1);
 }finally{await f.close();}
});

test('manual history advances one checkpoint without writing a title or being resumed by page entry',async()=>{
 const f=await fixture();try{f.enableFacts();f.longHistory();await f.request({action:'session.associations',targetId:'native'});const job=await f.done(await f.request({action:'session.history',targetId:'native'}));assert.equal(job.state,'complete',job.error);assert.equal(f.counts().calls,1);const before=await f.request({action:'snapshot'});assert.ok(before.conversations[0].pendingMessage);assert.equal(f.counts().writes,0);assert.ok(f.inputs.every(input=>!input.wantTitle&&input.changedWorkspaces.length===0));await f.done(await f.request({action:'session.refresh',targetId:'native'}));const after=await f.request({action:'snapshot'});assert.deepEqual(after.conversations[0].pendingMessage,before.conversations[0].pendingMessage);assert.equal(f.counts().calls,1);}
 finally{await f.close();}
});

test('latest naming writes the first valid title before reading the remaining cold associated Workspaces',async()=>{
 const f=await fixture(21);try{f.enableFacts();f.delayRead(40);await f.request({action:'session.associations',targetId:'native'});await f.request({action:'session.automatic',targetId:'native',enabled:true});const job=(await f.request({action:'snapshot'})).jobs[0];for(let i=0;i<500&&!f.counts().writes;i++)await pause();assert.equal(f.counts().writes,1);assert.ok(f.reads.length<=5,'a title must not wait for all 21 material reads');assert.equal((await f.request({action:'job',jobId:job.id})).state,'running');const done=await f.done(job);assert.equal(done.state,'complete',done.error);assert.equal(f.counts().calls,6);assert.equal((await f.request({action:'snapshot'})).workspaces.filter((w:any)=>w.digest).length,21);assert.equal(f.inputs[0].wantTitle,true);assert.ok(f.inputs.slice(1).every(input=>!input.wantTitle));}
 finally{await f.close();}
});

test('editing files during a committed generation refreshes the working marker without another model call',async()=>{
 const f=await fixture();try{f.enableFacts();await f.request({action:'session.associations',targetId:'native'});f.afterModel(()=>{f.materials[0].fingerprint='only-working-files';f.materials[0].repositories[0].dirty=true;});await f.request({action:'session.automatic',targetId:'native',enabled:true});const job=await f.done((await f.request({action:'snapshot'})).jobs[0]);assert.equal(job.state,'complete',job.error);assert.equal(f.counts().calls,1);assert.match(f.title()!,/✎/);assert.equal((await f.request({action:'snapshot'})).targets[0].session.hasUncommittedChanges,undefined);assert.equal((await f.request({action:'snapshot'})).targets[0].hasUncommittedChanges,true);}
 finally{await f.close();}
});

test('an unaccepted working preview cannot leak into automatic title writes on the next ordinary refresh',async()=>{
 const f=await fixture();try{
  f.enableFacts();await f.request({action:'session.associations',targetId:'native'});await f.request({action:'session.automatic',targetId:'native',enabled:true});await f.done((await f.request({action:'snapshot'})).jobs[0]);const accepted=(await f.request({action:'snapshot'})).targets[0].session.acceptedBody;
  f.materials[0].fingerprint='uncommitted-preview';f.materials[0].repositories[0].dirty=true;f.modelTitle('统计边界处理修复');const preview=await f.done(await f.request({action:'session.refresh',targetId:'native',preview:true}));assert.equal(preview.state,'complete',preview.error);assert.ok(!f.title()!.includes('统计边界处理修复'));const calls=f.counts().calls;
  const checked=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(checked.state,'complete',checked.error);assert.equal(f.counts().calls,calls);assert.ok(f.title()!.endsWith(accepted));assert.match(f.title()!,/✎/);
  f.commit(0);const committed=await f.done(await f.request({action:'session.refresh',targetId:'native'}));assert.equal(committed.state,'complete',committed.error);assert.ok(f.title()!.endsWith('统计边界处理修复'));
 }finally{await f.close();}
});
