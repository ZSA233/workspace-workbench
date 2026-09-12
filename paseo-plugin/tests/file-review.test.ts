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
