import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Service} from '../server/backend/service.ts';
import {loadConfig} from '../server/backend/config.ts';
import {noteBatch} from '../shared/change-notes.ts';
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

test('snapshot scope rejects another workspace; changed refs do not rewrite captured content',async()=>{const f=fixture();try{
 const first=await f.service.handle('notes.read',f.params);
 await f.service.handle('workspace.create',{name:'separate',repositories:['repo']});
 await assert.rejects(f.service.handle('notes.write',{workspaceId:'separate',repoPath:'repo',author:'agent',batch:{requestId:'cross',snapshotId:first.snapshot.id,operations:[{id:'x',expectedRevision:0,action:'upsert',content}]}}),/another workspace/);
 await assert.rejects(f.service.handle('notes.read',{...f.params,paths:['../outside']}),/relative repository path/);
 git(f.repo,'mv','sample.go','renamed.go');writeFileSync(join(f.repo,'binary.dat'),Buffer.from([0,1,2]));writeFileSync(join(f.repo,':(glob)*'),'literal\n');git(f.repo,'add','.');git(f.repo,'commit','-qm','rename and binary');
 const read=await f.service.handle('notes.read',{...f.params,comparison:{fromRef:f.head,toRef:'HEAD'}});
 assert.ok(read.snapshot.files.some((x:any)=>x.path==='renamed.go'&&x.oldPath==='sample.go'));
 assert.ok(read.snapshot.files.some((x:any)=>x.path==='binary.dat'&&x.binary));
 await assert.rejects(f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId:'binary',snapshotId:read.snapshot.id,operations:[{id:'b',expectedRevision:0,action:'upsert',content:{...content,anchors:[{path:'binary.dat',side:'new',start:1,end:1}]}}]}}),/complete text/);
 await f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId:'file-level',snapshotId:read.snapshot.id,operations:[{id:'b',expectedRevision:0,action:'upsert',content:{...content,anchors:[{path:'binary.dat',side:'file'},{path:'renamed.go',side:'file'}]}}]}});
 const replay=await f.service.handle('notes.read',{...f.params,snapshotId:first.snapshot.id});assert.equal(replay.snapshot.right,f.head);
}finally{f.close();}});

test('concurrent revisions have one winner; withdraw preserves history and request retry',async()=>{const f=fixture();try{
 const {snapshot}=await f.service.handle('notes.read',f.params);
 const write=(requestId:string,expectedRevision:number,action='upsert')=>f.service.handle('notes.write',{...f.params,author:'agent',batch:{requestId,snapshotId:snapshot.id,operations:[{id:'one',expectedRevision,action,...(action==='upsert'?{content}:{})}]}});
 const results=await Promise.allSettled([write('a',0),write('b',0)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 await write('withdraw',1,'withdraw');assert.equal((await f.service.handle('notes.read',{...f.params,action:'list'})).notes.length,0);
 assert.equal((await write('withdraw',1,'withdraw')).revisions[0].revision,2);
 await assert.rejects(f.service.handle('notes.feedback',{...f.params,feedback:{requestId:'old-user',id:'one',revision:1,action:'confirm',text:'yes'}}),/changed/);
}finally{f.close();}});
