import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ObservationScheduler } from '../server/backend/observation-scheduler.ts';
import { Service } from '../server/backend/service.ts';
import { loadConfig } from '../server/backend/config.ts';
import { Git } from '../server/backend/git.ts';
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const git = (p: string, args: string[]) => execFileSync('git', ['-C', p, ...args], { encoding: 'utf8' }).trim();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-events-'))), repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, ['init','-q']); git(repo,['config','user.name','Test']); git(repo,['config','user.email','test@example.invalid']);
  writeFileSync(join(repo,'file'),'initial\n'); git(repo,['add','.']); git(repo,['commit','-qm','initial']);
  const config = join(root,'project.json');
  writeFileSync(config, JSON.stringify({ schemaVersion:1, project:{id:'events'}, sourceRoot:root, stateRoot:join(root,'state'), workspaceRoot:join(root,'workspaces'), repositories:[{id:'repo',path:'repo'}], discovery:{mode:'manual'}, management:{enabled:true} }));
  return {root,repo,config};
}
async function until(fn:()=>boolean|Promise<boolean>, ms=3000) { const end=Date.now()+ms; while(Date.now()<end) { if(await fn()) return; await delay(40); } assert.fail('condition did not converge within budget'); }
test('native events observe edits, atomic save, untracked files and shared worktree refs', async()=>{
  const f=fixture(), scheduler=new ObservationScheduler();
  try {
    await scheduler.register('w',f.repo);
    assert.deepEqual(scheduler.health().issues,[]);
    for(const change of [()=>writeFileSync(join(f.repo,'file'),'edit\n'),()=>{writeFileSync(join(f.repo,'tmp'),'atomic\n');renameSync(join(f.repo,'tmp'),join(f.repo,'file'));},()=>writeFileSync(join(f.repo,'new'),'new'),()=>rmSync(join(f.repo,'new'))]) {
      const previous=scheduler.token(f.repo); change(); await until(()=>scheduler.token(f.repo)!==previous);
    }
    const linked=join(f.root,'linked'); git(f.repo,['worktree','add','-qb','linked',linked]); await scheduler.register('linked',linked);
    const previous=scheduler.token(linked,'refs'); git(f.repo,['branch','other']); await until(()=>scheduler.token(linked,'refs')!==previous);
    assert.ok(scheduler.health().watchedDirectories<=4,'shared git directory must not have duplicate subscriptions');
  } finally {await scheduler.close();rmSync(f.root,{recursive:true,force:true});}
});
test('exact root validation rejects containers inside an outer repository',async()=>{
  const f=fixture(), scheduler=new ObservationScheduler();
  try {const nested=join(f.repo,'container');mkdirSync(nested);await scheduler.register('nested',nested);assert.deepEqual(scheduler.health().issues,['repository_root_mismatch']);}
  finally {await scheduler.close();rmSync(f.root,{recursive:true,force:true});}
});
test('missing repository is classified separately and does not hide healthy repositories',async()=>{
  const f=fixture(), scheduler=new ObservationScheduler({degradedMs:60});
  try {
    await Promise.all([scheduler.register('w',f.repo),scheduler.register('w',join(f.root,'missing'))]);
    const versions=scheduler.versions(['w']);
    assert.equal(versions.repositories.find(item=>item.path===f.repo)?.issue,null);
    assert.equal(versions.repositories.find(item=>item.path===join(f.root,'missing'))?.issue,'repository_missing');
  } finally {await scheduler.close();rmSync(f.root,{recursive:true,force:true});}
});
test('late watcher subscription is reclaimed after timeout and never revived',async()=>{
  const f=fixture();let released=0;
  const scheduler=new ObservationScheduler({subscribeMs:10, subscribe:async()=>{await delay(60);return {unsubscribe:async()=>{released++;}};}});
  try {await scheduler.register('w',f.repo);assert.deepEqual(scheduler.health().issues,['watcher_subscribe_timeout']);await delay(90);assert.equal(released,1);}
  finally {await scheduler.close();rmSync(f.root,{recursive:true,force:true});}
});
test('warm version polling and repeated summary reads launch no Git; edits converge under 3 seconds',async()=>{
  const f=fixture(),service=new Service(loadConfig(f.config)); const original=Git.prototype.run; let commands=0;
  Git.prototype.run=async function(...args){commands++;return original.apply(this,args);};
  try {
    const list=await service.handle('workspace.list',{}); const workspaceId=list.workspaces[0].id;
    await service.handle('workspace.detail',{workspaceId}); await delay(500);
    const before=commands;
    for(let i=0;i<100;i++) await service.handle('observer.versions',{workspaceIds:[workspaceId]});
    for(let i=0;i<10;i++) await service.handle('workspace.detail',{workspaceId});
    assert.equal(commands-before,0);
    const start=Date.now();writeFileSync(join(f.repo,'file'),'changed\n');
    await until(async()=>{const d=await service.handle('workspace.detail',{workspaceId});return d.repositories[0].dirty;});
    assert.ok(Date.now()-start<3000); const d=await service.handle('workspace.detail',{workspaceId});
    assert.equal(d.repositories[0].workingChanges,null);assert.equal(d.repositories[0].changesLoaded,false);
  } finally {Git.prototype.run=original;await service.close();rmSync(f.root,{recursive:true,force:true});}
});
test('inactive repositories stop reconciliation; reopening invalidates snapshots',async()=>{
  const f=fixture();let refreshed=0;const scheduler=new ObservationScheduler({leaseMs:60,reconcileMs:80});
  try {await scheduler.register('w',f.repo,async()=>{refreshed++;});await delay(1200);assert.equal(refreshed,0);const token=scheduler.token(f.repo);scheduler.versions(['w']);assert.notEqual(scheduler.token(f.repo),token);}
  finally {await scheduler.close();rmSync(f.root,{recursive:true,force:true});}
});

test('tracked files inside previously ignored directories stay observable after force-add',async()=>{
  const f=fixture(), scheduler=new ObservationScheduler();
  try {
    writeFileSync(join(f.repo,'.gitignore'),'ignored/\n');mkdirSync(join(f.repo,'ignored'));writeFileSync(join(f.repo,'ignored','file'),'a');
    await scheduler.register('w',f.repo);
    git(f.repo,['add','-f','ignored/file']);
    await delay(1800); // watcher reconfiguration runs on the bounded recovery tick
    const token=scheduler.token(f.repo);writeFileSync(join(f.repo,'ignored','file'),'tracked edit');await until(()=>scheduler.token(f.repo)!==token);
  } finally {await scheduler.close();rmSync(f.root,{recursive:true,force:true});}
});
test('event storms coalesce and background work stops after the lease expires',async()=>{
  const f=fixture();let refreshed=0; const scheduler=new ObservationScheduler({leaseMs:2000,debounceMs:100,maxWaitMs:300});
  try {
    await scheduler.register('w',f.repo,async()=>{refreshed++;await delay(30);});
    for(let i=0;i<50;i++)writeFileSync(join(f.repo,'file'),String(i));
    await until(()=>refreshed>0);await delay(400);assert.ok(refreshed<=3);
    await delay(2200);const before=refreshed;writeFileSync(join(f.repo,'file'),'inactive');await delay(400);assert.equal(refreshed,before);
    assert.equal(scheduler.health().watchedDirectories,0);
  }finally{await scheduler.close();rmSync(f.root,{recursive:true,force:true});}
});
test('watcher failure reports degraded state then recovers without blocking snapshots',async()=>{
  const f=fixture();let attempts=0;
  const scheduler=new ObservationScheduler({subscribe:async()=>{attempts++;if(attempts===1)throw Error('injected');return {unsubscribe:async()=>{}};}});
  try {await scheduler.register('w',f.repo);assert.ok(scheduler.health().issues.includes('watcher_unavailable'));await until(()=>!scheduler.health().issues.length,7000);assert.ok(attempts>1);}
  finally{await scheduler.close();rmSync(f.root,{recursive:true,force:true});}
});
