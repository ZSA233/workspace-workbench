import type {QueryClient,Query} from '@tanstack/react-query';
/** Derived cache identity also detects results published between render and subscription. */
export function comparisonContentVersion(client:QueryClient,scope:()=>readonly unknown[]){
 const ids=new WeakMap<Query,number>();let next=0;
 return ()=>{
  const expected=scope(),parts:string[]=[];
  for(const query of client.getQueryCache().getAll()){
   const key=query.queryKey;
   if(key[0]!=='workspace-workbench'||key[1]!=='file-review'||!expected.every((value,index)=>key[index+2]===value))continue;
   const data=query.state.data as {ok?:boolean;result?:{patch?:string;lines?:unknown[]}}|undefined;
   if(query.state.status!=='error'&&data?.ok!==false&&data?.result?.patch===undefined&&data?.result?.lines===undefined)continue;
   let id=ids.get(query);if(id===undefined){id=++next;ids.set(query,id);}
   parts.push(`${id}:${query.state.dataUpdateCount}:${query.state.errorUpdateCount}`);
  }
  return parts.join('|');
 };
}
