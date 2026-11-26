import { useCallback, useEffect, useRef } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { organizerRpc, type OrganizerInput, type OrganizerSnapshot, type OrganizerPolicy, type ModelProfile } from '../shared/organizer';
import {organizerErrorLabel} from './organizer-errors';
export type OrganizerSettingsResponse = { revision:number; defaults:Partial<OrganizerPolicy>;project:Partial<OrganizerPolicy>;effective:OrganizerPolicy;profiles:Array<ModelProfile & {hasSecret:boolean}>;enabledAt:string|null };
const refreshes=new Map<string,{at:number;promise:Promise<unknown>}>();
export function useOrganizer(projectConfig:string|undefined,active:boolean,hostWorkspaceId?:string) {
  const rpc=useRpc(organizerRpc),cache=useQueryClient();
  const latestRpc=useRef(rpc);latestRpc.current=rpc;
  const call=useCallback(async <T,>(request:OrganizerInput['request'],project=projectConfig):Promise<T>=>{const response=await latestRpc.current({projectConfig:project,request});if(!response.ok)throw Error(organizerErrorLabel(response.error||'整理服务暂不可用'));return response.result as T;},[projectConfig]);
  const snapshot=useQuery({queryKey:['workbench-organizer',projectConfig,hostWorkspaceId||'all'],queryFn:()=>call<OrganizerSnapshot>({action:'snapshot',hostWorkspaceId}),enabled:!!projectConfig&&active,retry:false,refetchOnWindowFocus:true});
  // Poll only the small local ledger stamp. This does not scan Git or invoke a model.
  const status=useQuery({queryKey:['workbench-organizer-status',projectConfig],queryFn:()=>call<{revision:number;active:boolean}>({action:'status'}),enabled:!!projectConfig&&active,retry:false,refetchOnWindowFocus:true,refetchInterval:query=>query.state.data?.active?1000:15000});
  useEffect(()=>{if(active&&status.data&&snapshot.data&&status.data.revision>snapshot.data.revision)void cache.invalidateQueries({queryKey:['workbench-organizer',projectConfig]});},[active,status.data?.revision,snapshot.data?.revision,cache,projectConfig]);
  const settings=useQuery({queryKey:['workbench-organizer-settings',projectConfig||'host'],queryFn:()=>call<OrganizerSettingsResponse>({action:'settings.get'}),enabled:active,retry:false,refetchOnWindowFocus:false});
  const invalidate=useCallback(async()=>{await Promise.all([cache.invalidateQueries({queryKey:['workbench-organizer']}),cache.invalidateQueries({queryKey:['workbench-organizer-status']}),cache.invalidateQueries({queryKey:['workbench-organizer-settings']})]);},[cache]);
  const mutate=useCallback(async <T,>(request:OrganizerInput['request'])=>{try{return await call<T>(request);}finally{await invalidate();}},[call,invalidate]);
  const refresh=useCallback(()=>{
    if(!projectConfig)return Promise.resolve();const key=projectConfig+':'+(hostWorkspaceId||'project'),old=refreshes.get(key);
    if(old&&Date.now()-old.at<1500)return old.promise;
    const promise=call({action:'refresh',hostWorkspaceId,forceFetch:false}).finally(()=>Promise.all([cache.invalidateQueries({queryKey:['workbench-organizer',projectConfig]}),cache.invalidateQueries({queryKey:['workbench-organizer-status',projectConfig]})]));
    refreshes.set(key,{at:Date.now(),promise});if(refreshes.size>64)refreshes.delete(refreshes.keys().next().value!);return promise;
  },[projectConfig,hostWorkspaceId,call,cache]);
  return {call,mutate,snapshot,settings,invalidate,refresh};
}
