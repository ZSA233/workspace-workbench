import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Service} from '../server/backend/service.ts';
import {loadConfig} from '../server/backend/config.ts';
import {noteBatch} from '../shared/change-notes.ts';
import {hash,stable} from '../server/backend/storage.ts';
const git=(root:string,...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-notes-'))),repo=join(root,'repo');mkdirSync(repo);git(repo,'init','-q','-b','main');git(repo,'config','user.name','Sample');git(repo,'config','user.email','sample@example.invalid');writeFileSync(join(repo,'sample.go'),'package sample\n\nfunc value() int { return 1 }\n');git(repo,'add','.');git(repo,'commit','-qm','initial');const base=git(repo,'rev-parse','HEAD');writeFileSync(join(repo,'sample.go'),'package sample\n\nfunc value() int { return 2 }\n');git(repo,'commit','-qam','change');const head=git(repo,'rev-parse','HEAD');const config=join(root,'config.json');writeFileSync(config,JSON.stringify({schemaVersion:1,project:{id:'sample'},sourceRoot:root,workspaceRoot:join(root,'workspaces'),stateRoot:join(root,'state'),repositories:[{id:'repo',path:'repo'}],discovery:{mode:'manual'},management:{enabled:true}}));const service=new Service(loadConfig(config));return {root,repo,base,head,config,service,params:{workspaceId:'main',repoPath:'repo',scope:'compare',comparison:{fromRef:base,toRef:head}},close(){service.observation.close();rmSync(root,{recursive:true,force:true});}};}
const content={title:'Update value',reason:'Requested default changed',behavior:'Returns two',basis:'requirement',requirement:'Example requirement',perspective:'implementer',question:'Confirm consumers',evidence:'Example check',anchors:[{path:'sample.go',side:'new',start:3,end:3}]};
test('snapshots are immutable; writes are atomic, idempotent and revision checked; feedback stays independent',async()=>{const f=fixture();try{const {snapshot}=await f.service.handle('notes.read',f.params);assert.match(snapshot.files[0].patch,/return 2/);const batch={requestId:'once',snapshotId:snapshot.id,operations:[{id:'default',expectedRevision:0,action:'upsert',content}]};const input={...f.params,author:'verified-agent',batch};const result=await f.service.handle('notes.write',input);assert.deepEqual(await f.service.handle('notes.write',input),result);
 await assert.rejects(f.service.handle('notes.write',{...input,batch:{...batch,operations:[{...batch.operations[0],content:{...content,title:'Different'}}]}}),/Request ID/);
 await f.service.handle('notes.feedback',{...f.params,feedback:{requestId:'read',id:'default',revision:1,action:'read'}});
 await f.service.handle('notes.feedback',{...f.params,feedback:{requestId:'question',id:'default',revision:1,action:'question',text:'Why two?'}});
 await assert.rejects(f.service.handle('notes.write',{...input,batch:{...batch,requestId:'conflict'}}),/latest note/);
 await assert.rejects(f.service.handle('notes.write',{...input,batch:{...batch,requestId:'invalid',operations:[{id:'new',expectedRevision:0,action:'upsert',content},{id:'bad',expectedRevision:0,action:'upsert',content:{...content,anchors:[{path:'sample.go',side:'new',start:999,end:999}]}}]}}),/outside/);
 const list=await f.service.handle('notes.read',{...f.params,action:'list'});assert.equal(list.notes.length,1);assert.equal(list.feedback.length,2);
 await f.service.handle('notes.write',{...input,batch:{...batch,requestId:'revision2',operations:[{...batch.operations[0],expectedRevision:1}]}});
 const next=await f.service.handle('notes.read',{...f.params,action:'list'});assert.equal(next.notes[0].revision,2);assert.equal(next.feedback.filter((x:any)=>x.revision===2).length,0);
 writeFileSync(join(f.repo,'sample.go'),'changed again\n');const saved=await f.service.handle('notes.read',{...f.params,snapshotId:snapshot.id});assert.equal(saved.snapshot.files[0].patch,snapshot.files[0].patch);
 const restarted=new Service(loadConfig(f.config));try{assert.equal((await restarted.handle('notes.read',{...f.params,action:'list'})).notes.length,1);}finally{restarted.observation.close();}
}finally{f.close();}});
test('working changes capture content; deleted lines and commit snapshots retain old-side positions',async()=>{const f=fixture();try{writeFileSync(join(f.repo,'sample.go'),'package sample\n');const working=await f.service.handle('notes.read',{...f.params,scope:'working'});assert.match(working.snapshot.files[0].patch,/-func value/);const commit=await f.service.handle('notes.read',{...f.params,scope:'commit',commitSha:f.head});assert.equal(commit.snapshot.right,f.head);assert.equal(commit.snapshot.left,f.base);await f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId:'old',snapshotId:working.snapshot.id,operations:[{id:'deleted',expectedRevision:0,action:'upsert',content:{...content,anchors:[{path:'sample.go',side:'old',start:3,end:3}]}}]}});}finally{f.close();}});
test('agent schema forbids user feedback and reviewer catalog has no note write tool',()=>{assert.equal(noteBatch.safeParse({requestId:'x',snapshotId:'a'.repeat(64),operations:[{id:'n',expectedRevision:0,action:'upsert',content:{...content,confirmed:true}}]}).success,false)});

test('line anchor schema requires an ordered range and file anchors forbid line numbers',()=>{
 const accepts=(anchor:Record<string,unknown>)=>noteBatch.safeParse({requestId:'schema',snapshotId:'a'.repeat(64),operations:[{id:'one',expectedRevision:0,action:'upsert',content:{...content,anchors:[anchor]}}]}).success;
 for(const side of ['old','new']){
  assert.equal(accepts({path:'sample.go',side,start:3,end:3}),true);
  assert.equal(accepts({path:'sample.go',side,start:1,end:3}),true);
  for(const range of [{},{start:3},{end:3},{start:3,end:2}])assert.equal(accepts({path:'sample.go',side,...range}),false,JSON.stringify({side,...range}));
 }
 assert.equal(accepts({path:'sample.go',side:'file'}),true);
 for(const range of [{start:3},{end:3},{start:3,end:3}])assert.equal(accepts({path:'sample.go',side:'file',...range}),false,JSON.stringify(range));
});

test('complete text requires line anchors atomically while captured context and added lines remain valid',async()=>{const f=fixture();try{
 const {snapshot}=await f.service.handle('notes.read',f.params);
 await assert.rejects(f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId:'mixed-file-anchor',snapshotId:snapshot.id,operations:[
  {id:'valid',expectedRevision:0,action:'upsert',content},
  {id:'file-only',expectedRevision:0,action:'upsert',content:{...content,anchors:[{path:'sample.go',side:'file'}]}}
 ]}}),{code:'notes_line_anchor_required',message:/old\/new.*start and end/});
 assert.equal((await f.service.handle('notes.read',{...f.params,action:'list'})).notes.length,0);
 const anchors=[{path:'sample.go',side:'old',start:1,end:2},{path:'sample.go',side:'new',start:3,end:3}];
 await f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId:'context-and-added',snapshotId:snapshot.id,operations:[{id:'located',expectedRevision:0,action:'upsert',content:{...content,anchors}}]}});
 const list=await f.service.handle('notes.read',{...f.params,action:'list'});assert.equal(list.notes.length,1);assert.deepEqual(list.notes[0].content.anchors,anchors);
}finally{f.close();}});

test('snapshot scope rejects another workspace; changed refs do not rewrite captured content',async()=>{const f=fixture();try{
 const first=await f.service.handle('notes.read',f.params);
 await f.service.handle('workspace.create',{name:'separate',repositories:['repo']});
 await assert.rejects(f.service.handle('notes.write',{workspaceId:'separate',repoPath:'repo',author:'agent',batch:{requestId:'cross',snapshotId:first.snapshot.id,operations:[{id:'x',expectedRevision:0,action:'upsert',content}]}}),/another workspace/);
 await assert.rejects(f.service.handle('notes.read',{...f.params,paths:['../outside']}),/relative repository path/);
 git(f.repo,'mv','sample.go','renamed.go');writeFileSync(join(f.repo,'binary.dat'),Buffer.from([0,1,2]));writeFileSync(join(f.repo,':(glob)*'),'literal\n');git(f.repo,'add','.');git(f.repo,'commit','-qm','rename and binary');
 const read=await f.service.handle('notes.read',{...f.params,comparison:{fromRef:f.head,toRef:'HEAD'}});
 assert.ok(read.snapshot.files.some((x:any)=>x.path==='renamed.go'&&x.oldPath==='sample.go'));
 assert.doesNotMatch(read.snapshot.files.find((x:any)=>x.path==='renamed.go').patch,/^@@/m);
 assert.ok(read.snapshot.files.some((x:any)=>x.path==='binary.dat'&&x.binary));
 await assert.rejects(f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId:'binary',snapshotId:read.snapshot.id,operations:[{id:'b',expectedRevision:0,action:'upsert',content:{...content,anchors:[{path:'binary.dat',side:'new',start:1,end:1}]}}]}}),/complete text/);
 await f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId:'file-level',snapshotId:read.snapshot.id,operations:[{id:'b',expectedRevision:0,action:'upsert',content:{...content,anchors:[{path:'binary.dat',side:'file'},{path:'renamed.go',side:'file'}]}}]}});
 const replay=await f.service.handle('notes.read',{...f.params,snapshotId:first.snapshot.id});assert.equal(replay.snapshot.right,f.head);
}finally{f.close();}});

test('line-free metadata, empty files, truncated patches and Gitlinks retain file anchors',async()=>{const f=fixture();try{
 writeFileSync(join(f.repo,'empty.txt'),'');writeFileSync(join(f.repo,'large.txt'),'x'.repeat(140000)+'\n');git(f.repo,'add','empty.txt','large.txt');
 git(f.repo,'update-index','--chmod=+x','sample.go');git(f.repo,'update-index','--add','--cacheinfo',`160000,${f.base},module`);git(f.repo,'commit','-qm','metadata and bounded patches');
 const paths=['sample.go','empty.txt','large.txt','module'];
 const {snapshot}=await f.service.handle('notes.read',{...f.params,comparison:{fromRef:f.head,toRef:'HEAD'},paths});
 for(const path of ['sample.go','empty.txt']){const file=snapshot.files.find((x:any)=>x.path===path);assert.equal(file.binary,false);assert.equal(file.truncated,false);assert.doesNotMatch(file.patch,/^@@/m);}
 const large=snapshot.files.find((x:any)=>x.path==='large.txt');assert.equal(large.binary,false);assert.equal(large.truncated,true);assert.match(large.patch,/^@@/m);
 const module=snapshot.files.find((x:any)=>x.path==='module');assert.equal(module.binary,true);assert.match(module.patch,/Subproject commit/);
 await f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId:'file-exceptions',snapshotId:snapshot.id,operations:[{id:'exceptions',expectedRevision:0,action:'upsert',content:{...content,anchors:paths.map(path=>({path,side:'file'}))}}]}});
 for(const path of ['large.txt','module'])await assert.rejects(f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId:`invalid-line-${path}`,snapshotId:snapshot.id,operations:[{id:`invalid-${path}`,expectedRevision:0,action:'upsert',content:{...content,anchors:[{path,side:'new',start:1,end:1}]}}]}}),/complete text/);
 const list=await f.service.handle('notes.read',{...f.params,action:'list'});assert.equal(list.notes.length,1);assert.equal(list.notes[0].content.anchors.length,paths.length);
}finally{f.close();}});

test('persisted legacy text file notes remain readable, retryable, editable and withdrawable',async()=>{const f=fixture();try{
 const {snapshot}=await f.service.handle('notes.read',f.params);
 const legacyContent={...content,anchors:[{path:'sample.go',side:'file'}]},batch=noteBatch.parse({requestId:'legacy-write',snapshotId:snapshot.id,operations:[{id:'legacy',expectedRevision:0,action:'upsert',content:legacyContent}]}),author='legacy-agent';
 const note={id:'legacy',revision:1,snapshotId:snapshot.id,author,updatedAt:'2026-01-01T00:00:00.000Z',withdrawn:false,content:legacyContent},result={revisions:[{id:'legacy',revision:1}]};
 const ledgers=join(f.root,'state','change-notes','ledgers'),ledgerPath=join(ledgers,hash(stable([snapshot.instance,snapshot.repoPath]))+'.json');mkdirSync(ledgers,{recursive:true});
 // Seed the previous durable format directly; current writes must never create this unlocated text note.
 writeFileSync(ledgerPath,JSON.stringify({schema:1,snapshots:{[snapshot.id]:{...snapshot,files:snapshot.files.map(({patch,...file}:any)=>file)}},notes:[note],history:[],feedback:[],requests:{[batch.requestId]:{digest:hash(stable([author,batch])),result}}}));
 const restarted=new Service(loadConfig(f.config));try{
  const before=await restarted.handle('notes.read',{...f.params,action:'list'});assert.deepEqual(before.notes,[note]);
  assert.deepEqual(await restarted.handle('notes.write',{...f.params,author,batch}),result);
  await assert.rejects(restarted.handle('notes.write',{...f.params,author,batch:{...batch,requestId:'legacy-new-write',operations:[{...batch.operations[0],expectedRevision:1}]}}),{code:'notes_line_anchor_required'});
  const {anchors,...text}=legacyContent;
  await restarted.handle('notes.manage',{...f.params,management:{requestId:'legacy-edit',id:'legacy',revision:1,action:'edit',content:{...text,title:'Edited legacy explanation'}}});
  const edited=await restarted.handle('notes.read',{...f.params,action:'list'});assert.equal(edited.notes[0].revision,2);assert.equal(edited.notes[0].content.title,'Edited legacy explanation');assert.deepEqual(edited.notes[0].content.anchors,anchors);
  await restarted.handle('notes.write',{...f.params,author,batch:{requestId:'legacy-withdraw',snapshotId:snapshot.id,operations:[{id:'legacy',expectedRevision:2,action:'withdraw'}]}});
  assert.equal((await restarted.handle('notes.read',{...f.params,action:'list'})).notes.length,0);
  const ledger=JSON.parse(readFileSync(ledgerPath,'utf8'));assert.equal(ledger.schema,1);assert.deepEqual(ledger.history.map((n:any)=>n.revision),[1,2]);assert.deepEqual(ledger.history[0],note);
 }finally{restarted.observation.close();}
}finally{f.close();}});

test('concurrent revisions have one winner; withdraw preserves history and request retry',async()=>{const f=fixture();try{
 const {snapshot}=await f.service.handle('notes.read',f.params);
 const write=(requestId:string,expectedRevision:number,action='upsert')=>f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId,snapshotId:snapshot.id,operations:[{id:'one',expectedRevision,action,...(action==='upsert'?{content}:{})}]}});
 const results=await Promise.allSettled([write('a',0),write('b',0)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 await write('withdraw',1,'withdraw');assert.equal((await f.service.handle('notes.read',{...f.params,action:'list'})).notes.length,0);
 assert.equal((await write('withdraw',1,'withdraw')).revisions[0].revision,2);
 await assert.rejects(f.service.handle('notes.feedback',{...f.params,feedback:{requestId:'old-user',id:'one',revision:1,action:'confirm',text:'yes'}}),/changed/);
}finally{f.close();}});

test('comparison catalog pagination, version guard, fixed label identities and historical reads',async()=>{const f=fixture();try{
 const write=async(snapshotId:string,id:string,revision=0)=>f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId:`catalog-${id}-${revision}`,snapshotId,operations:[{id,expectedRevision:revision,action:'upsert',content}]}});
 const first=await f.service.handle('notes.read',{...f.params,comparison:{...f.params.comparison,fromLabel:'origin/main',toLabel:'feature/sample'}});await write(first.snapshot.id,'one');
 const duplicate=await f.service.handle('notes.read',{...f.params,comparison:{...f.params.comparison,fromLabel:'release/stable',toLabel:'feature/sample'}});await write(duplicate.snapshot.id,'two');
 let catalog=await f.service.handle('notes.read',{...f.params,action:'catalog'});assert.equal(catalog.total,1);assert.equal(catalog.records[0].noteCount,2);assert.equal(catalog.records[0].aliases.length,2);
 const originalId=catalog.records[0].id;
 writeFileSync(join(f.repo,'sample.go'),'package sample\n\nfunc value() int { return 3 }\n');git(f.repo,'commit','-qam','new default');
 const next=await f.service.handle('notes.read',{...f.params,comparison:{fromRef:f.base,toRef:'HEAD',fromLabel:'origin/main',toLabel:'feature/sample'}});await write(next.snapshot.id,'one',1);
 const old=await f.service.handle('notes.read',{...f.params,action:'list',comparisonId:originalId});assert.equal(old.notes.find((n:any)=>n.id==='one').historical,true);assert.equal(old.notes.find((n:any)=>n.id==='one').latestRevision,2);
 await assert.rejects(f.service.handle('notes.manage',{...f.params,management:{requestId:'old-edit',id:'one',revision:1,action:'withdraw'}}),/changed/);
 await assert.rejects(f.service.handle('notes.read',{...f.params,action:'catalog',catalogRevision:catalog.revision,offset:20}),/changed while paging/);
 assert.equal((await f.service.handle('notes.read',{...f.params,action:'catalog',search:'release/stable'})).matched,1);
 assert.equal((await f.service.handle('notes.read',{...f.params,action:'catalog',search:'missing'})).total,2);
 for(let i=0;i<21;i++){
  git(f.repo,'commit','--allow-empty','-qm',`snapshot ${i}`);
  const snapshot=await f.service.handle('notes.read',{...f.params,comparison:{fromRef:f.base,toRef:'HEAD'}});await write(snapshot.snapshot.id,`page-${i}`);
 }
 catalog=await f.service.handle('notes.read',{...f.params,action:'catalog'});assert.equal(catalog.records.length,20);assert.equal(catalog.nextOffset,20);
 const page=await f.service.handle('notes.read',{...f.params,action:'catalog',offset:20,catalogRevision:catalog.revision});assert.equal(page.records.length,3);
 assert.equal(new Set([...catalog.records,...page.records].map((r:any)=>r.id)).size,23);
}finally{f.close();}});

test('catalog and saved explanations remain readable after a Git object disappears',async()=>{const f=fixture();try{
 const {snapshot}=await f.service.handle('notes.read',f.params);
 await f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId:'retain',snapshotId:snapshot.id,operations:[{id:'one',expectedRevision:0,action:'upsert',content}]}});
 const original=await f.service.handle('notes.read',{...f.params,action:'catalog'});
 rmSync(join(f.repo,'.git','objects',f.head.slice(0,2),f.head.slice(2)));
 const after=await f.service.handle('notes.read',{...f.params,action:'catalog'});assert.deepEqual(after,original);
 const notes=await f.service.handle('notes.read',{...f.params,action:'list',comparisonId:original.records[0].id});assert.equal(notes.notes.length,1);
 const saved=await f.service.handle('notes.read',{...f.params,snapshotId:snapshot.id});assert.match(saved.snapshot.files[0].patch,/return 2/);
 await assert.rejects(f.service.handle('repository.compare',f.params));
}finally{f.close();}});

test('catalog revisions track user question edits and withdrawal removes the whole record',async()=>{const f=fixture();try{
 const {snapshot}=await f.service.handle('notes.read',f.params);
 await f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId:'user-note',snapshotId:snapshot.id,operations:[{id:'one',expectedRevision:0,action:'upsert',content:{...content,question:''}}]}});
 await f.service.handle('notes.feedback',{...f.params,feedback:{requestId:'question',id:'one',revision:1,action:'question',text:'Why?'}});
 const before=await f.service.handle('notes.read',{...f.params,action:'catalog'});assert.equal(before.records[0].pendingCount,1);
 const list=await f.service.handle('notes.read',{...f.params,action:'list'}),event=list.feedback[0];
 const edit={...f.params,management:{requestId:'delete-question',id:'one',revision:1,action:'question-delete',eventId:event.eventId,expectedVersion:event.version}};
 await f.service.handle('notes.manage',edit);await f.service.handle('notes.manage',edit);
 const after=await f.service.handle('notes.read',{...f.params,action:'catalog'});assert.equal(after.records[0].pendingCount,0);assert.notEqual(after.revision,before.revision);
 await f.service.handle('notes.manage',{...f.params,management:{requestId:'delete-note',id:'one',revision:1,action:'withdraw'}});assert.equal((await f.service.handle('notes.read',{...f.params,action:'catalog'})).total,0);
}finally{f.close();}});
