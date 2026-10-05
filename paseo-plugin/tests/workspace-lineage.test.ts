import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../server/backend/config.ts';
import { Service } from '../server/backend/service.ts';
import { workspaceInstanceKey } from '../shared/workspace-lineage.ts';
import { sourceFromBases } from '../server/backend/workspace-lineage.ts';
import { Git } from '../server/backend/git.ts';
const git = (path:string,...args:string[]) => execFileSync('git',['-C',path,...args],{encoding:'utf8'}).trim();
async function fixture(run: (service:Service,root:string)=>Promise<void>) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-lineage-')));
  for(const name of ['one','two']) { const path=join(root,name);mkdirSync(path);git(path,'init','-q');git(path,'config','user.email','fixture@example.invalid');git(path,'config','user.name','Fixture');writeFileSync(join(path,'README'),'initial\n');git(path,'add','.');git(path,'commit','-qm','initial'); }
  const config=join(root,'project.json');writeFileSync(config,JSON.stringify({schemaVersion:1,project:{id:'fixture'},sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),socketPath:join(root,'s.sock'),repositories:['one','two'].map(id=>({id,path:id})),discovery:{mode:'manual'},management:{enabled:true}}));
  const service=new Service(loadConfig(config));
  try { await run(service,root); } finally { await service.close();rmSync(root,{recursive:true,force:true}); }
}
const sourceKey = (value:any) => workspaceInstanceKey(value);
test('parent defaults pin actual committed HEADs, ignore dirty files and preserve explicit overrides',async()=>fixture(async(service,root)=>{
  const parent=await service.handle('workspace.create',{name:'parent',repositories:['one','two']});
  const path=parent.repositories[0].worktreePath;
  writeFileSync(join(path,'README'),'parent commit\n');git(path,'commit','-qam','parent change');const head=git(path,'rev-parse','HEAD');
  writeFileSync(join(path,'README'),'uncommitted\n');
  const child=await service.handle('workspace.create',{name:'child',parentWorkspaceId:parent.id,baseRefs:{two:'HEAD'}});
  assert.equal(child.repositories.length,2);assert.equal(child.repositories[0].baseSha,head);
  assert.equal(readFileSync(join(child.repositories[0].worktreePath,'README'),'utf8'),'parent commit\n');
  assert.equal(child.lineage.parent.instanceKey,sourceKey(parent));assert.equal(child.lineage.repositories[1].overridden,true);
  assert.equal(child.repositories[1].baseSha,git(join(root,'two'),'rev-parse','HEAD'));
  const ordinary=await service.handle('workspace.create',{name:'ordinary',repositories:['one']});assert.equal(ordinary.lineage.parent,null);
}));
test('retry recovers pinned plans after parent moves and disappears',async()=>fixture(async(service)=>{
  const parent=await service.handle('workspace.create',{name:'parent',repositories:['one','two']});
  const request={name:'child',repositories:['one','two'],baseRefs:Object.fromEntries(parent.repositories.map((repo:any)=>[repo.id,repo.branch])),requestId:'fixed-child'};
  const materialize=service.workspaces.creation.materialize.bind(service.workspaces.creation);let fail=true;
  service.workspaces.creation.materialize=async(plan,w)=>{if(fail && plan.id==='two')throw Error('injected Git failure');return materialize(plan,w);};
  await assert.rejects(service.handle('workspace.create',request));
  const saved=service.workspaces.get('child'),bases=saved.repositories.map((r:any)=>r.baseSha);
  writeFileSync(join(parent.repositories[0].worktreePath,'README'),'later\n');git(parent.repositories[0].worktreePath,'commit','-qam','later');
  renameSync(service.workspaces.records.recordPath(parent.id),service.workspaces.records.recordPath(parent.id)+'.gone');fail=false;
  const child=await service.handle('workspace.create',request);assert.equal(child.state,'active');assert.deepEqual(child.repositories.map((r:any)=>r.baseSha),bases);
  assert.equal(child.lineage.parent.instanceKey,sourceKey(parent));
}));
test('actual base branches automatically identify a unique common parent; mixed and SHA-only sources stay flat',async()=>fixture(async(service)=>{
  const parent=await service.handle('workspace.create',{name:'parent',repositories:['one','two']});
  const refs=Object.fromEntries(parent.repositories.map((repo:any)=>[repo.id,repo.branch]));
  const child=await service.handle('workspace.create',{name:'auto-child',repositories:['one','two'],baseRefs:refs});
  assert.equal(child.lineage.parent.instanceKey,sourceKey(parent));assert.equal(child.lineage.recordedBy,'reference');
  const other=await service.handle('workspace.create',{name:'other',repositories:['one','two']});
  const mixed=await service.handle('workspace.create',{name:'mixed',repositories:['one','two'],baseRefs:{one:parent.repositories[0].branch,two:other.repositories[1].branch}});
  assert.equal(mixed.lineage.parent,null);
  const sha=await service.handle('workspace.create',{name:'sha',repositories:['one'],baseRefs:{one:parent.repositories[0].baseSha}});assert.equal(sha.lineage.parent,null);
  await assert.rejects(service.handle('workspace.create',{name:'stale',parentWorkspaceId:parent.id,parentInstanceKey:'old-instance'}),/replaced/);
}));
test('removing and permanently deleting a parent preserves descendants and old source identity after same-name recreation',async()=>fixture(async(service)=>{
  const parent=await service.handle('workspace.create',{name:'parent',repositories:['one']});const child=await service.handle('workspace.create',{name:'child',parentWorkspaceId:'parent'});
  await service.handle('workspace.remove',{workspaceId:'parent'});
  assert.equal(service.workspaces.get('child').state,'active');
  await service.handle('workspace.delete',{workspaceId:'parent',confirm:true,confirmDataLoss:true});
  const replacement=await service.handle('workspace.create',{name:'parent',repositories:['one'],branchTemplate:'replacement/{workspace}/{repository}'});
  assert.notEqual(sourceKey(replacement),child.lineage.parent.instanceKey);assert.equal(service.workspaces.get('child').lineage.parent.instanceKey,sourceKey(parent));
}));
test('legacy saved branch references group automatically in the roster without Git or record rewrites',async()=>fixture(async(service)=>{
  const parent=await service.handle('workspace.create',{name:'parent',repositories:['one']});
  const child=await service.handle('workspace.create',{name:'legacy-child',repositories:['one'],baseRefs:{one:parent.repositories[0].branch}});
  const {lineage:_lineage,...legacy}=child;
  legacy.repositories=child.repositories.map(({baseBranch:_branch,...repo}:any)=>repo);
  service.workspaces.records.save(legacy);service.workspaces.observationRecords.invalidate();
  const recordPath=service.workspaces.records.recordPath(child.id),before=readFileSync(recordPath,'utf8');
  const run=Git.prototype.run;let calls=0;Git.prototype.run=async function(...args:Parameters<Git['run']>){calls++;return run.apply(this,args);};
  try {
    const list=await service.handle('workspace.list',{includeRemoved:true});const row=list.workspaces.find((w:any)=>w.id===child.id);
    assert.equal(row.lineage.parent.instanceKey,sourceKey(parent));assert.equal(calls,0);assert.equal(readFileSync(recordPath,'utf8'),before);
  } finally {Git.prototype.run=run;}
}));
test('legacy parent records without instance or repositoryIds fields keep their scope and stable identity',async()=>fixture(async(service)=>{
  const original=await service.handle('workspace.create',{name:'legacy',repositories:['one']});
  const {instanceId:_instance,repositoryIds:_scope,...legacy}=original;
  service.workspaces.records.save({...legacy,retainedHistory:{label:'keep'}});
  const child=await service.handle('workspace.create',{name:'child',parentWorkspaceId:'legacy'});
  assert.equal(child.repositories.length,1);assert.equal(child.lineage.parent.instanceKey,sourceKey(legacy));
  const updated=service.workspaces.records.save({...service.workspaces.get('legacy'),description:'metadata update'});
  assert.equal(sourceKey(updated),sourceKey(legacy));assert.deepEqual(updated.retainedHistory,{label:'keep'});
}));

test('reference ownership ignores ambiguous owners and later same-name recreations',()=>{
  const repo={id:'one',sourcePath:'/fixture/one',branch:'obs/source/one'};
  const source={id:'source',state:'active',createdAt:'2026-01-01T00:00:00Z',repositories:[repo]};
  const child={id:'child',createdAt:'2026-01-02T00:00:00Z',repositories:[{...repo,baseRef:repo.branch,baseBranch:'refs/heads/'+repo.branch}]};
  assert.equal(sourceFromBases(child,[source])?.id,'source');
  assert.equal(sourceFromBases(child,[source,{...source,id:'duplicate'}]),null);
  assert.equal(sourceFromBases(child,[{...source,createdAt:'2026-01-03T00:00:00Z'}],true),null);
  assert.equal(sourceFromBases({...child,repositories:[{...child.repositories[0],baseBranch:'refs/tags/'+repo.branch}]},[source]),null);
});
test('Git tag ambiguity cannot masquerade as a parent branch',async()=>fixture(async(service,root)=>{
  const parent=await service.handle('workspace.create',{name:'parent',repositories:['one']});const path=parent.repositories[0].worktreePath;
  writeFileSync(join(path,'README'),'parent advance\n');git(path,'commit','-qam','parent advance');
  git(join(root,'one'),'tag',parent.repositories[0].branch);
  const ambiguous=await service.handle('workspace.create',{name:'ambiguous',repositories:['one'],baseRefs:{one:parent.repositories[0].branch}});
  assert.equal(ambiguous.lineage.parent,null);
  const qualified=await service.handle('workspace.create',{name:'qualified',repositories:['one'],baseRefs:{one:'refs/heads/'+parent.repositories[0].branch}});
  assert.equal(qualified.lineage.parent.instanceKey,sourceKey(parent));
}));
test('optional roster lookup failure does not block Workspace creation',async()=>fixture(async(service)=>{
  const parent=await service.handle('workspace.create',{name:'parent',repositories:['one']});
  const roster=service.workspaces.directory.roster;service.workspaces.directory.roster=async()=>{throw Error('injected metadata lookup outage');};
  try {
    const derived=await service.handle('workspace.create',{name:'automatic',repositories:['one'],baseRefs:{one:parent.repositories[0].branch}});
    assert.equal(derived.state,'active');assert.equal(derived.lineage.parent,null);
    const explicit=await service.handle('workspace.create',{name:'explicit',parentWorkspaceId:'parent'});
    assert.equal(explicit.state,'active');assert.equal(explicit.lineage.parent.instanceKey,sourceKey(parent));
  } finally {service.workspaces.directory.roster=roster;}
}));

test('creator is fixed at first creation and survives another session retrying or restoring',async()=>fixture(async(service)=>{
 const creator={agentId:'session-a',name:'Original session',recordedAt:'2026-01-01T00:00:00Z'};
 const request={name:'owned',repositories:['one'],requestId:'create-owned'};
 const initial=await service.handle('workspace.create',{...request,creator});
 const retry=await service.handle('workspace.create',{...request,creator:{...creator,agentId:'session-b'}});
 assert.deepEqual(retry.creator,creator);assert.equal(retry.instanceId,initial.instanceId);
 await service.handle('workspace.remove',{workspaceId:initial.id});
 const restored=await service.handle('workspace.restore',{workspaceId:initial.id});assert.equal(restored.restored,true);assert.deepEqual(service.workspaces.get(initial.id).creator,creator);
 const plain=await service.handle('workspace.create',{name:'unattributed',repositories:['two']});assert.equal(plain.creator,undefined);
 const listing=await service.handle('workspace.list',{includeRemoved:true});assert.deepEqual(listing.workspaces.find((w:any)=>w.id==='owned').creator,creator);
}));
