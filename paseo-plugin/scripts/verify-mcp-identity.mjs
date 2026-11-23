/** Actual isolated Paseo lifecycle and HTTP MCP; local Codex protocol fixture, no model. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {digest} from '../server/orchestration-state.ts';

export async function verifyMcpIdentity({client,root,configs,wait,report,reload}) {
  const plugin='workspace-workbench-paseo', config=configs[0], directory=dirname(config);
  const saved=JSON.parse(readFileSync(config,'utf8'));
  const configured=value=>writeFileSync(config,JSON.stringify(value));
  const identity=agentId=>client.invokePluginRpc(plugin,'workspace.workbench.agent_context',{projectConfig:config,agentId});
  const agent=async id=>(await client.fetchAgent({agentId:id})).agent;
  const thread=async id=>JSON.parse(readFileSync(join(root,'recovery-codex',(await agent(id)).runtimeInfo.sessionId+'.json'),'utf8'));
  const completed=async(id,count)=>wait(async()=>{
    const a=await agent(id); if(a.status==='error')throw Error('isolated_agent_failed');
    const t=await thread(id);return t.turns.length===count&&t.turns.at(-1).status==='completed'?t:null;
  });
  const sessionToken=id=>JSON.parse(readFileSync(join(directory,'state','orchestration',digest('session:'+id)+'.json'),'utf8')).token;
  const call=async(token,name,args)=>{
    const gateway=JSON.parse(readFileSync(join(root,'paseo','workspace-workbench','gateway.json'),'utf8'));
    const response=await fetch(`http://127.0.0.1:${gateway.port}/mcp`,{method:'POST',headers:{'content-type':'application/json',
      'X-Workbench-Gateway-Key':gateway.key,'X-Workbench-Project':config,...(token?{Authorization:'Bearer '+token}:{})},
      body:JSON.stringify({jsonrpc:'2.0',id:Math.random().toString(),method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(15000)});
    const result=await response.json();assert.ok(!result.error,JSON.stringify(result.error));return JSON.parse(result.result.content[0].text);
  };
  try {
    configured({...saved,agent:{bridge:{autoInject:false}}});
    const old=await client.createAgent({config:{provider:'codex',cwd:directory,modeId:'auto',featureValues:{plan_mode:false}},initialPrompt:'Before MCP identity repair'});
    const before=await completed(old.id,1), mode=(await agent(old.id)).currentModeId;
    assert.equal((await identity(old.id)).available,false);
    assert.equal(before.mcpLaunches.at(-1).hasIdentity,false);
    const defaults={...saved};delete defaults.agent;configured(defaults);
    await reload();
    await client.sendMessage(old.id,'Continue the same conversation after plugin update');
    const after=await completed(old.id,2);
    assert.equal(after.id,before.id,'native history is resumed, not replaced');
    assert.equal((await agent(old.id)).currentModeId,mode);
    assert.equal((await identity(old.id)).available,true);
    const token=sessionToken(old.id), launch=after.mcpLaunches.at(-1);
    assert.equal(launch.agentId,old.id);assert.equal(launch.tokenMatchesEnvironment,true);
    assert.equal(launch.authorizationDigest,createHash('sha256').update('Bearer '+token).digest('hex'));
    report.checks.push('existing tokenless native session gains MCP on the next ordinary turn, retaining Agent ID, native thread, both turns and mode; no manual session reload');
    await reload();
    await client.sendMessage(old.id,'Continue after another plugin generation');
    const reopened=await completed(old.id,3);
    assert.equal(reopened.id,before.id);assert.equal(sessionToken(old.id),token);
    assert.equal(reopened.mcpLaunches.at(-1).tokenMatchesEnvironment,true);
    report.checks.push('a second plugin update recovers the same runtime identity and native history without duplicate MCP names or manual configuration');
    const fresh=await client.createAgent({config:{provider:'codex',cwd:directory,modeId:'auto'},initialPrompt:'New registered project without any bridge settings'});
    await completed(fresh.id,1);assert.equal((await identity(fresh.id)).available,true);
    assert.notEqual(sessionToken(fresh.id),token);
    const otherConfig=configs[1], otherDefaults=JSON.parse(readFileSync(otherConfig,'utf8'));delete otherDefaults.agent;writeFileSync(otherConfig,JSON.stringify(otherDefaults));
    const other=await client.createAgent({config:{provider:'codex',cwd:dirname(otherConfig),modeId:'auto'},initialPrompt:'Another registered project'});
    await completed(other.id,1);
    assert.equal((await client.invokePluginRpc(plugin,'workspace.workbench.agent_context',{projectConfig:otherConfig,agentId:other.id})).available,true);
    assert.equal((await identity(other.id)).available,false);
    report.checks.push('fresh sessions in two registered projects automatically receive isolated identities without agent/bridge configuration');
    const workspace=await client.invokePluginRpc(plugin,'workspace.workbench.query',{projectConfig:config,method:'workspace.create',params:{name:'mcp-identity',repositories:['one']}});
    assert.ok(workspace.ok,JSON.stringify(workspace));
    writeFileSync(join(directory,'workspaces','trees','mcp-identity','one','README'),'changed by isolated MCP verification\n');
    const scope={workspaceId:'mcp-identity',repoPath:'one',scope:'working',paths:['README']};
    const read=await call(token,'workbench_change_notes_read',scope);assert.ok(read.ok,JSON.stringify(read));
    const batch={requestId:'identity-repair-note',snapshotId:read.result.snapshot.id,operations:[{id:'identity-note',expectedRevision:0,action:'upsert',content:{title:'Identity recovered',reason:'Isolated verification',behavior:'Uses the same native session',basis:'requirement',requirement:'Automatic MCP context',perspective:'implementer',anchors:[{path:'README',side:'new',start:1,end:1}]}}]};
    const write=await call(token,'workbench_change_notes_write',{workspaceId:scope.workspaceId,repoPath:scope.repoPath,batch});assert.ok(write.ok,JSON.stringify(write));
    const missing=await call('','workbench_change_notes_write',{workspaceId:scope.workspaceId,repoPath:scope.repoPath,batch});
    assert.equal(missing.error.code,'workbench_agent_token_unavailable');assert.equal(missing.error.retryable,false);assert.equal(missing.error.dispatched,false);
    const healthy=await call('','workbench_connection_status',{});assert.equal(healthy.ok,true);assert.equal(healthy.context.agentTokenPresent,false);
    await assert.rejects(client.invokePluginRpc(plugin,'workspace.workbench.change-notes',{...scope,projectConfig:otherConfig,token,action:'write',batch}));
    const notes=await call(token,'workbench_change_notes_read',scope);assert.ok(notes.result.notes.some(n=>n.id==='identity-note'));
    report.checks.push('restored identity writes a real note over shared HTTP MCP; tokenless and cross-project writes remain denied; connectivity does not claim a missing identity is ready');
    report.mcpIdentity={existingSessionRestored:true,newProjectsAutomatic:true,noteWritten:true,historyPreserved:true,manualSessionReload:false,provider:'local Codex protocol fixture; actual Paseo host, plugin and HTTP MCP'};
  } finally {configured(saved);}
}
