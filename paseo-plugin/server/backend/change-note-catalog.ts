import {hash,stable} from './storage.ts';
import {comparisonKey,type Comparison} from '../../shared/comparison.ts';
import type {ChangeNote,NoteUserEvent,NotesResult,ComparisonNoteRecord} from '../../shared/change-notes.ts';

type Snapshot=Omit<NotesResult['snapshots'][string],'files'>&{instance?:string};
type Ledger={notes:ChangeNote[];history:ChangeNote[];feedback:NoteUserEvent[];snapshots:Record<string,Snapshot>};
export function savedComparison(snapshot:Snapshot|undefined):Comparison|null{
 if(snapshot?.scope!=='compare')return null;
 const c=snapshot.comparison as Partial<Comparison>|undefined;
 const fromSha=c?.fromSha||snapshot.left,toSha=c?.toSha||snapshot.right;
 if(!fromSha||!toSha)return null;
 const mode=c?.mode||'endpoints',leftSha=c?.leftSha||snapshot.left||fromSha;
 if(mode==='contribution'&&!c?.mergeBase)return null;
 return {fromSha,toSha,fromRef:c?.fromRef||fromSha,toRef:c?.toRef||toSha,mode,leftSha,mergeBase:c?.mergeBase||null};
}
export function comparisonRecordId(snapshot:Snapshot):string|null{
 const comparison=savedComparison(snapshot);return comparison?hash(stable([snapshot.projectId,snapshot.workspaceId,snapshot.instance,snapshot.repoPath,comparisonKey(comparison),comparison.mergeBase])):null;
}
export function needsConfirmation(note:ChangeNote,feedback:NoteUserEvent[]){
 const last=feedback.filter(e=>e.id===note.id&&e.revision===note.revision&&!e.deleted&&e.action!=='read').at(-1);
 return last?last.action==='question':note.content.basis!=='requirement'||!!note.content.question;
}
/** Metadata only: no Git or patch reads. Group pages and aliases by frozen code identity. */
export function buildComparisonCatalog(ledger:Ledger){
 const feedback=new Map<string,NoteUserEvent[]>();
 for(const event of ledger.feedback){if(event.deleted||event.action==='read')continue;feedback.set(JSON.stringify([event.id,event.revision]),[event]);}
 const current=new Map(ledger.notes.map(n=>[n.id,n]));
 const groups=new Map<string,{record:ComparisonNoteRecord;notes:Map<string,ChangeNote>}>();
 for(const note of [...ledger.history,...ledger.notes]){
  const latest=current.get(note.id);if(!latest||latest.withdrawn||note.withdrawn)continue;
  const snapshot=ledger.snapshots[note.snapshotId],comparison=savedComparison(snapshot),id=snapshot&&comparisonRecordId(snapshot);
  if(!comparison||!id)continue;
  let group=groups.get(id);
  if(!group){group={record:{id,comparison,noteCount:0,pendingCount:0,updatedAt:note.updatedAt,aliases:[]},notes:new Map()};groups.set(id,group);}
  const alias={fromRef:comparison.fromRef,toRef:comparison.toRef};
  if(!group.record.aliases.some(a=>a.fromRef===alias.fromRef&&a.toRef===alias.toRef))group.record.aliases.push(alias);
  if(note.updatedAt>=group.record.updatedAt){group.record.updatedAt=note.updatedAt;group.record.comparison=comparison;}
  if((group.notes.get(note.id)?.revision||0)<note.revision)group.notes.set(note.id,{...note,historical:note.revision!==latest.revision,latestRevision:latest.revision});
 }
 for(const group of groups.values()){
  group.record.noteCount=group.notes.size;
  group.record.pendingCount=[...group.notes.values()].filter(n=>needsConfirmation(n,feedback.get(JSON.stringify([n.id,n.revision]))||[])).length;
 }
 const records=[...groups.values()].sort((a,b)=>b.record.updatedAt.localeCompare(a.record.updatedAt)||a.record.id.localeCompare(b.record.id));
 return {records,revision:hash(stable([ledger.notes,ledger.history,ledger.feedback]))};
}
