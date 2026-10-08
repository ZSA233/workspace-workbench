import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Service} from '../server/backend/service.ts';
import {loadConfig} from '../server/backend/config.ts';
import {comparisonFileRows,documentMetrics,documentAnchor,anchorOffset,type DocumentRow} from '../client/comparison-reading-model.ts';
import {unchangedRanges,type ContextSlice} from '../shared/diff-context.ts';
import type {DiffResult} from '../client/model.ts';
import {selectionKey,openFileReview,getFileReviews,clearFileReviews,getComparisonView,closeFileReview,type FileReviewSelection} from '../client/file-review-store.ts';
const git=(path:string,...args:string[])=>execFileSync('git',['-C',path,...args],{encoding:'utf8'}).trim();
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-continuous-'))),repo=join(root,'repo');mkdirSync(repo);git(repo,'init','-q','-b','main');git(repo,'config','user.name','Sample');git(repo,'config','user.email','sample@example.invalid');const original=Array.from({length:500},(_,i)=>`// context ${i+1}`);writeFileSync(join(repo,'sample.go'),original.join('\n')+'\n');git(repo,'add','.');git(repo,'commit','-qm','base');const base=git(repo,'rev-parse','HEAD');const changed=original.slice();changed[249]='const value = 2';writeFileSync(join(repo,'sample.go'),changed.join('\n')+'\n');git(repo,'commit','-qam','change');const head=git(repo,'rev-parse','HEAD');const config=join(root,'project.json');writeFileSync(config,JSON.stringify({schemaVersion:1,project:{id:'sample'},sourceRoot:root,workspaceRoot:join(root,'workspaces'),stateRoot:join(root,'state'),repositories:[{id:'repo',path:'repo'}],discovery:{mode:'manual'},management:{enabled:true}}));const service=new Service(loadConfig(config));return {root,repo,base,head,original,service,async close(){await service.close();rmSync(root,{recursive:true,force:true});}};}
async function range(f:ReturnType<typeof fixture>){const result=await f.service.handle('repository.compare',{workspaceId:'main',repoPath:'repo',comparison:{fromRef:f.base,toRef:f.head}});return {workspaceId:'main',workspaceInstance:result.workspaceInstance,repoPath:'repo',path:'sample.go',scope:'compare',comparison:result.comparison};}
test('bounded context comes from frozen blobs and refuses changed or mismatched positions',async()=>{const f=fixture();try{
 const params=await range(f),diff=await f.service.handle('repository.diff',params);
 writeFileSync(join(f.repo,'sample.go'),'unrelated working content\n');
 const context=await f.service.handle('repository.diff',{...params,readKind:'context',context:{oldStart:1,newStart:1,count:200,direction:'forward'}});assert.equal(context.lines.length,200);assert.equal(context.lines[0].content,f.original[0]);assert.equal(context.patchDigest,diff.patchDigest);assert.equal(context.oldTotal,500);
 const end=await f.service.handle('repository.diff',{...params,readKind:'context',context:{oldStart:501,newStart:501,count:20,direction:'forward'}});assert.deepEqual(end.lines,[]);
 for(const ctx of [{oldStart:250,newStart:250,count:20,direction:'forward'},{oldStart:1,newStart:2,count:20,direction:'forward'},{oldStart:1,newStart:1,count:201,direction:'forward'}])await assert.rejects(f.service.handle('repository.diff',{...params,readKind:'context',context:ctx}));
 await assert.rejects(f.service.handle('repository.diff',{...params,workspaceInstance:'wrong-instance',readKind:'context',context:{oldStart:1,newStart:1,count:20,direction:'forward'}}),/original workspace/);
 const backwards=await f.service.handle('repository.diff',{...params,readKind:'context',context:{oldStart:249,newStart:249,count:20,direction:'backward'}});assert.equal(backwards.lines[0].oldLine,230);assert.equal(backwards.lines.at(-1).oldLine,249);
}finally{await f.close();}});
test('folding shows three context lines and expansion has unique stable code positions',async()=>{const f=fixture();try{
 const params=await range(f),diff=await f.service.handle('repository.diff',params) as DiffResult;
 const folded=comparisonFileRows(diff,'unified');const code=folded.rows.filter(r=>r.kind==='code');assert.equal(code.length,8);assert.equal(folded.hunks.length,1);
 const context=await f.service.handle('repository.diff',{...params,readKind:'context',context:{oldStart:1,newStart:1,count:20,direction:'forward'}});
 const expanded=comparisonFileRows(diff,'unified',[{oldStart:1,newStart:1,count:20}],[context as ContextSlice]);assert.equal(expanded.rows.filter(r=>r.kind==='code').length,28);assert.equal(new Set(expanded.rows.map(r=>r.key)).size,expanded.rows.length);assert.equal(diff.patchDigest,context.patchDigest);
 const split=comparisonFileRows(diff,'split');assert.equal(split.rows.filter(r=>r.kind==='code').length,7);
}finally{await f.close();}});
test('context handles renamed special paths, CRLF, missing final newline and byte caps',async()=>{const f=fixture();try{
 git(f.repo,'mv','sample.go',':(literal) renamed.go');writeFileSync(join(f.repo,':(literal) renamed.go'),f.original.map((line,i)=>i===249?'changed':line).join('\r\n'));git(f.repo,'add','.');git(f.repo,'commit','-qm','rename');const compare=await f.service.handle('repository.compare',{workspaceId:'main',repoPath:'repo',comparison:{fromRef:f.base,toRef:'HEAD'}});
 const params={workspaceId:'main',repoPath:'repo',path:':(literal) renamed.go',oldPath:'sample.go',scope:'compare',comparison:compare.comparison};
 // Line-ending changes are real changes, so none may be invented as unchanged.
 await assert.rejects(f.service.handle('repository.diff',{...params,readKind:'context',context:{oldStart:1,newStart:1,count:20,direction:'forward'}}));
 writeFileSync(join(f.repo,':(literal) renamed.go'),f.original.map((line,i)=>i===249?'changed':line).join('\n'));git(f.repo,'commit','-qam','same ending except EOF');const c=await f.service.handle('repository.compare',{workspaceId:'main',repoPath:'repo',comparison:{fromRef:f.base,toRef:'HEAD'}});const value=await f.service.handle('repository.diff',{...params,comparison:c.comparison,readKind:'context',context:{oldStart:1,newStart:1,count:20,direction:'forward'}});assert.equal(value.lines[0].content,f.original[0]);
 f.service.workspaces.config.maxDiffBytes=128;await assert.rejects(f.service.handle('repository.diff',{...params,comparison:c.comparison,readKind:'context',context:{oldStart:21,newStart:21,count:20,direction:'forward'}}));
}finally{await f.close();}});
test('anchors survive inserted rows and unified-to-split changes',()=>{
 const rows:DocumentRow[]=[{kind:'file',path:'a',key:'file:a'},{kind:'code',path:'a',key:'a:line',display:{kind:'unified',hunkIndex:0,key:'line',line:{kind:'context',content:'same',oldLine:20,newLine:20}}}];const metrics=documentMetrics(rows,14,{}),anchor=documentAnchor(rows,metrics,40);
 const next:DocumentRow[]=[rows[0],{kind:'status',path:'a',key:'loading'},{...rows[1],key:'a:split',kind:'code',display:{kind:'split',key:'split',hunkIndex:0,left:{kind:'context',content:'same',oldLine:20,newLine:20},right:{kind:'context',content:'same',oldLine:20,newLine:20}}}];assert.equal(anchorOffset(anchor,next,documentMetrics(next,14,{})),76);
});
test('one group tab per frozen range and instance, with independent single-file tabs and state cleanup',()=>{
 const host='continuous-test';const comparison={fromRef:'main',toRef:'HEAD',fromSha:'a'.repeat(40),toSha:'b'.repeat(40),mode:'endpoints' as const,leftSha:'a'.repeat(40),mergeBase:null};const selection:FileReviewSelection={kind:'comparison',workspaceId:'main',workspaceInstance:'one',repoPath:'repo',path:'a',scope:'compare',comparison,branch:'main',status:'M',statusLabel:'Modified'};
 openFileReview(selection,{hostWorkspaceId:host,panelId:'sample'});openFileReview({...selection,path:'b'},{hostWorkspaceId:host,panelId:'sample'});assert.equal(getFileReviews(host).length,1);openFileReview({...selection,kind:'file'},{hostWorkspaceId:host,panelId:'sample'});assert.equal(getFileReviews(host).length,2);
 assert.notEqual(selectionKey(selection),selectionKey({...selection,workspaceInstance:'two'}));getComparisonView(host,selectionKey(selection)).collapsed.add('a');closeFileReview(host,selectionKey(selection));assert.equal(getComparisonView(host,selectionKey(selection)).collapsed.size,0);clearFileReviews(host);
});
test('gap mapping handles insertions, deletions and a root addition',()=>{
 assert.deepEqual(unchangedRanges('@@ -0,0 +1,2 @@\n+a\n+b\n',0,2),[]);
 assert.deepEqual(unchangedRanges('@@ -2,0 +3,1 @@\n+x\n',4,5),[{oldStart:1,newStart:1,count:2},{oldStart:3,newStart:4,count:2}]);
});

test('binary and Gitlink context stays unsupported; literal marker text is regular source',async()=>{const f=fixture();try{
 writeFileSync(join(f.repo,'binary.dat'),Buffer.from([0,1,2,3]));writeFileSync(join(f.repo,'literal.txt'),'Binary files example and GIT binary patch literal\nsecond\n');git(f.repo,'add','.');git(f.repo,'update-index','--add','--cacheinfo',`160000,${f.base},nested`);git(f.repo,'commit','-qm','mixed kinds');
 const c=await f.service.handle('repository.compare',{workspaceId:'main',repoPath:'repo',comparison:{fromRef:f.base,toRef:'HEAD'}});
 for(const path of ['binary.dat','nested'])await assert.rejects(f.service.handle('repository.diff',{workspaceId:'main',repoPath:'repo',path,scope:'compare',comparison:c.comparison,readKind:'context',context:{oldStart:1,newStart:1,count:20,direction:'forward'}}));
 const text=await f.service.handle('repository.diff',{workspaceId:'main',repoPath:'repo',path:'literal.txt',scope:'compare',comparison:c.comparison});assert.equal(text.binary,false);
 const rows=comparisonFileRows(text as DiffResult,'unified');assert.equal(rows.rows.filter(r=>r.kind==='gap').length,0,'complete added files do not show pointless context controls');
}finally{await f.close();}});

test('expanding content above a visible code line preserves its screen position',()=>{
 const code={kind:'code' as const,path:'a',key:'a:20',display:{kind:'unified' as const,key:'20',hunkIndex:0,line:{kind:'context' as const,content:'same',oldLine:20,newLine:20}}};
 const rows:DocumentRow[]=[{kind:'file',path:'a',key:'file:a'},{kind:'gap',path:'a',key:'gap',gap:{oldStart:1,newStart:1,count:19,key:'gap'}},code];
 const old=documentMetrics(rows,14,{}),anchor=documentAnchor(rows,old,0,32);assert.equal(anchor?.key,'a:20');
 const next:DocumentRow[]=[rows[0],...Array.from({length:19},(_,i)=>({...code,key:`a:${i+1}`,display:{...code.display,key:String(i+1),line:{...code.display.line,oldLine:i+1,newLine:i+1}}})),code];
 const metrics=documentMetrics(next,14,{}),offset=anchorOffset(anchor,next,metrics);assert.equal(metrics.offsets.at(-1)!-offset,old.offsets[2]);
});

test('all context expands in bounded steps and navigation survives expansion',async()=>{const f=fixture();try{
 const source=f.original.slice();source[99]='const first = 1';source[249]='const second = 2';writeFileSync(join(f.repo,'sample.go'),source.join('\n')+'\n');git(f.repo,'commit','-qam','two changes');f.head=git(f.repo,'rev-parse','HEAD');
 const params=await range(f),diff=await f.service.handle('repository.diff',params) as DiffResult,slices:ContextSlice[]=[];
 const folded=comparisonFileRows(diff,'unified');assert.equal(folded.hunks.length,2);
 for(let iteration=0;iteration<10;iteration++){
  const model=comparisonFileRows(diff,'unified',[{oldStart:1,newStart:1,count:500}],slices);
  const gap=model.rows.find(r=>r.kind==='gap');if(!gap)break;
  assert.equal(gap.kind,'gap');const value=await f.service.handle('repository.diff',{...params,readKind:'context',context:{oldStart:gap.gap.oldStart,newStart:gap.gap.newStart,count:Math.min(200,gap.gap.count||200),direction:'forward'}}) as ContextSlice;
  assert.ok(value.lines.length<=200);assert.ok(Buffer.byteLength(JSON.stringify(value))<=65536);slices.push(value);
 }
 const expanded=comparisonFileRows(diff,'unified',[{oldStart:1,newStart:1,count:500}],slices);assert.equal(expanded.rows.filter(r=>r.kind==='gap').length,0);assert.equal(expanded.rows.length,502);assert.equal(expanded.hunks.length,2);assert.equal(new Set(expanded.rows.map(r=>r.key)).size,502);
}finally{await f.close();}});

test('contribution context reads the merge base, including inserted and deleted line mappings',async()=>{const f=fixture();try{
 git(f.repo,'checkout','-qb','production',f.base);const prod=f.original.slice();prod[10]='// production only';writeFileSync(join(f.repo,'sample.go'),prod.join('\n')+'\n');git(f.repo,'commit','-qam','production change');const production=git(f.repo,'rev-parse','HEAD');
 git(f.repo,'checkout','-q','main');const branch=f.original.slice();branch.splice(249,1,'const inserted = 1','const extra = 2');branch.splice(399,2);writeFileSync(join(f.repo,'sample.go'),branch.join('\n')+'\n');git(f.repo,'commit','-qam','insert and remove');
 const c=await f.service.handle('repository.compare',{workspaceId:'main',repoPath:'repo',comparison:{fromRef:production,toRef:'HEAD',mode:'contribution'}});assert.equal(c.comparison.leftSha,f.base);
 const params={workspaceId:'main',repoPath:'repo',scope:'compare',path:'sample.go',comparison:c.comparison};
 const start=await f.service.handle('repository.diff',{...params,readKind:'context',context:{oldStart:1,newStart:1,count:20,direction:'forward'}});assert.equal(start.lines[10].content,f.original[10]);
 const middle=await f.service.handle('repository.diff',{...params,readKind:'context',context:{oldStart:300,newStart:301,count:20,direction:'forward'}});assert.equal(middle.lines[0].content,f.original[299]);
 const tail=await f.service.handle('repository.diff',{...params,readKind:'context',context:{oldStart:450,newStart:449,count:100,direction:'forward'}});assert.equal(tail.lines.at(-1).content,f.original.at(-1));assert.equal(tail.lines.at(-1).newLine,499);
}finally{await f.close();}});
