import {useSyncExternalStore} from 'react';
import {clearDocumentCache,evictDocumentCache} from './document-reader.ts';
export type DocumentSelection={hostWorkspaceId:string;agentId?:string;projectConfig:string;scope:string;workspaceId:string;instance:string;workspaceName:string;directory:string;path:string};
type Open=(selection:DocumentSelection,back?:boolean)=>void;
let opener:Open|undefined;
const selections=new Map<string,DocumentSelection[]>(),active=new Map<string,string>(),returns=new Map<string,DocumentSelection>(),listeners=new Set<()=>void>();
const empty:DocumentSelection[]=[];
export const documentKey=(s:DocumentSelection)=>JSON.stringify([s.scope,s.workspaceId,s.instance,s.path]);
const emit=()=>listeners.forEach(f=>f());
export function configureDocumentOpener(next:Open){opener=next;return()=>{if(opener===next)opener=undefined;};}
export function openDocument(s:DocumentSelection){const values=selections.get(s.hostWorkspaceId)||[],key=documentKey(s);selections.set(s.hostWorkspaceId,[...values.filter(v=>documentKey(v)!==key),s].slice(-16));active.set(s.hostWorkspaceId,key);emit();opener?.(s);}
export function closeDocument(s:DocumentSelection){evictDocumentCache(s.scope+'\0'+documentKey(s));const values=(selections.get(s.hostWorkspaceId)||[]).filter(v=>documentKey(v)!==documentKey(s));selections.set(s.hostWorkspaceId,values);active.set(s.hostWorkspaceId,values.at(-1)?documentKey(values.at(-1)!):'');emit();}
export function backToFiles(s:DocumentSelection){returns.delete(s.scope);returns.set(s.scope,{...s});if(returns.size>16)returns.delete(returns.keys().next().value!);emit();opener?.(s,true);}
export function activateDocument(s:DocumentSelection){active.set(s.hostWorkspaceId,documentKey(s));emit();}
export function useDocuments(host:string){return useSyncExternalStore(f=>{listeners.add(f);return()=>{listeners.delete(f);};},()=>selections.get(host)||empty);}
export function useActiveDocument(host:string){return useSyncExternalStore(f=>{listeners.add(f);return()=>{listeners.delete(f);};},()=>active.get(host)||'');}
export function useDocumentReturn(scope:string){return useSyncExternalStore(f=>{listeners.add(f);return()=>{listeners.delete(f);};},()=>returns.get(scope));}
export function consumeDocumentReturn(scope:string,target:DocumentSelection){if(returns.get(scope)===target){returns.delete(scope);emit();}}
export function clearDocuments(host:string){for(const s of selections.get(host)||[])clearDocumentCache(s.scope,s.workspaceId);selections.delete(host);active.delete(host);emit();}
export function reconcileDocuments(scope:string,workspaces:{id:string;state?:string;instanceKey?:string}[]){
  if(workspaces.some(w=>w.state==='record_invalid'))return;
  const live=new Map(workspaces.filter(w=>w.state!=='removed').map(w=>[w.id,w]));
  const target=returns.get(scope);if(target&&(!live.has(target.workspaceId)||live.get(target.workspaceId)?.instanceKey&&!target.instance.startsWith(live.get(target.workspaceId)!.instanceKey!+':'))){returns.delete(scope);emit();}
  for(const values of selections.values())for(const s of values)if(s.scope===scope&&(!live.has(s.workspaceId)||live.get(s.workspaceId)?.instanceKey&&!s.instance.startsWith(live.get(s.workspaceId)!.instanceKey!+':'))){clearDocumentCache(s.scope,s.workspaceId);closeDocument(s);}
}
