import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { PaseoApi } from '@getpaseo/client';
import { OrganizerService } from '../server/organizer/service.ts';
import { OrganizerSettings } from '../server/organizer/storage.ts';
import { organizerPolicySchema, type OrganizerSnapshot, type WorkspaceMaterial } from '../shared/organizer.ts';
const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
async function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-organizer-'))),config=join(root,'project.json'),registry=join(root,'registry.json');
  writeFileSync(config,JSON.stringify({schemaVersion:1,project:{id:'test'},sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),repositories:[]}));writeFileSync(registry,JSON.stringify({configs:[config]}));
  const previous=process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY;process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY=registry;
  const settings=new OrganizerSettings(join(root,'settings'));let modelTitle='登录异常修复',modelCalls=0,writes=0,failWrite=false,modelDelay=0;let materialReads=0;const extra:WorkspaceMaterial[]=[];const extraAgents:any[]=[],historyReads:string[]=[];
  const server=createServer(async(req,res)=>{if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString());const input=JSON.parse(body.messages[1].content);modelCalls++;if(modelDelay)await new Promise(resolve=>setTimeout(resolve,modelDelay));res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:modelTitle,brief:'修复登录异常',items:[{text:'修复登录',evidenceIds:[input.evidence[0].id]}]})}}]}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  settings.saveProfile(0,{id:'local',name:'Local',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,model:'fixture',contextTokens:16384,outputTokens:2048,timeoutMs:10000});
  const route={configPath:config,sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),treesRoot:join(root,'trees'),recordsRoot:join(root,'records'),socketPath:join(root,'s.sock'),displayName:'test'};
  settings.save('project',1,{profileId:'local',analysisIntervalSeconds:0,conversationSummary:false},[],route);
  let title:string|null='原始会话';
  const agent={id:'agent',workspaceId:'native',cwd:root,archivedAt:null};
  const api={agents:{list:async()=>({entries:[agent,...extraAgents].map(agent=>({agent})),pageInfo:{hasMore:false}}),ref:(id:string)=>({refresh:async()=>({agent:[agent,...extraAgents].find(agent=>agent.id===id)}),timeline:{refetch:async()=>{historyReads.push(id);return{entries:[],epoch:'e',hasOlder:false,hasNewer:false};}}})},workspaces:{list:async()=>({entries:[{id:'native',title}],pageInfo:{hasMore:false}}),ref:()=>({refresh:async()=>({id:'native',title}),setTitle:async(value:string|null)=>{writes++;if(failWrite)throw Error('Transport closed');title=value;return{title};}})}} as unknown as PaseoApi;
  const material:WorkspaceMaterial={workspaceId:'one',instance:'one:instance',name:'Login',createdAt:'2020-01-01T00:00:00Z',activityAt:'2020-01-01T00:00:00Z',taskBrief:'修复登录',fingerprint:'source-1',state:'pending',complete:true,evidence:[{id:'commit:one',kind:'commit',text:'Fix login'}],repositories:[{repositoryId:'repo',repoPath:'repo',productionRef:'origin/main',state:'pending',head:'abc',covered:0,pending:1,uncertain:0,dirty:false,observedAt:'2020-01-01'}]};
  const query=async({method,params}:any)=>{
    const materials=[material,...extra];
    if(method==='organizer.materials')materialReads++;
    return {ok:true,result:method==='workspace.list'?{workspaces:materials.map(m=>({id:m.workspaceId,instanceKey:m.instance,displayName:m.name,createdAt:m.createdAt,creator:{agentId:m.creatorAgentId||'agent'},managed:true,state:'active'}))}:method==='organizer.materials'?structuredClone(materials.find(m=>m.workspaceId===params.workspaceId)):method==='notes.read'?{notes:[]}:method==='repository.fetch'?{state:'ready'}:{refs:[],fetch:{state:'ready'}}};
  };

  const service=new OrganizerService({api:async()=>api,settings,query:query as any});
  const request=async(request:any)=>{const r=await service.request({projectConfig:config,request});if(!r.ok)throw Error(r.error);return r.result as any;};
  const analyze=async()=>{const j=await request({action:'analyze',conversation:false,regenerate:false});for(let i=0;i<500;i++){const state=await request({action:'job',jobId:j.id});if(['complete','failed','cancelled'].includes(state.state)){assert.equal(state.state,'complete',state.error);return;}await pause();}throw Error('job timeout');};
  return{root,config,settings,route,service,material,extra,extraAgents,historyReads,request,analyze,delayModel:(ms:number)=>{modelDelay=ms;},modelTitle:(v:string)=>{modelTitle=v;},title:(v?:string)=>{if(v!==undefined)title=v;return title;},counts:()=>({writes,modelCalls,materialReads}),failWrite:()=>{failWrite=true;},close:async()=>{await service.close();await new Promise<void>(resolve=>server.close(()=>resolve()));if(previous===undefined)delete process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY;else process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY=previous;rmSync(root,{recursive:true,force:true});}};
}
test('historical analysis only previews, unchanged material is cached, accepted titles stay stable, external edits pause ownership',async()=>{
  const f=await fixture();try{
    await f.analyze();let s=await f.request({action:'snapshot'}) as OrganizerSnapshot;assert.equal(s.targets[0].policy,'preview');assert.equal(f.counts().writes,0);assert.match(s.targets[0].previewTitle!,/登录异常修复/,JSON.stringify(s.workspaces));
    await f.analyze();assert.equal(f.counts().modelCalls,1);
    s=await f.request({action:'snapshot'});await f.request({action:'apply',targetIds:['native'],revision:s.revision,maintain:true});assert.equal(f.title(),'○ 登录异常修复');
    f.material.fingerprint='source-2';f.modelTitle('登录问题修正');await f.analyze();s=await f.request({action:'snapshot'});assert.equal(s.workspaces[0].title,'登录异常修复');
    f.title('人工标题');const j=await f.request({action:'refresh',forceFetch:false});for(let i=0;i<400;i++){const state=await f.request({action:'job',jobId:j.id});if(state.state==='complete')break;await pause();}
    s=await f.request({action:'snapshot'});assert.equal(s.targets[0].policy,'paused');assert.equal(f.title(),'人工标题');
  }finally{await f.close();}
});
test('uncertain write is journaled and never automatically replayed; original title restores only without an intervening edit',async()=>{
  const f=await fixture();try{
    await f.analyze();let s=await f.request({action:'snapshot'});f.failWrite();const result=await f.request({action:'apply',targetIds:['native'],revision:s.revision,maintain:true});assert.ok(result[0].error);s=await f.request({action:'snapshot'});assert.equal(s.targets[0].policy,'paused');assert.ok(s.targets[0].pendingWrite);assert.equal(f.counts().writes,1);
    const j=await f.request({action:'refresh',forceFetch:false});for(let i=0;i<400;i++){if((await f.request({action:'job',jobId:j.id})).state==='complete')break;await pause();}assert.equal(f.counts().writes,1);
    await assert.rejects(f.request({action:'restore',targetId:'native'}),/restore_unavailable/);
  }finally{await f.close();}
});
test('settings preserve unknown metadata, revision conflicts and project inheritance are explicit',async()=>{
  const f=await fixture();try{
    const path=join(f.settings.root,'settings.json'),raw=JSON.parse(readFileSync(path,'utf8'));raw.future={keep:true};writeFileSync(path,JSON.stringify(raw));
    const before=f.settings.response(f.route);f.settings.save('host',before.revision,{titleLength:12},[],f.route);assert.equal(f.settings.response(f.route).effective.titleLength,12);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')).future,{keep:true});
    assert.throws(()=>f.settings.save('host',before.revision,{titleLength:14},[],f.route),/revision_conflict/);
    assert.equal(organizerPolicySchema.parse({}).enabled,false);
  }finally{await f.close();}
});

async function done(f:Awaited<ReturnType<typeof fixture>>,job:{id:string}) {
  for(let i=0;i<500;i++){const j=await f.request({action:'job',jobId:job.id});if(['complete','failed','cancelled'].includes(j.state))return j;await pause();}throw Error('job timeout');
}
test('enabling only enrolls future linked work; automatic refresh does not analyze historical previews',async()=>{
  const f=await fixture();try {
    let settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{enabled:true},[],f.route);
    await done(f,await f.request({action:'refresh',forceFetch:false}));
    assert.equal(f.counts().modelCalls,0);assert.equal(f.counts().materialReads,0);assert.equal(f.counts().writes,0);
    f.material.createdAt=new Date(Date.now()+1000).toISOString();
    // A newly observed target from the enabled generation is eligible; the existing historical target remains preview.
    f.service.store(f.route).update(l=>{delete l.targets.native;});
    await done(f,await f.request({action:'refresh',forceFetch:false}));
    const snapshot=await f.request({action:'snapshot'});assert.equal(snapshot.targets[0].policy,'auto');assert.equal(f.counts().writes,1);assert.equal(f.title(),'○ 登录异常修复');
  }finally{await f.close();}
});
test('pending representative wins over newer shipped work; production changes update only markers and preserve manual body',async()=>{
  const f=await fixture();try {
    const later=structuredClone(f.material);later.workspaceId='two';later.instance='two:instance';later.name='New feature';later.createdAt=later.activityAt='2025-01-01T00:00:00Z';later.state=later.repositories[0].state='deployed';f.extra.push(later);
    await f.analyze();let snapshot=await f.request({action:'snapshot'});assert.equal(snapshot.targets[0].representative,f.material.instance);assert.equal(snapshot.targets[0].state,'partial');
    await f.request({action:'apply',targetIds:['native'],revision:snapshot.revision,maintain:true});
    const text='🟢 人工保留的很长标题正文超过默认十六个字符长度也不会被裁切';f.title(text);
    let settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{enabled:true,markers:{deployed:'🟢',partial:'🟡',pending:'🔵',unknown:'?',discussion:'·'}},[],f.route);
    await f.request({action:'target.policy',targetId:'native',policy:'symbols'});
    f.material.state=f.material.repositories[0].state='deployed';await done(f,await f.request({action:'refresh',forceFetch:false}));
    snapshot=await f.request({action:'snapshot'});assert.equal(snapshot.targets[0].representative,later.instance);assert.equal(f.title(),text);
    assert.equal(f.counts().modelCalls,2,'production reference changes do not regenerate semantic titles');
  }finally{await f.close();}
});
test('cancelled and settings-obsoleted model results cannot publish summaries or native titles',async()=>{
  const f=await fixture();try {
    f.delayModel(150);const job=await f.request({action:'analyze',conversation:false,regenerate:false});
    while(!f.counts().modelCalls)await pause();
    await f.request({action:'cancel',jobId:job.id});assert.equal((await done(f,job)).state,'cancelled');
    let snapshot=await f.request({action:'snapshot'});assert.equal(snapshot.workspaces[0].fingerprint,undefined);assert.equal(f.counts().writes,0);
    const second=await f.request({action:'analyze',conversation:false,regenerate:false});while(f.counts().modelCalls<2)await pause();
    const settings=f.settings.response(f.route);await f.request({action:'settings.save',scope:'project',revision:settings.revision,patch:{titleLength:12},reset:[]});
    assert.equal((await done(f,second)).state,'cancelled');snapshot=await f.request({action:'snapshot'});assert.equal(snapshot.workspaces[0].fingerprint,undefined);assert.equal(f.title(),'原始会话');
  }finally{await f.close();}
});
test('restore succeeds only while the plugin still owns the current title',async()=>{
  const f=await fixture();try {
    await f.analyze();let snapshot=await f.request({action:'snapshot'});await f.request({action:'apply',targetIds:['native'],revision:snapshot.revision,maintain:true});
    await f.request({action:'restore',targetId:'native'});assert.equal(f.title(),'原始会话');
    snapshot=await f.request({action:'snapshot'});await f.request({action:'apply',targetIds:['native'],revision:snapshot.revision,maintain:true});f.title('后来的编辑');await assert.rejects(f.request({action:'restore',targetId:'native'}),/external_title_change/);assert.equal(f.title(),'后来的编辑');
  }finally{await f.close();}
});
test('model tests start asynchronously without a project or Workspace and persist their actual input and output',async()=>{
  const f=await fixture();try{
    f.delayModel(80);const response=await f.service.request({request:{action:'profile.test',profileId:'local',text:'修复登录异常'}});assert.equal(response.ok,true);assert.equal(f.counts().modelCalls,0);
    const accepted=response.result as {id:string;state:string};assert.equal(accepted.state,'queued');let result:any;
    for(let i=0;i<500;i++){result=(await f.service.request({request:{action:'profile.test.result',testId:accepted.id}})).result;if(!['queued','running'].includes(result.state))break;await pause();}
    assert.equal(result.state,'complete');assert.match(result.run.input,/修复登录异常/);assert.match(result.run.output,/登录异常修复/);assert.equal(f.counts().materialReads,0);assert.equal(f.counts().writes,0);
    assert.equal((await f.service.request({request:{action:'profile.tests'}})).ok,true);
  }finally{await f.close();}
});
test('scope exclusions accept Workspace IDs and source changes invalidate a selected historical preview',async()=>{
  const f=await fixture();try{
    let settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{enabled:true,excludedIds:['one']},[],f.route);f.material.createdAt=new Date(Date.now()+1000).toISOString();
    await done(f,await f.request({action:'refresh',forceFetch:false}));assert.equal(f.counts().modelCalls,0);assert.equal(f.counts().writes,0);
    await f.analyze();const snapshot=await f.request({action:'snapshot'});f.material.fingerprint='changed-after-preview';const results=await f.request({action:'apply',targetIds:['native'],revision:snapshot.revision,maintain:true});assert.match(results[0].error,/source_changed/);assert.equal(f.counts().writes,0);
  }finally{await f.close();}
});
test('a changed source in the first target invalidates later targets in the same historical apply batch',async()=>{
 const f=await fixture();try{
  await f.analyze();f.service.store(f.route).update(l=>{l.targets['native-copy']={...structuredClone(l.targets.native),id:'native-copy'};});const snapshot=await f.request({action:'snapshot'});f.material.fingerprint='new-code-after-preview';
  const results=await f.request({action:'apply',targetIds:['native','native-copy'],revision:snapshot.revision,maintain:true});assert.equal(results.length,2);assert.ok(results.every((r:any)=>r.error==='organizer_source_changed'));assert.equal(f.counts().writes,0);
 }finally{await f.close();}
});
test('legacy Compare production changes reach the backend while an unchanged legacy snapshot cannot undo a new settings edit',async()=>{
 const f=await fixture();try{
  const key=JSON.stringify([f.config,'repo']),legacy={[key]:'origin/main'};f.settings.importLegacyBranches(f.route,legacy);assert.equal(f.settings.response(f.route).effective.productionBranches.repo,'origin/main');
  let current=f.settings.response(f.route);f.settings.save('project',current.revision,{productionBranches:{repo:'origin/release'}},[],f.route);
  f.settings.importLegacyBranches(f.route,legacy);assert.equal(f.settings.response(f.route).effective.productionBranches.repo,'origin/release');
  f.settings.importLegacyBranches(f.route,{[key]:'origin/stable'});assert.equal(f.settings.response(f.route).effective.productionBranches.repo,'origin/stable');
  f.settings.importLegacyBranches(f.route,{[key]:'origin/release'});assert.equal(f.settings.response(f.route).effective.productionBranches.repo,'origin/release');
 }finally{await f.close();}
});

test('historical selection reads only the selected Workspace conversations, including Agents sharing one native Workspace',async()=>{
 const f=await fixture();try{
  const other=structuredClone(f.material);other.workspaceId='other';other.instance='other:instance';other.creatorAgentId='other-agent';f.extra.push(other);f.extraAgents.push({id:'other-agent',workspaceId:'native',cwd:f.root,archivedAt:null});
  const settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{conversationSummary:true},[],f.route);
  assert.equal((await done(f,await f.request({action:'analyze',workspaceIds:['one'],conversation:true,regenerate:false}))).state,'complete');assert.deepEqual(f.historyReads,['agent']);assert.equal(f.counts().modelCalls,1);
 }finally{await f.close();}
});
test('automatic selected scope does not send an unselected associated Workspace to the model',async()=>{
 const f=await fixture();try{
  const at=new Date(Date.now()+1000).toISOString();f.material.createdAt=at;const other=structuredClone(f.material);other.workspaceId='other';other.instance='other:instance';other.fingerprint='other-source';f.extra.push(other);
  const settings=f.settings.response(f.route);f.settings.save('project',settings.revision,{enabled:true,mode:'selected',selectedIds:['one']},[],f.route);
  assert.equal((await done(f,await f.request({action:'refresh',forceFetch:false}))).state,'complete');assert.equal(f.counts().modelCalls,1);
  const snapshot=await f.request({action:'snapshot'});assert.equal(snapshot.workspaces.find((w:any)=>w.material.workspaceId==='other').fingerprint,undefined);
 }finally{await f.close();}
});
