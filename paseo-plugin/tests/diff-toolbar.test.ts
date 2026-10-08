import test from 'node:test';
import assert from 'node:assert/strict';
import {diffReadingReferences,diffTabLabels,diffToolbarLayout} from '../client/diff-toolbar-model.ts';
import type {FileReviewSelection} from '../client/file-review-store.ts';
import type {DiffResult} from '../client/model.ts';
const selection=(path='src/item.go'):FileReviewSelection=>({workspaceId:'task',repoPath:'server',path,scope:'branch',branch:'feature/sample',status:'M',statusLabel:'Modified',baseSha:'a'.repeat(40),head:'b'.repeat(40)});
const diff:DiffResult={path:'src/item.go',patch:'patch',scope:'branch',truncated:false,baseSha:'c'.repeat(40),head:'d'.repeat(40)};
test('tab labels keep unique basenames short and use shortest unique directory suffixes',()=>{
 assert.deepEqual(diffTabLabels([selection('src/a/item.go'),selection('src/b/item.go'),selection('other.go')]),['a/item.go','b/item.go','other.go']);
 assert.deepEqual(diffTabLabels([selection('item.go'),selection('src/item.go')]),['item.go','src/item.go']);
});
test('identical paths in different repositories, workspaces and commit views remain distinguishable',()=>{
 const samples=[selection(),{...selection(),repoPath:'client'},{...selection(),workspaceId:'other'},{...selection(),scope:'commit' as const,commitSha:'1'.repeat(40)}];
 assert.equal(new Set(diffTabLabels(samples)).size,4);
});
test('toolbar thresholds leave room for tabs without a second control row',()=>{
 for(const width of [280,320,479])assert.deepEqual(diffToolbarLayout(width),{showRange:false,showMode:false,minHeight:36});
 assert.deepEqual(diffToolbarLayout(480),{showRange:false,showMode:true,minHeight:36});
 assert.deepEqual(diffToolbarLayout(720,true),{showRange:true,showMode:true,minHeight:44});
});
test('reference identity comes from visible content, never stale selection metadata',()=>{
 const references=diffReadingReferences(selection(),diff)!;
 assert.equal(references.from,diff.baseSha);assert.equal(references.to,diff.head);
 assert.equal(diffReadingReferences(selection(),null),null);
 assert.equal(diffReadingReferences(undefined,diff),null);
});
test('root commit and untracked file preserve empty left content; worktree is not a SHA',()=>{
 const root=diffReadingReferences({...selection(),scope:'commit',commitSha:'e'.repeat(40)},{...diff,baseSha:null})!;
 assert.equal(root.from,null);assert.equal(root.fromLabel,'∅');assert.equal(root.to,'e'.repeat(40));
 const working=diffReadingReferences({...selection(),scope:'working'},{...diff,baseSha:null})!;
 assert.equal(working.to,null);assert.equal(working.toLabel,'Working tree');assert.equal(working.from,null);
});
test('contribution details preserve both reference endpoints and actual merge base',()=>{
 const comparison={fromRef:'origin/main',toRef:'HEAD',fromSha:'1'.repeat(40),toSha:'2'.repeat(40),mode:'contribution' as const,leftSha:'3'.repeat(40),mergeBase:'3'.repeat(40)};
 const result=diffReadingReferences({...selection(),scope:'compare',comparison},diff)!;
 assert.equal(result.from,comparison.leftSha);assert.equal(result.fromRefSha,comparison.fromSha);assert.equal(result.to,comparison.toSha);assert.equal(result.mergeBase,comparison.mergeBase);
});

test('same SHA pair with different comparison semantics keeps distinct tab labels',()=>{
 const comparison={fromRef:'origin/main',toRef:'HEAD',fromSha:'1'.repeat(40),toSha:'2'.repeat(40),mode:'endpoints' as const,leftSha:'1'.repeat(40),mergeBase:null};
 const first={...selection(),scope:'compare' as const,comparison};
 const second={...first,comparison:{...comparison,mode:'contribution' as const}};
 assert.equal(new Set(diffTabLabels([first,second])).size,2);
});


test('whole comparison labels distinguish both endpoints and mode without changing file labels',()=>{
 const comparison={fromRef:'origin/main',toRef:'HEAD',fromSha:'1'.repeat(40),toSha:'2'.repeat(40),mode:'endpoints' as const,leftSha:'1'.repeat(40),mergeBase:null};
 const first={...selection(),kind:'comparison' as const,scope:'compare' as const,comparison};
 const second={...first,comparison:{...comparison,fromSha:'3'.repeat(40),leftSha:'3'.repeat(40)}};
 const third={...first,comparison:{...comparison,mode:'contribution' as const}};
 assert.equal(new Set(diffTabLabels([first,second,third])).size,3);
 assert.deepEqual(diffTabLabels([first,selection()]),['整组差异','item.go']);
});
