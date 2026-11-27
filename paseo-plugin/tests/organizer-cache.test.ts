import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import{execFileSync}from'node:child_process';
import {Service} from '../server/backend/service.ts';
import {loadConfig} from '../server/backend/config.ts';
import {Git} from '../server/backend/git.ts';
const pause=(ms=30)=>new Promise(r=>setTimeout(r,ms));
async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-organizer-cache-'))),source=join(root,'repo');mkdirSync(source);
 const git=(path:string,...args:string[])=>execFileSync('git',['-C',path,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 git(source,'init','-qb','main');git(source,'config','user.name','Fixture');git(source,'config','user.email','test@example.invalid');writeFileSync(join(source,'file'),'before\n');git(source,'add','.');git(source,'commit','-qm','base');const base=git(source,'rev-parse','HEAD');git(source,'update-ref','refs/remotes/origin/main',base);
 const config=join(root,'project.json');writeFileSync(config,JSON.stringify({schemaVersion:1,project:{id:'cache'},sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),repositories:[{id:'repo',path:'repo'}],discovery:{mode:'manual'},management:{enabled:true}}));
 const service=new Service(loadConfig(config)),created=await service.handle('workspace.create',{name:'task',repositories:['repo']}),path=join(created.treePath,'repo');writeFileSync(join(path,'file'),'after\n');git(path,'add','.');git(path,'commit','-qm','fix: update requirement');
 const versions=()=>service.handle('organizer.versions',{workspaceIds:['task']}),read=(signal?:AbortSignal)=>service.handle('organizer.materials',{workspaceId:'task'},signal);await versions();
 const until=async(predicate:()=>Promise<boolean>)=>{for(let i=0;i<150;i++){if(await predicate())return;await pause();}assert.fail('source version did not settle');};
 return{root,path,service,git,versions,read,until,close:async()=>{await service.close();rmSync(root,{recursive:true,force:true});}};
}
test('Git page status and concurrent organizer checks share producers, and warm coverage launches no Git',async()=>{
 const f=await fixture(),original=Git.prototype.run;const calls:string[][]=[];Git.prototype.run=async function(...args){calls.push(args[0]);return original.apply(this,args);};
 try{
  const context=await f.service.workspaces.observationRecords.request('context',{workspaceId:'task',repository:'repo'});
  await f.service.observation.refresh.sourceGit(context,Date.now()+10000).status();calls.length=0;
  const [a,b]=await Promise.all([f.read(),f.read()]);assert.equal(a.fingerprint,b.fingerprint);assert.equal(calls.filter(args=>args[0]==='log').length,1);assert.equal(calls.filter(args=>args[0]==='status').length,0);
  const count=calls.length;for(let i=0;i<5;i++){await f.versions();await f.read();}assert.equal(calls.length,count);
 }finally{Git.prototype.run=original;await f.close();}
});
test('worktree edits and production ref changes invalidate the shared source generation',async()=>{
 const f=await fixture();try{
  const first=await f.versions();assert.ok(first.materialTokens.task);await f.read();writeFileSync(join(f.path,'file'),'new working change\n');await f.until(async()=>{const v=await f.versions();return !!v.materialTokens.task&&v.materialTokens.task!==first.materialTokens.task;});
  const dirty=await f.read();assert.equal(dirty.repositories[0].dirty,true);assert.notEqual(dirty.state,'deployed');const second=await f.versions();f.git(f.path,'update-ref','refs/remotes/origin/main','HEAD');await f.until(async()=>{const v=await f.versions();return !!v.materialTokens.task&&v.materialTokens.task!==second.materialTokens.task;});
  assert.ok((await f.read()).repositories[0].covered>0);
 }finally{await f.close();}
});
test('cancelling one material consumer leaves the shared Git producer available for another',async()=>{
 const f=await fixture(),original=Git.prototype.run;let logs=0,release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),running=new Promise<void>(r=>started=r);
 Git.prototype.run=async function(...args){if(args[0][0]==='log'){logs++;started();await gate;}return original.apply(this,args);};
 try{
  const abort=new AbortController(),first=f.read(abort.signal);await running;const second=f.read();await pause(40);abort.abort();await assert.rejects(first,/cancelled/);release();assert.equal((await second).repositories.length,1);assert.equal(logs,1);
 }finally{release();Git.prototype.run=original;await f.close();}
});

test('confirmed Git facts share status and committed materials ignore edits and incoming merges',async()=>{
 const f=await fixture(),original=Git.prototype.run,calls:string[][]=[];Git.prototype.run=async function(...args){calls.push(args[0]);return original.apply(this,args);};
 try{
  const facts=()=>f.service.handle('organizer.versions',{workspaceIds:['task'],factsOnly:true}),read=()=>f.service.handle('organizer.materials',{workspaceId:'task',committedOnly:true});
  const first=await facts();assert.equal(first.facts.task.ready,true);const initial=await read();assert.ok(initial.committedFingerprint);const count=calls.length;
  for(let i=0;i<4;i++)assert.equal((await facts()).facts.task.commitKey,first.facts.task.commitKey);assert.equal(calls.length,count,'fact reads must reuse the original status and resolve loose refs without new Git commands');
  writeFileSync(join(f.path,'file'),'uncommitted\n');await f.until(async()=>{const v=await f.versions();return !!v.materialTokens.task&&v.materialTokens.task!==initial.sourceVersion;});const edited=await read();assert.equal(edited.committedFingerprint,initial.committedFingerprint);assert.ok(!edited.evidence.some((e:any)=>e.text.includes('uncommitted')));
  f.git(f.path,'add','.');f.git(f.path,'commit','-qm','fix: commit actual requirement');const committed=await read();assert.notEqual(committed.committedFingerprint,initial.committedFingerprint);
  const source=join(f.root,'repo');writeFileSync(join(source,'upstream'),'incoming unrelated code\n');f.git(source,'add','.');f.git(source,'commit','-qm','upstream change');f.git(f.path,'merge','--no-ff','main','-m','Merge main');
  // Force only the existing observation validation, as normal Git events do.
  f.service.observation.scheduler.force('task');const merged=await read();assert.equal(merged.committedFingerprint,committed.committedFingerprint);assert.ok(!merged.evidence.some((e:any)=>e.text==='upstream change'));
 }finally{Git.prototype.run=original;await f.close();}
});
