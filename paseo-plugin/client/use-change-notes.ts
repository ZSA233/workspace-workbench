import {useRef} from 'react';
import {useRpc} from '@getpaseo/plugin/client';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {changeNotesRpc} from '../shared/change-notes-rpc';
import type {NotesResult,ChangeNote} from '../shared/change-notes';
import {type NoteScope} from './change-notes-model';
export {noteCurrent,type NoteScope} from './change-notes-model';
export function useChangeNotes(scope:NoteScope|undefined,enabled=true){
 const rpc=useRpc(changeNotesRpc),client=useQueryClient(),feedbackIds=useRef(new Map<string,string>());
 const key=['change-notes',scope?.projectConfig,scope?.workspaceId,scope?.repoPath,scope?.path||''];
 const query=useQuery({queryKey:key,queryFn:async({signal})=>{let result:NotesResult|undefined,offset=0;do{if(signal.aborted)throw new Error('Notes request cancelled');const r=await rpc({projectConfig:scope!.projectConfig!,workspaceId:scope!.workspaceId,repoPath:scope!.repoPath,action:'list',offset,paths:scope?.path?[scope.path]:undefined});if(!r.ok)throw new Error(r.error?.message||'Notes unavailable');const page=r.result as NotesResult;if(result&&result.revision!==page.revision)throw new Error('Explanations changed while loading; retry');result=result?{...page,notes:[...result.notes,...page.notes],feedback:[...result.feedback,...page.feedback],snapshots:{...result.snapshots,...page.snapshots}}:page;if(page.nextOffset==null)break;offset=page.nextOffset;}while(true);return result!;},enabled:!!scope?.projectConfig&&enabled,staleTime:15000,retry:false});
 async function feedback(note:ChangeNote,action:'read'|'question'|'confirm',text=''){
  const identity=JSON.stringify([scope?.projectConfig,scope?.workspaceId,scope?.repoPath,note.id,note.revision,action,text]);
  if(!feedbackIds.current.has(identity))feedbackIds.current.set(identity,`user:${Date.now()}:${Math.random()}`);
  const r=await rpc({projectConfig:scope!.projectConfig!,workspaceId:scope!.workspaceId,repoPath:scope!.repoPath,action:'feedback',feedback:{requestId:feedbackIds.current.get(identity)!,id:note.id,revision:note.revision,action,text}});
  if(!r.ok)throw new Error(r.error?.message||'Save failed');await client.invalidateQueries({queryKey:['change-notes',scope?.projectConfig]});
 }
 async function original(note:ChangeNote){const r=await rpc({projectConfig:scope!.projectConfig!,workspaceId:scope!.workspaceId,repoPath:scope!.repoPath,action:'read',snapshotId:note.snapshotId});if(!r.ok)throw new Error(r.error?.message||'Original snapshot unavailable');const snapshot=(r.result as {snapshot:{files:Array<{path:string;patch:string;truncated:boolean}>}}).snapshot;return snapshot.files.filter(f=>!scope?.path||f.path===scope.path).map(f=>f.path+'\n'+f.patch+(f.truncated?'\n[truncated snapshot]':'')).join('\n');}
 return {...query,feedback,original};
}
