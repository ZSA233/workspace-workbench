import test from 'node:test';
import assert from 'node:assert/strict';
import {executionBindingState as state,retainBindingResponse as retain} from '../client/execution-binding-state.ts';
import type {WorkspaceBindingResponse} from '../shared/handoff.ts';
const bound=():WorkspaceBindingResponse=>({ok:true,binding:{workspaceId:'sample',paseoWorkspaceId:'host',treePath:'/sample',agentId:'worker',relationship:'child',status:'running',updatedAt:'2026-01-01T00:00:00Z'},agent:{id:'worker',workspaceId:'host',cwd:'/sample',provider:'codex',model:null,status:'running',relationship:'child',parentAgentId:null,planningState:'unknown',permissionModeId:'full-access'}});
const failure={ok:false,error:{code:'unavailable',message:'temporarily unavailable'}};
test('initial read, confirmed absence and read failure are different states',()=>{
 assert.equal(state('sample',undefined).state,'loading');
 assert.equal(state('sample',{ok:true,binding:null}).state,'none');
 assert.equal(state('sample',failure).state,'failed');
 assert.equal(state('sample',failure).hasAgent,false);
});
test('refresh failure retains only the last successful result in the same query',()=>{
 const prior=bound();const value=retain(prior,failure,'sample');
 assert.equal(state('sample',value).binding,prior.binding);
 assert.equal(state('sample',value).stale,true);
 assert.equal(state('sample',value).canOpen,true);
 assert.equal(state('sample',retain(value,failure,'sample')).binding,prior.binding);
 assert.equal(state('sample',prior,false,'transport timeout').stale,true);
 assert.equal(prior.error,undefined);
});
test('successful absence clears the old binding and recovery clears warning',()=>{
 const failed=retain(bound(),failure,'sample');
 assert.equal(state('sample',retain(failed,{ok:true,binding:null},'sample')).hasAgent,false);
 assert.equal(state('sample',retain(failed,bound(),'sample')).stale,false);
});
test('cross-workspace results cannot introduce a session icon',()=>{
 assert.equal(state('another',bound()).hasAgent,false);
 assert.equal(state('another',retain(bound(),failure,'another')).hasAgent,false);
 assert.equal(state('another',retain(undefined,bound(),'another')).state,'failed');
});
test('mismatched host agent cannot be opened or replace binding identity',()=>{
 const value=bound();value.agent!.id='different';
 const result=state('sample',value);assert.equal(result.hasAgent,true);assert.equal(result.canOpen,false);assert.equal(result.agent,null);assert.equal(result.stale,true);
});
test('closed and archived sessions retain their record without an abnormal indicator',()=>{
 for(const status of ['closed','archived'] as const){const value=bound();value.binding!.status=status;const result=state('sample',value);assert.equal(result.hasAgent,true);assert.equal(result.canOpen,false);assert.equal(result.attention,false);assert.equal(result.status,status);}
});
test('only explicit failure, block or authorization status is abnormal',()=>{
 for(const status of ['error','blocked','permission'] as const){const value=bound();value.binding!.status=status;assert.equal(state('sample',value).attention,true);}
 const value=bound();value.binding!.agentId=undefined;value.agent=null;assert.equal(state('sample',value).hasAgent,false);
});
test('running and permission preset do not infer planning state',()=>{
 const result=state('sample',bound());assert.equal(result.agent!.planningState,'unknown');assert.equal(result.agent!.permissionModeId,'full-access');assert.equal(result.attention,false);
});

test('host archive status overrides an older completed binding',()=>{
 const value=bound();value.binding!.status='completed';value.agent!.status='archived';
 const result=state('sample',value);assert.equal(result.status,'archived');assert.equal(result.canOpen,false);assert.equal(result.hasAgent,true);assert.equal(result.attention,false);
});
