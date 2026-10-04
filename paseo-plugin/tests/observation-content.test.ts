import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { displayedObservation, observationQueryOptions } from '../client/observation-content.ts';
import type { ObserverResponse } from '../shared/observer.ts';
const ready=(time:number)=>({ok:true,result:{observation:{state:'ready',readStartedAt:time},commits:[{sha:String(time)}]}});
test('one query cache retains visible content and current failed task status independently',async()=>{
 const client=new QueryClient(),key=['test','graph'];let value:ObserverResponse=ready(10);
 const read=()=>client.fetchQuery({queryKey:key,queryFn:async()=>value,...observationQueryOptions,staleTime:0});
 await read();value={ok:false,error:{code:'observer_timeout',message:'timeout'},result:{observation:{readTask:{id:'task-a',state:'failed'}}}};await read();
 const cached=client.getQueryData<ObserverResponse>(key)!;
 assert.equal(cached.ok,false);assert.equal((cached.result as any).observation.readTask.id,'task-a');assert.deepEqual(displayedObservation(cached),ready(10));
 value=ready(20);await read();assert.deepEqual(client.getQueryData(key),value);client.clear();
});
test('older observations cannot replace a newer successful query result',async()=>{
 const client=new QueryClient(),key=['test','graph'];let value=ready(20);
 const read=()=>client.fetchQuery({queryKey:key,queryFn:async()=>value,...observationQueryOptions,staleTime:0});
 await read();value=ready(10);await read();assert.deepEqual(client.getQueryData(key),ready(20));client.clear();
});
test('query removal discards retained data; another query cannot inherit it',async()=>{
 const client=new QueryClient(),key=['test','a'];
 await client.fetchQuery({queryKey:key,queryFn:async()=>ready(1),...observationQueryOptions});
 client.removeQueries({queryKey:key});
 await client.fetchQuery({queryKey:key,queryFn:async()=>({ok:false}),...observationQueryOptions});
 assert.equal(displayedObservation(client.getQueryData(key)),undefined);client.clear();
});
