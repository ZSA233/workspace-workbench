import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Git} from './git.ts';
import {hash,stable,WorkbenchError,type Json} from './storage.ts';
import {writeOperation} from './operation-storage.ts';
import {workspaceInstanceKey} from '../../shared/workspace-lineage.ts';
import {noteBatch,noteFeedback,noteManagement,type ChangeNote,type NoteUserEvent} from '../../shared/change-notes.ts';
import {resolveComparison} from './repository-comparison.ts';
import type {Workspaces} from './workspaces.ts';
import {validateDiffPath} from './file-diff.ts';
const LIMIT=2*1024*1024;
type Snapshot={projectId?:string;id:string;workspaceId:string;instance:string;repoPath:string;scope:string;workingToken?:string;comparison?:Json;left:string|null;right:string|null;files:Json[]};
type Ledger={schema:1;snapshots:Record<string,Snapshot>;notes:ChangeNote[];history:ChangeNote[];feedback:NoteUserEvent[];feedbackHistory?:NoteUserEvent[];requests:Record<string,{digest:string;result:Json}>};
const empty=():Ledger=>({schema:1,snapshots:{},notes:[],history:[],feedback:[],requests:{}});
async function load<T>(path:string,fallback?:T):Promise<T>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'&&fallback!==undefined)return fallback;throw e;}}
/** Notes have their own durable publication boundary; no Git mutation or cache invalidation. */
export class ChangeNotes {
 revision=String(Date.now())+Math.random();
 private workspaces:Workspaces;
 private workingToken:(path:string)=>string;
 constructor(workspaces:Workspaces,workingToken:(path:string)=>string=()=> 'unobserved'){this.workspaces=workspaces;this.workingToken=workingToken;}
 private root(){return join(this.workspaces.config.stateRoot,'change-notes');}
 private async context(p:Json){const c=await this.workspaces.observationRecords.request('context',{workspaceId:String(p.workspaceId||''),repository:p.repoPath||''});return {...c,instance:workspaceInstanceKey(c.workspace)};}
 private ledgerPath(instance:string,repoPath:string){return join(this.root(),'ledgers',hash(stable([instance,repoPath]))+'.json');}
 private snapshotPath(id:string){if(!/^[a-f0-9]{64}$/.test(id))throw new WorkbenchError('notes_snapshot_invalid','Invalid snapshot');return join(this.root(),'snapshots',id+'.json');}
 async read(p:Json,signal?:AbortSignal):Promise<Json>{
  const c=await this.context(p);
  if(p.action==='list'){
   const ledger=await load(this.ledgerPath(c.instance,c.repo.repoPath),empty());
   const all=ledger.notes.filter(n=>!n.withdrawn&&(!Array.isArray(p.paths)||n.content.anchors.some(a=>p.paths.includes(a.path))));
   const offset=Math.max(0,Math.floor(Number(p.offset)||0)),page=all.slice(offset,offset+16);
   const snapshots:Record<string,Snapshot>={};
   for(const id of new Set(page.map(n=>n.snapshotId))){const snapshot=ledger.snapshots?.[id]||await load<Snapshot>(this.snapshotPath(id));snapshots[id]={...snapshot,files:snapshot.files.map(f=>({...f,patch:undefined}))};}
   return {notes:page,feedback:ledger.feedback.map(identifiedFeedback).filter(e=>!e.deleted&&page.some(n=>n.id===e.id)),snapshots,workingToken:this.workingToken(c.path),nextOffset:offset+16<all.length?offset+16:null,revision:hash(stable([ledger.notes,ledger.feedback]))};
  }
  if(p.snapshotId){const snapshot=await load<Snapshot>(this.snapshotPath(p.snapshotId));this.check(snapshot,c);return {snapshot};}
  const git=new Git(c.path,this.workspaces.config.gitTimeout,Date.now()+25000,signal,true);
  if(await git.root()!==c.path)throw new WorkbenchError('repository_root_mismatch','Expected recorded repository');
  const scope=String(p.scope||'compare');
  const comparison=scope==='compare'?await resolveComparison(git,p.comparison||{}):undefined;
  const base=comparison?.leftSha||(scope==='branch'?c.repo.baseSha:null);
  let commit=comparison?.toSha||p.commitSha;
  const range=await git.range(scope,base,commit);
  if(scope==='commit')commit=range.right;
  const frozenScope=scope==='branch'?'compare':scope;
  const left=scope==='working'?await git.head():range.left;
  const right=range.right;
  const files=await git.files(frozenScope,scope==='branch'?left:base,scope==='branch'?right:commit,false,true);
  const offset=Math.max(0,Math.floor(Number(p.offset)||0));
  const requested=p.paths===undefined?files.slice(offset,offset+4).map(f=>f.path):p.paths;
  if(!Array.isArray(requested)||requested.length>8||requested.some(x=>typeof x!=='string'))throw new WorkbenchError('notes_limit','Read at most eight explicit paths');
  const captured:Json[]=[];
  for(const path of [...new Set<string>(requested)]){
   validateDiffPath(path);const file=files.find(f=>f.path===path);
   if(!file)throw new WorkbenchError('notes_anchor_invalid','File is outside this comparison');
   const read=()=>git.diff(frozenScope,path,scope==='branch'?left:base,scope==='branch'?right:commit,{maxBytes:Math.min(131072,this.workspaces.config.maxDiffBytes)});
   const first=await read();
   if(scope==='working'){const second=await read();if(stable(first)!==stable(second)||left!==await git.head())throw new WorkbenchError('notes_snapshot_changed','Content changed during capture; read again');}
   captured.push({path,oldPath:(file as Json).oldPath,patch:first.patch,digest:hash(first.patch),truncated:first.truncated,binary:/Binary files |GIT binary patch|Subproject commit/.test(first.patch)});
  }
  const value={projectId:this.workspaces.config.projectId,workspaceId:c.workspace.id,instance:c.instance,repoPath:c.repo.repoPath,scope,...(scope==='working'?{workingToken:this.workingToken(c.path)}:{}),comparison,left,right,files:captured};
  if(Buffer.byteLength(stable(value))>LIMIT)throw new WorkbenchError('notes_limit','Snapshot exceeds size limit');
  const id=hash(stable(value)),snapshot={...value,id};
  if(!await load<Snapshot|null>(this.snapshotPath(id),null))await writeOperation(this.snapshotPath(id),snapshot);
  const ledger=await load(this.ledgerPath(c.instance,c.repo.repoPath),empty());
  return {snapshot,notes:ledger.notes.filter(n=>!n.withdrawn).slice(0,16),notesListAction:"list",nextOffset:p.paths?null:offset+4<files.length?offset+4:null,totalFiles:files.length};
 }
 private check(snapshot:Snapshot,c:Awaited<ReturnType<ChangeNotes['context']>>){if(snapshot.projectId&&snapshot.projectId!==this.workspaces.config.projectId||snapshot.instance!==c.instance||snapshot.repoPath!==c.repo.repoPath||snapshot.workspaceId!==c.workspace.id)throw new WorkbenchError('notes_snapshot_mismatch','Snapshot belongs to another workspace or repository');}
 async write(p:Json,author:string):Promise<Json>{
  if(!author)throw new WorkbenchError('notes_author_required','Verified author required');
  if(Buffer.byteLength(JSON.stringify(p))>262144)throw new WorkbenchError('notes_limit','Batch exceeds 256 KiB');
  const batch=noteBatch.parse(p.batch),c=await this.context(p);
  if(c.workspace.state==='removed')throw new WorkbenchError('notes_workspace_removed','Restore the workspace before editing notes');
  const snapshot=await load<Snapshot>(this.snapshotPath(batch.snapshotId));this.check(snapshot,c);
  const path=this.ledgerPath(c.instance,c.repo.repoPath),ledger=await load(path,empty()),identity=hash(stable([author,batch])),prior=ledger.requests[batch.requestId];
  if(prior){if(prior.digest!==identity)throw new WorkbenchError('notes_request_conflict','Request ID was used with different content');return prior.result;}
  const seen=new Set<string>();
  for(const op of batch.operations){
   if(seen.has(op.id))throw new WorkbenchError('notes_duplicate','Duplicate note ID');seen.add(op.id);
   const existing=ledger.notes.find(n=>n.id===op.id);
   if((existing?.revision||0)!==op.expectedRevision)throw new WorkbenchError('notes_revision_conflict','Read the latest note before editing');
   if(op.action==='upsert'){
    if(!op.content)throw new WorkbenchError('notes_content_required','Explanation required');
    if(op.content.basis==='requirement'&&!op.content.requirement.trim())throw new WorkbenchError('notes_requirement_required','Provide requirement evidence or declare missing context');
    for(const anchor of op.content.anchors){const file=snapshot.files.find(f=>f.path===anchor.path);if(!file)throw new WorkbenchError('notes_anchor_invalid','Anchor not in captured files');
     if(anchor.side==='file'){if(anchor.start||anchor.end)throw new WorkbenchError('notes_anchor_invalid','File anchors have no line numbers');continue;}
     if(file.binary||file.truncated||!anchor.start||!anchor.end||anchor.end<anchor.start)throw new WorkbenchError('notes_anchor_invalid','Only complete text supports line anchors');
     const lines=patchLines(file.patch,anchor.side);for(let n=anchor.start;n<=anchor.end;n++){if(n-anchor.start>10000||!lines.has(n))throw new WorkbenchError('notes_anchor_invalid','Line is outside the captured patch');}
    }
   }else if(!existing)throw new WorkbenchError('notes_missing','Cannot withdraw missing note');
  }
  ledger.snapshots ||= {};
  ledger.snapshots[snapshot.id]={...snapshot,files:snapshot.files.map(({patch,...file})=>file)};
  const result:Json={revisions:[]};
  for(const op of batch.operations){const old=ledger.notes.find(n=>n.id===op.id);if(old)ledger.history.push(old);const note:ChangeNote={id:op.id,revision:op.expectedRevision+1,snapshotId:batch.snapshotId,author,updatedAt:new Date().toISOString(),withdrawn:op.action==='withdraw',content:op.content||old!.content};ledger.notes=ledger.notes.filter(n=>n.id!==op.id);ledger.notes.push(note);result.revisions.push({id:note.id,revision:note.revision});}
  ledger.requests[batch.requestId]={digest:identity,result};await writeOperation(path,ledger);this.revision=String(Date.now())+Math.random();return result;
 }
 async manage(p:Json):Promise<Json>{
  const edit=noteManagement.parse(p.management),c=await this.context(p);
  if(c.workspace.state==='removed')throw new WorkbenchError('notes_workspace_removed','Restore the workspace before editing notes');
  const path=this.ledgerPath(c.instance,c.repo.repoPath),ledger=await load(path,empty());
  const key='manage:'+edit.requestId,identity=hash(stable(edit)),prior=ledger.requests[key];
  if(prior){if(prior.digest!==identity)throw new WorkbenchError('notes_request_conflict','Request ID reused');return prior.result;}
  const note=ledger.notes.find(n=>n.id===edit.id&&!n.withdrawn);
  if(!note||note.revision!==edit.revision)throw new WorkbenchError('notes_revision_conflict','Explanation changed; reopen it before saving');
  const at=new Date().toISOString();
  if(edit.action==='edit'||edit.action==='withdraw'){
   if(edit.action==='edit'&&(!edit.content.title.trim()||!edit.content.reason.trim()||!edit.content.behavior.trim()||edit.content.basis==='requirement'&&!edit.content.requirement.trim()))throw new WorkbenchError('notes_content_required','Title, reason, behavior and cited requirements must not be blank');
   ledger.history.push(note);
   ledger.notes=ledger.notes.map(n=>n.id!==note.id?n:{...note,revision:note.revision+1,updatedAt:at,editedBy:'user',withdrawn:edit.action==='withdraw',content:edit.action==='edit'?{...edit.content,anchors:note.content.anchors}:note.content});
  }else{
   // Old feedback gains stable identifiers without discarding historical data.
   ledger.feedback=ledger.feedback.map(identifiedFeedback);
   const index=ledger.feedback.findIndex(e=>e.eventId===edit.eventId),event=ledger.feedback[index];
   if(!event||event.deleted||event.id!==note.id||event.revision!==note.revision||event.action!=='question'||event.version!==edit.expectedVersion)throw new WorkbenchError('notes_feedback_conflict','Question changed; reopen it before saving');
   if(edit.action==='question-edit'&&!edit.text.trim())throw new WorkbenchError('notes_feedback_required','Question must not be blank');
   (ledger.feedbackHistory ||= []).push(event);
   // Move an edited question to the end: new wording requires a fresh answer.
   ledger.feedback.splice(index,1);
   ledger.feedback.push({...event,version:event.version!+1,updatedAt:at,deleted:edit.action==='question-delete',text:edit.action==='question-edit'?edit.text:event.text});
  }
  const result={saved:true};ledger.requests[key]={digest:identity,result};
  await writeOperation(path,ledger);this.revision=String(Date.now())+Math.random();return result;
 }
 async feedback(p:Json):Promise<Json>{const event=noteFeedback.parse(p.feedback),c=await this.context(p),path=this.ledgerPath(c.instance,c.repo.repoPath),ledger=await load(path,empty());const note=ledger.notes.find(n=>n.id===event.id&&!n.withdrawn);if(!note||note.revision!==event.revision)throw new WorkbenchError('notes_revision_conflict','Note changed; read it again');if(event.action!=='read'&&!event.text.trim())throw new WorkbenchError('notes_feedback_required','Text required');const key='user:'+event.requestId,identity=hash(stable(event)),prior=ledger.requests[key];if(prior){if(prior.digest!==identity)throw new WorkbenchError('notes_request_conflict','Request ID reused');return prior.result;}ledger.feedback=ledger.feedback.map(identifiedFeedback);ledger.feedback.push({...event,eventId:hash(stable(event)),version:1,at:new Date().toISOString()});const result={saved:true};ledger.requests[key]={digest:identity,result};await writeOperation(path,ledger);this.revision=String(Date.now())+Math.random();return result;}
}
export function patchLines(patch:string,side:'old'|'new') {const result=new Set<number>();let old=0,next=0,active=false;for(const line of patch.split('\n')){const h=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);if(h){old=Number(h[1]);next=Number(h[2]);active=true;continue;}if(!active||line.startsWith('\\')||!line)continue;if(line[0]===' '||line[0]==='-'){if(side==='old')result.add(old);old++;}if(line[0]===' '||line[0]==='+'){if(side==='new')result.add(next);next++;}}return result;}

function identifiedFeedback(event:NoteUserEvent,index:number):NoteUserEvent{return {...event,eventId:event.eventId||hash(stable([index,event])),version:event.version||1};}
