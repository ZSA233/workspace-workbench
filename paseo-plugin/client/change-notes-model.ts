import type {FileReviewSelection} from './file-review-store';
import type {DiffResult} from './model';
import type {ChangeNote,NotesResult} from '../shared/change-notes';
export type NoteScope=Pick<FileReviewSelection,'projectConfig'|'workspaceId'|'repoPath'|'scope'|'comparison'|'commitSha'|'baseSha'|'head'> & {path?:string;changeNoteId?:string;changeNoteRequest?:number};
export function noteCurrent(note:ChangeNote,data:NotesResult,scope:NoteScope,diff?:DiffResult|null){
 const s=data.snapshots[note.snapshotId];if(!s||s.scope!==scope.scope)return false;
 if(scope.scope==='compare'&&JSON.stringify(s.comparison)!==JSON.stringify(scope.comparison)){
  const a=s.comparison as Record<string,unknown>|undefined,b=scope.comparison;
  if(!a||!b||a.leftSha!==b.leftSha||a.toSha!==b.toSha||a.mode!==b.mode||a.fromSha!==b.fromSha)return false;
 }
 if(scope.scope==='commit'&&s.right!==scope.commitSha)return false;
 if(diff){if(scope.scope==='working'?s.left!==diff.head:s.left!==(diff.left??diff.baseSha??null)||s.right!==(diff.right??null))return false;const f=s.files.find(f=>f.path===scope.path);return !!f&&(f.truncated&&scope.scope!=='working'||!!diff.patchDigest&&f.digest===diff.patchDigest);}
 if(scope.scope==='branch')return s.left===scope.baseSha&&s.right===scope.head;
 return scope.scope!=='working'||!!s.workingToken&&s.workingToken===data.workingToken;
}

/** User questions reopen confirmation; a read receipt never resolves it. */
export function noteNeedsConfirmation(note:ChangeNote,data:NotesResult){
 const latest=data.feedback.filter(e=>e.id===note.id&&e.revision===note.revision&&e.action!=='read').at(-1);
 if(latest)return latest.action==='question';
 return note.content.basis!=='requirement'||Boolean(note.content.question);
}
