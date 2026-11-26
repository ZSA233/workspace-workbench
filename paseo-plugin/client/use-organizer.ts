import { useCallback, useEffect } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { organizerRpc, type OrganizerInput, type OrganizerSnapshot, type OrganizerPolicy, type ModelProfile } from '../shared/organizer';
export type OrganizerSettingsResponse = { revision:number; defaults:Partial<OrganizerPolicy>;project:Partial<OrganizerPolicy>;effective:OrganizerPolicy;profiles:Array<ModelProfile & {hasSecret:boolean}>;enabledAt:string|null };
export function useOrganizer(projectConfig:string|undefined,active:boolean,hostWorkspaceId?:string) {
  const rpc=useRpc(organizerRpc),cache=useQueryClient();
  const call=useCallback(async <T,>(request:OrganizerInput['request'],project=projectConfig):Promise<T>=>{const response=await rpc({projectConfig:project,request});if(!response.ok)throw Error(response.error||'整理服务暂不可用');return response.result as T;},[rpc,projectConfig]);
  const snapshot=useQuery({queryKey:['workbench-organizer',projectConfig,hostWorkspaceId||'all'],queryFn:()=>call<OrganizerSnapshot>({action:'snapshot',hostWorkspaceId}),enabled:!!projectConfig&&active,retry:false,refetchOnWindowFocus:true,
    refetchInterval:query=>query.state.data?.jobs.some(j=>j.state==='running'||j.state==='queued')?1000:false});
  const settings=useQuery({queryKey:['workbench-organizer-settings',projectConfig||'host'],queryFn:()=>call<OrganizerSettingsResponse>({action:'settings.get'}),enabled:active,retry:false,refetchOnWindowFocus:false});
  const invalidate=useCallback(async()=>{await Promise.all([cache.invalidateQueries({queryKey:['workbench-organizer']}),cache.invalidateQueries({queryKey:['workbench-organizer-settings']})]);},[cache]);
  const mutate=useCallback(async <T,>(request:OrganizerInput['request'])=>{try{return await call<T>(request);}finally{await invalidate();}},[call,invalidate]);
  useEffect(()=>{if(!active||!projectConfig)return;let live=true;void call({action:'refresh',forceFetch:false}).then(()=>{if(live)void cache.invalidateQueries({queryKey:['workbench-organizer',projectConfig]});}).catch(()=>{});return()=>{live=false;};},[active,projectConfig,call,cache]);
  return {call,mutate,snapshot,settings,invalidate};
}
