import test from 'node:test';
import assert from 'node:assert/strict';
import {QueryClient,QueryObserver} from '@tanstack/react-query';
import {trimComparisonBodies,COMPARISON_BODY_BUDGET} from '../client/comparison-body-budget.ts';
test('continuous body cache evicts only unused results and respects explicit file tabs',()=>{
 const client=new QueryClient({defaultOptions:{queries:{gcTime:Infinity}}});
 const keys=Array.from({length:12},(_,i)=>['workspace-workbench','file-review','sample',i]);
 for(const key of keys){client.setQueryDefaults(key,{meta:{comparisonBody:true}});client.setQueryData(key,{patch:'x'.repeat(500000)});}
 const observer=new QueryObserver(client,{queryKey:keys[0],enabled:true,staleTime:Infinity});const stop=observer.subscribe(()=>{});
 trimComparisonBodies(client,new Set([JSON.stringify(keys[1])]));assert.ok(client.getQueryData(keys[0]));assert.ok(client.getQueryData(keys[1]));
 const unused=client.getQueryCache().getAll().filter(q=>!q.isActive()&&JSON.stringify(q.queryKey)!==JSON.stringify(keys[1])).reduce((n,q)=>n+JSON.stringify(q.state.data).length*2,0);assert.ok(unused<=COMPARISON_BODY_BUDGET);
 stop();client.clear();
});

test('content identity catches early cache publication and ignores task polling metadata',async()=>{
 const {comparisonContentVersion}=await import('../client/comparison-content-version.ts');
 const client=new QueryClient(),key=['workspace-workbench','file-review','sample','host','main','repo','file'];
 const snapshot=comparisonContentVersion(client,()=>['sample','host','main','repo']);const empty=snapshot();
 client.setQueryData(key,{ok:true,result:{observation:{readTask:{state:'running'}}}});assert.equal(snapshot(),empty);
 // Completion before a component subscribes must still invalidate its document memo.
 client.setQueryData(key,{ok:true,result:{patch:'ready'}});const ready=snapshot();assert.notEqual(ready,empty);assert.equal(snapshot(),ready);
 client.setQueryData([...key.slice(0,2),'other',...key.slice(3)],{ok:true,result:{patch:'other'}});assert.equal(snapshot(),ready);
 client.removeQueries({queryKey:key,exact:true});assert.equal(snapshot(),empty);client.clear();
});
