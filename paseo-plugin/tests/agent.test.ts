import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {PaseoApi} from '@getpaseo/client';
import {handleWorkspaceDelegate} from '../server/agent-provider.ts';
import {storeArtifactBytes} from '../server/artifacts.ts';
import {getAgentBinding,putAgentBinding} from '../server/agent-store.ts';
import {digest} from '../server/orchestration-state.ts';
import {handoffSchema} from '../shared/handoff.ts';

test('Agent reuse delivers handoff once; failed identity refresh does not create another Agent',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'workbench-agent-'));
 const previous=process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS;
 process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS=join(directory,'bindings.json');
 let sends=0,creates=0,unavailable=false;
 const child={id:'worker',cwd:'/fixture/tree',workspaceId:'paseo',status:'idle',provider:'codex',model:'model',features:[{id:'plan_mode',type:'toggle',value:false}],labels:{'workspace-workbench.workspace-id':'sample'}};
 const paseo={agents:{ref:(id:string)=>({refresh:async()=>{
   if(id==='worker'&&unavailable)throw Error('temporary');
   return {agent:id==='worker'?child:{id:'parent',provider:'codex',model:'model',features:[{id:'plan_mode',type:'toggle',value:false}],currentModeId:'auto',availableModes:[{id:'auto'}],pendingPermissions:[]}};
 },send:async()=>{sends++;}})},workspaces:{open:async()=>{creates++;throw Error('unexpected create');}}} as unknown as PaseoApi;
 const handoff=handoffSchema.parse({goal:'Review changes'});
 const input={workspaceId:'sample',parentAgentId:'parent',handoff};
 const context={paseo,query:async()=>({ok:true,result:{workspaceId:'sample',managed:true,treePath:'/fixture/tree',capabilities:{agent:true}}})};
 try{
  putAgentBinding({workspaceId:'sample',agentId:'worker',relationship:'child',parentAgentId:'parent',paseoWorkspaceId:'paseo',cwd:'/fixture/tree',provider:'test/model',createdAt:'now',updatedAt:'now',handoff,handoffHash:digest(handoff),delivery:'sent'});
  const results=await Promise.all([handleWorkspaceDelegate(input,context),handleWorkspaceDelegate(input,context)]);
  assert.ok(results.every(r=>r.action==='reused'));
  assert.equal(sends,0);
  assert.equal(getAgentBinding('sample')?.handoff?.goal,'Review changes');
  await handleWorkspaceDelegate(input,context);
  assert.equal(sends,0,'completed handoff must not be delivered again');
  const different=await handleWorkspaceDelegate({ ...input, handoff: handoffSchema.parse({ goal: 'Another task', relationship: 'child' }) },context);
  assert.equal(different.error?.code,'workspace_session_exists');
  const saved=getAgentBinding('sample')!;
  putAgentBinding({...saved,parentAgentId:'another-parent'});
  assert.equal((await handleWorkspaceDelegate(input,context)).error?.code,'agent_identity_changed');
  putAgentBinding({...saved,delivery:'pending'});
  assert.equal((await handleWorkspaceDelegate(input,context)).ok,false);
  putAgentBinding(saved);
  unavailable=true;
  assert.equal((await handleWorkspaceDelegate(input,context)).error?.code,'agent_refresh_failed');
  assert.equal(creates,0);
 }finally{
  if(previous===undefined)delete process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS;else process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS=previous;
  rmSync(directory,{recursive:true,force:true});
 }
});

test('new execution handoffs attach referenced images to the execution Agent', async () => {
 const directory=mkdtempSync(join(tmpdir(),'workbench-agent-image-'));
 const previousBindings=process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS;
 const previousArtifacts=process.env.WORKSPACE_WORKBENCH_ARTIFACT_ROOT;
 process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS=join(directory,'bindings.json');
 process.env.WORKSPACE_WORKBENCH_ARTIFACT_ROOT=join(directory,'artifacts');
 let sentOptions: Record<string, unknown> | undefined;
 const parent={id:'parent',cwd:'/fixture/tree',provider:'codex',model:'model',features:[{id:'plan_mode',type:'toggle',value:false}],currentModeId:'auto',availableModes:[{id:'auto'}],pendingPermissions:[]};
 const worker={id:'worker',cwd:'/fixture/tree',workspaceId:'paseo',status:'initializing',current:()=>({status:'initializing'}),send:async(_message:string,options:Record<string, unknown>)=>{sentOptions=options;}};
 const paseo={agents:{ref:()=>({refresh:async()=>({agent:parent})})},workspaces:{open:async()=>({id:'paseo',agents:{create:async()=>worker}})}} as unknown as PaseoApi;
 const context={paseo,query:async()=>({ok:true,result:{workspaceId:'sample',managed:true,treePath:'/fixture/tree',capabilities:{agent:true},repositories:[]}})};
 try{
  storeArtifactBytes({id:'draft',title:'Draft',kind:'image',mimeType:'image/png',bytes:Buffer.from('draft-image')});
  const handoff=handoffSchema.parse({goal:'Use the draft',reviewPacket:{references:[{id:'REF-1',title:'Draft',kind:'image',assetId:'draft',required:true}]}});
  const result=await handleWorkspaceDelegate({workspaceId:'sample',parentAgentId:'parent',handoff},context);
  assert.equal(result.ok,true);
  assert.deepEqual(sentOptions?.images,[{data:Buffer.from('draft-image').toString('base64'),mimeType:'image/png'}]);
 }finally{
  if(previousBindings===undefined)delete process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS;else process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS=previousBindings;
  if(previousArtifacts===undefined)delete process.env.WORKSPACE_WORKBENCH_ARTIFACT_ROOT;else process.env.WORKSPACE_WORKBENCH_ARTIFACT_ROOT=previousArtifacts;
  rmSync(directory,{recursive:true,force:true});
 }
});
