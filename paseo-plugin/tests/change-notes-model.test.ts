import test from 'node:test';
import assert from 'node:assert/strict';
import {noteCurrent,type NoteScope} from '../client/change-notes-model.ts';
import type {ChangeNote,NotesResult} from '../shared/change-notes.ts';
const note={id:'one',revision:1,snapshotId:'snapshot'} as ChangeNote;
const scope:NoteScope={projectConfig:'project',workspaceId:'workspace',repoPath:'repo',scope:'compare',path:'a',comparison:{fromRef:'main',toRef:'HEAD',fromSha:'base',leftSha:'base',toSha:'head',mergeBase:null,mode:'endpoints'}};
const data:NotesResult={notes:[note],feedback:[],snapshots:{snapshot:{scope:'compare',comparison:scope.comparison,left:'base',right:'head',files:[{path:'a',patch:'patch',digest:'digest',binary:false,truncated:false}]}}};
test('same frozen identities and digest are required; stale explanations cannot attach to nearby lines',()=>{
 const diff={path:'a',scope:'compare',patch:'patch',patchDigest:'digest',left:'base',right:'head',truncated:false};
 assert.equal(noteCurrent(note,data,scope,diff),true);
 assert.equal(noteCurrent(note,data,{...scope,comparison:{...scope.comparison!,toSha:'later'}},diff),false);
 assert.equal(noteCurrent(note,data,scope,{...diff,patchDigest:'changed'}),false);
 assert.equal(noteCurrent(note,data,{...scope,path:'other'},diff),false);
 assert.equal(noteCurrent(note,data,{...scope,scope:'commit',commitSha:'head'},diff),false);
});
test('working file digest and HEAD must both match; missing legacy content identity is not treated as verified',()=>{
 const working={...data,workingToken:'version',snapshots:{snapshot:{...data.snapshots.snapshot,scope:'working',right:null,workingToken:'version'}}};
 const selected={...scope,scope:'working' as const};
 const diff={path:'a',scope:'working',patch:'patch',patchDigest:'digest',head:'base',truncated:false};
 assert.equal(noteCurrent(note,working,selected,diff),true);
 assert.equal(noteCurrent(note,working,selected,{...diff,head:'later'}),false);
 assert.equal(noteCurrent(note,working,selected,{...diff,patchDigest:undefined}),false);
 assert.equal(noteCurrent(note,working,selected),true);
 assert.equal(noteCurrent(note,{...working,workingToken:'changed'},selected),false);
});

test('read receipts do not approve an explanation; new questions and revisions need fresh confirmation',async()=>{
 const {noteNeedsConfirmation}=await import('../client/change-notes-model.ts');
 const n={...note,content:{basis:'autonomous',question:''}} as ChangeNote;
 const event={id:n.id,revision:1,at:'2026-01-01',text:'Checked',action:'confirm' as const};
 assert.equal(noteNeedsConfirmation(n,{...data,feedback:[{...event,action:'read'}]}),true);
 assert.equal(noteNeedsConfirmation(n,{...data,feedback:[event]}),false);
 assert.equal(noteNeedsConfirmation(n,{...data,feedback:[event,{...event,action:'question'}]}),true);
 assert.equal(noteNeedsConfirmation({...n,revision:2},{...data,feedback:[event]}),true);
});
