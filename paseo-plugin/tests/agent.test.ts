import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {PaseoApi} from '@getpaseo/client';
import {handleWorkspaceDelegate} from '../server/agent-provider.ts';
import {getAgentBinding,putAgentBinding} from '../server/agent-store.ts';
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
 const input={workspaceId:'sample',parentAgentId:'parent',handoff:handoffSchema.parse({goal:'Review changes'})};
 const context={paseo,query:async()=>({ok:true,result:{workspaceId:'sample',managed:true,treePath:'/fixture/tree',capabilities:{agent:true}}})};
 try{
  putAgentBinding({workspaceId:'sample',agentId:'worker',parentAgentId:'parent',paseoWorkspaceId:'paseo',cwd:'/fixture/tree',provider:'test/model',createdAt:'now',updatedAt:'now'});
  const results=await Promise.all([handleWorkspaceDelegate(input,context),handleWorkspaceDelegate(input,context)]);
  assert.ok(results.every(r=>r.action==='reused'));
  assert.equal(sends,1);
  assert.equal(getAgentBinding('sample')?.handoff?.goal,'Review changes');
  await handleWorkspaceDelegate(input,context);
  assert.equal(sends,1,'completed handoff must not be delivered again');
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
