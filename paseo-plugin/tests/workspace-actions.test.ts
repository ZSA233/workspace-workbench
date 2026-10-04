import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceActions } from '../client/workspace-actions.ts';
import type { WorkspaceSummary } from '../client/model.ts';
import type { WorkspaceLifecycleResponse } from '../shared/workspace-lifecycle.ts';
function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
const workspace=(id:string)=>({id,state:'active'} as WorkspaceSummary);
const response=(id:string,action:'inspect'|'remove'='remove'):WorkspaceLifecycleResponse=>({ok:true,workspaceId:id,action,state:'removed',activeTasks:[]});
function setup() {
  let selected='a',calls=0;
  const tasks=new Map<string,ReturnType<typeof deferred<WorkspaceLifecycleResponse>>>();
  const published:WorkspaceLifecycleResponse[]=[];
  const state=new Map<string,WorkspaceSummary>([['a',workspace('a')],['b',workspace('b')]]);
  const actions=createWorkspaceActions({rpc:async input=>{calls++;const task=deferred<WorkspaceLifecycleResponse>();tasks.set(input.workspaceId,task);return task.promise;},publish:async result=>{published.push(result);},reconcile:async id=>state.get(id)||null,selection:()=>selected,select:id=>{selected=id;},notify:()=>{}});
  return {actions,tasks,published,state,select:(id:string)=>{selected=id;},selected:()=>selected,calls:()=>calls};
}
test('late removal updates only its target and preserves the later selection',async()=>{
 const c=setup(),first=c.actions.remove(workspace('a')),duplicate=c.actions.remove(workspace('a'));
 c.select('b');c.tasks.get('a')!.resolve(response('a'));await Promise.all([first,duplicate]);
 assert.equal(c.calls(),1);assert.equal(c.selected(),'b');assert.equal(c.published.length,1);
});
test('late inspection cannot replace the newer confirmation target',async()=>{
 const c=setup(),a=c.actions.inspect(workspace('a')),b=c.actions.inspect(workspace('b'));
 c.tasks.get('b')!.resolve(response('b','inspect'));await b;
 c.tasks.get('a')!.resolve(response('a','inspect'));await a;
 assert.equal(c.actions.snapshot().selected,'b');
 c.actions.close();assert.equal(c.actions.snapshot().selected,'');
});
test('lost write response reconciles without dispatching a second write',async()=>{
 const c=setup(),a=c.actions.remove(workspace('a'));c.state.set('a',{...workspace('a'),state:'removed'});
 c.tasks.get('a')!.reject(Error('RPC timed out'));await a;
 assert.equal(c.calls(),1);assert.equal(c.actions.snapshot().records.get('a')?.phase,'complete');assert.equal(c.selected(),'main');
});
test('unresolved write outcome cannot be replayed by repeated clicks',async()=>{
 const c=setup(),a=c.actions.remove(workspace('a'));c.tasks.get('a')!.reject(Error('RPC timed out'));await a;
 await c.actions.remove(workspace('a'));assert.equal(c.calls(),1);assert.equal(c.actions.snapshot().records.get('a')?.phase,'uncertain');
});
test('opening inspection after an uncertain write never removes the reconciliation requirement',async()=>{
 const c=setup(),write=c.actions.remove(workspace('a'));c.tasks.get('a')!.reject(Error('RPC timed out'));await write;
 const inspect=c.actions.inspect(workspace('a'));c.tasks.get('a')!.resolve(response('a','inspect'));await inspect;
 await c.actions.remove(workspace('a'));assert.equal(c.calls(),2);assert.equal(c.actions.snapshot().records.get('a')?.phase,'uncertain');
});
