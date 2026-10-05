import assert from 'node:assert/strict';
import test from 'node:test';
import {clearFileReviews,closeFileReview,getActiveFileReviewKey,getFileReviews,openFileReview,selectionKey,type FileReviewSelection} from '../client/file-review-store.ts';

test('tabs isolate workspace and scope, activate new files and close to their neighbor',()=>{
 const a:FileReviewSelection={workspaceId:'one',repoPath:'api',path:'file.ts',scope:'working',branch:'feature',status:'M',statusLabel:'Modified'};
 const b={...a,workspaceId:'two'};
 const c={...a,scope:'branch' as const};
 const request={hostWorkspaceId:'fixture',panelId:'changes'};
 for(const file of [a,b,c])openFileReview(file,request);
 assert.equal(getFileReviews('fixture').length,3);
 assert.equal(getActiveFileReviewKey('fixture'),selectionKey(c));
 closeFileReview('fixture',selectionKey(c));
 assert.equal(getActiveFileReviewKey('fixture'),selectionKey(b));
 assert.equal(getFileReviews('fixture')[0].workspaceId,'one');
 clearFileReviews('fixture');
});

import { getFileReviewPosition } from '../client/file-review-store.ts';
test('file positions survive panel remounts but are isolated by file, scope, host and layout and removed on close', () => {
 const a:FileReviewSelection={workspaceId:'one',repoPath:'api',path:'file.ts',scope:'working',branch:'feature',status:'M',statusLabel:'Modified'};
 const b={...a,path:'other.ts'};
 const request={hostWorkspaceId:'positions',panelId:'changes'};
 for(const file of [a,b])openFileReview(file,request);
 const key=selectionKey(a), original=getFileReviewPosition('positions',key,'split');
 original.offset=800;original.hunk=3;
 assert.equal(getFileReviewPosition('positions',key,'split'),original);
 assert.equal(getFileReviewPosition('positions',selectionKey(b),'split').offset,0);
 assert.equal(getFileReviewPosition('positions',key,'unified').offset,0);
 assert.equal(getFileReviewPosition('other-host',key,'split').offset,0);
 closeFileReview('positions',key);
 openFileReview(a,request);
 assert.equal(getFileReviewPosition('positions',key,'split').offset,0);
 clearFileReviews('positions');
 openFileReview(a,request);
 assert.equal(getFileReviewPosition('positions',key,'split').hunk,0);
 clearFileReviews('positions');
});

test('comparison tabs use frozen endpoints and keep different comparisons separate',()=>{
 const a:FileReviewSelection={workspaceId:'one',repoPath:'api',path:'file.ts',scope:'compare',branch:'feature',status:'M',statusLabel:'Modified',comparison:{fromRef:'main',toRef:'HEAD',fromSha:'a'.repeat(40),toSha:'b'.repeat(40),leftSha:'a'.repeat(40),mode:'endpoints',mergeBase:null}};
 const b={...a,comparison:{...a.comparison!,toSha:'c'.repeat(40)}};
 const request={hostWorkspaceId:'comparisons',panelId:'changes'};
 openFileReview(a,request);openFileReview(b,request);openFileReview({...a,comparison:{...a.comparison!,fromRef:'production'}},request);
 assert.equal(getFileReviews('comparisons').length,2);assert.notEqual(selectionKey(a),selectionKey(b));clearFileReviews('comparisons');
});
