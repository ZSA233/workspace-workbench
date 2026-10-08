import {useInfiniteQuery} from '@tanstack/react-query';
import {useRpc} from '@getpaseo/plugin/client';
import {changeNotesRpc} from '../shared/change-notes-rpc';
import type {ComparisonNoteCatalog} from '../shared/change-notes';
export function useComparisonNotes(projectConfig:string,workspaceId:string,repoPath:string,search:string,enabled:boolean){
 const rpc=useRpc(changeNotesRpc);
 return useInfiniteQuery({queryKey:['change-notes',projectConfig,workspaceId,repoPath,'catalog',search],initialPageParam:{offset:0,revision:undefined as string|undefined},
  queryFn:async({pageParam,signal})=>{if(signal.aborted)throw new Error('Cancelled');const r=await rpc({projectConfig,workspaceId,repoPath,action:'catalog',search,offset:pageParam.offset,catalogRevision:pageParam.revision});if(!r.ok)throw new Error(r.error?.message||'比较说明暂不可用');return r.result as ComparisonNoteCatalog;},
  getNextPageParam:page=>page.nextOffset==null?undefined:{offset:page.nextOffset,revision:page.revision},enabled,staleTime:15000,retry:false});
}
