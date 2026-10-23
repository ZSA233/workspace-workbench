import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveTabClose,type TabCloseMode} from '../client/tab-close.ts';
import {openFileReview,closeFileReviews,clearFileReviews,getFileReviews,getActiveFileReviewKey,getFileReviewPosition,getComparisonView,selectionKey,setActiveFileReview,subscribeFileReviews,type FileReviewSelection} from '../client/file-review-store.ts';
import {openDocument,closeDocument,clearDocuments,getDocuments,getActiveDocumentKey,activateDocument,documentKey,type DocumentSelection} from '../client/document-store.ts';

test('tab close groups use the clicked tab and visible order, preserving a surviving active tab',()=>{
 const values=['a','b','c','d','e'],key=(s:string)=>s;
 const cases:[TabCloseMode,string[],string][]=[['current',['a','b','d','e'],'e'],['others',['c'],'c'],['left',['c','d','e'],'e'],['right',['a','b','c'],'c'],['all',[],'']];
 for(const [mode,remaining,active]of cases){const result=resolveTabClose(values,key,'c','e',mode);assert.deepEqual(result.values,remaining,mode);assert.equal(result.activeKey,active,mode);assert.deepEqual([...result.values,...result.removed].sort(),values);}
 assert.equal(resolveTabClose(values,key,'b','c','current').activeKey,'c');
 assert.equal(resolveTabClose(values,key,'b','b','current').activeKey,'c');
 assert.equal(resolveTabClose(values,key,'e','e','current').activeKey,'d');
});

test('stale menu targets and unavailable edge actions are harmless no-ops',()=>{
 const values=['a','b'],key=(s:string)=>s;
 for(const [anchor,mode]of [['missing','all'],['a','left'],['b','right']] as const){const result=resolveTabClose(values,key,anchor,'b',mode);assert.equal(result.values,values);assert.equal(result.removed.length,0);assert.equal(result.activeKey,'b');}
 assert.equal(resolveTabClose(['a'],key,'a','a','others').removed.length,0);
});

test('Diff bulk close publishes once, releases only closed view state, and isolates other host panels',()=>{
 const host='tab-close-diffs',other='tab-close-other',request={hostWorkspaceId:host,panelId:'changes'};
 const a:FileReviewSelection={workspaceId:'one',repoPath:'api',path:'same.ts',scope:'working',branch:'feature',status:'M',statusLabel:'Modified'};
 const b={...a,workspaceId:'two'},c={...a,scope:'branch' as const},d={...a,kind:'comparison' as const,scope:'compare' as const,comparison:{fromRef:'main',toRef:'HEAD',fromSha:'a'.repeat(40),toSha:'b'.repeat(40),leftSha:'a'.repeat(40),mode:'endpoints' as const,mergeBase:null}};
 try{
  for(const entry of[a,b,c,d])openFileReview(entry,request);
  openFileReview(a,{hostWorkspaceId:other,panelId:'changes'});
  const kept=getFileReviewPosition(host,selectionKey(c),'split');kept.offset=400;
  const discarded=getComparisonView(host,selectionKey(d));discarded.collapsed.add('hidden.ts');
  let notifications=0;const stop=subscribeFileReviews(()=>notifications++);
  closeFileReviews(host,selectionKey(c),'others');stop();
  assert.equal(notifications,1);assert.deepEqual(getFileReviews(host),[c]);assert.equal(getActiveFileReviewKey(host),selectionKey(c));
  assert.equal(getFileReviewPosition(host,selectionKey(c),'split'),kept);assert.equal(kept.offset,400);
  assert.equal(getComparisonView(host,selectionKey(d)).collapsed.size,0);assert.equal(getFileReviews(other).length,1);
  openFileReview(a,request);setActiveFileReview(host,selectionKey(c));closeFileReviews(host,selectionKey(a),'current');assert.equal(getActiveFileReviewKey(host),selectionKey(c));
  closeFileReviews(host,selectionKey(c),'all');assert.equal(getFileReviews(host).length,0);assert.equal(getActiveFileReviewKey(host),'');
 }finally{clearFileReviews(host);clearFileReviews(other);}
});

test('document tabs close beside the active file and apply all group modes only within their host',()=>{
 const first:DocumentSelection={hostWorkspaceId:'tab-close-documents',projectConfig:'/fixture/project.json',scope:'doc-tabs',workspaceId:'one',instance:'instance',workspaceName:'One',directory:'/fixture',path:'a.ts'};
 const docs=['a.ts','b.ts','c.ts','d.ts','e.ts'].map(path=>({...first,path})),other={...first,hostWorkspaceId:'tab-close-documents-other'};
 try{
  openDocument(other);
  for(const [mode,remaining,active]of [['current',['a.ts','b.ts','d.ts','e.ts'],'e.ts'],['others',['c.ts'],'c.ts'],['left',['c.ts','d.ts','e.ts'],'e.ts'],['right',['a.ts','b.ts','c.ts'],'c.ts'],['all',[],'']] as [TabCloseMode,string[],string][]){
   clearDocuments(first.hostWorkspaceId);for(const doc of docs)openDocument(doc);
   closeDocument(docs[2],mode);
   assert.deepEqual(getDocuments(first.hostWorkspaceId).map(d=>d.path),remaining,mode);
   assert.equal(getActiveDocumentKey(first.hostWorkspaceId),active?documentKey({...first,path:active}):'',mode);
   assert.equal(getDocuments(other.hostWorkspaceId).length,1);
  }
  for(const doc of docs)openDocument(doc);activateDocument(docs[1]);closeDocument(docs[3]);assert.equal(getActiveDocumentKey(first.hostWorkspaceId),documentKey(docs[1]));
  closeDocument(docs[1]);assert.equal(getActiveDocumentKey(first.hostWorkspaceId),documentKey(docs[2]));
 }finally{clearDocuments(first.hostWorkspaceId);clearDocuments(other.hostWorkspaceId);}
});
