import {comparisonKey} from '../shared/comparison';
import {useRef} from 'react';
import {useRpc} from '@getpaseo/plugin/client';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {changeNotesRpc} from '../shared/change-notes-rpc';
import type {NotesResult,ChangeNote,NoteManagementInput} from '../shared/change-notes';
import {type NoteScope} from './change-notes-model';
export {noteCurrent,type NoteScope} from './change-notes-model';
export function useChangeNotes(scope:NoteScope|undefined,enabled=true){
 const rpc=useRpc(changeNotesRpc),client=useQueryClient(),feedbackIds=useRef(new Map<string,string>());
 const key=['change-notes',scope?.projectConfig,scope?.workspaceId,scope?.repoPath,scope?.workspaceInstance||'',scope?.path||'',scope?.noteComparisonId||'',scope?.noteId||'',scope?.scope==='compare'?comparisonKey(scope.comparison):''];
 const query=useQuery({queryKey:key,queryFn:async({signal})=>{let result:NotesResult|undefined,offset=0;do{if(signal.aborted)throw new Error('Notes request cancelled');const r=await rpc({projectConfig:scope!.projectConfig!,workspaceId:scope!.workspaceId,workspaceInstance:scope?.workspaceInstance,repoPath:scope!.repoPath,action:'list',offset,comparisonId:scope?.noteComparisonId,noteId:scope?.noteId,comparisonKey:scope?.scope==='compare'?comparisonKey(scope.comparison)||undefined:undefined,paths:scope?.path?[scope.path]:undefined});if(!r.ok)throw new Error(r.error?.message||'Notes unavailable');const page=r.result as NotesResult;if(result&&result.revision!==page.revision)throw new Error('Explanations changed while loading; retry');result=result?{...page,notes:[...result.notes,...page.notes],feedback:[...result.feedback,...page.feedback],snapshots:{...result.snapshots,...page.snapshots}}:page;if(page.nextOffset==null)break;offset=page.nextOffset;}while(true);return result!;},enabled:!!scope?.projectConfig&&enabled,staleTime:15000,retry:false});
 async function feedback(note:ChangeNote,action:'read'|'question'|'confirm',text=''){
  const identity=JSON.stringify([scope?.projectConfig,scope?.workspaceId,scope?.repoPath,note.id,note.revision,action,text]);
  if(!feedbackIds.current.has(identity))feedbackIds.current.set(identity,`user:${Date.now()}:${Math.random()}`);
  const r=await rpc({projectConfig:scope!.projectConfig!,workspaceId:scope!.workspaceId,workspaceInstance:scope?.workspaceInstance,repoPath:scope!.repoPath,action:'feedback',feedback:{requestId:feedbackIds.current.get(identity)!,id:note.id,revision:note.revision,action,text}});
  if(!r.ok)throw new Error(r.error?.message||'Save failed');feedbackIds.current.delete(identity);await client.invalidateQueries({queryKey:['change-notes',scope?.projectConfig]});
 }
 async function manage(note:ChangeNote,edit:NoteManagementInput){
  const identity=JSON.stringify([scope?.projectConfig,scope?.workspaceId,scope?.repoPath,note.id,note.revision,edit]);
  if(!feedbackIds.current.has(identity))feedbackIds.current.set(identity,`manage:${Date.now()}:${Math.random()}`);
  const r=await rpc({projectConfig:scope!.projectConfig!,workspaceId:scope!.workspaceId,workspaceInstance:scope?.workspaceInstance,repoPath:scope!.repoPath,action:'manage',management:{...edit,requestId:feedbackIds.current.get(identity)!,id:note.id,revision:note.revision}});
  if(!r.ok)throw new Error(r.error?.message||'Save failed');
  feedbackIds.current.delete(identity);
  await client.invalidateQueries({queryKey:['change-notes',scope?.projectConfig]});
 }
 async function latest(note:ChangeNote){
  const r=await rpc({projectConfig:scope!.projectConfig!,workspaceId:scope!.workspaceId,workspaceInstance:scope?.workspaceInstance,repoPath:scope!.repoPath,action:'list',noteId:note.id});
  if(!r.ok)throw new Error(r.error?.message||'Latest explanation unavailable');return r.result as NotesResult;
 }
 async function original(note:ChangeNote){const r=await rpc({projectConfig:scope!.projectConfig!,workspaceId:scope!.workspaceId,workspaceInstance:scope?.workspaceInstance,repoPath:scope!.repoPath,action:'read',snapshotId:note.snapshotId});if(!r.ok)throw new Error(r.error?.message||'Original snapshot unavailable');const snapshot=(r.result as {snapshot:{files:Array<{path:string;patch:string;truncated:boolean}>}}).snapshot;return snapshot.files.filter(f=>!scope?.path||f.path===scope.path).map(f=>f.path+'\n'+f.patch+(f.truncated?'\n[truncated snapshot]':'')).join('\n');}
 return {...query,feedback,manage,original,latest};
}
