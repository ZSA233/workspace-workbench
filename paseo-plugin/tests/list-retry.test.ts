import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {QueryClient,QueryObserver} from '@tanstack/react-query';

test('explicit list retry works without an observation coordinator and merges repeated presses',async()=>{
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 let calls=0,release!:()=>void;
 const observer=new QueryObserver(client,{queryKey:['workspace-workbench','project','workspace-list'],enabled:false,queryFn:async()=>{
  calls++;
  if(calls===1)return {ok:false,error:{code:'observer_timeout'},result:undefined};
  await new Promise<void>(resolve=>{release=resolve;});
  return {ok:true,result:{workspaces:[{id:'saved'}]},error:undefined};
 }});
 try{
  assert.equal((await observer.refetch()).data?.ok,false);
  const first=observer.refetch({cancelRefetch:false}),second=observer.refetch({cancelRefetch:false});
  assert.equal(calls,2);release();
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a.data?.result?.workspaces[0].id,'saved');assert.equal(b.data?.ok,true);assert.equal(calls,2);
  const source=readFileSync(new URL('../client/panel.tsx',import.meta.url),'utf8');
  assert.match(source,/onRetry=\{listUnavailable[\s\S]*?listQuery\.refetch\(\{cancelRefetch:false\}\)/);
 }finally{observer.destroy();client.clear();}
});
