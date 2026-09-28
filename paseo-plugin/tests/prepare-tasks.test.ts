import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Service} from '../server/backend/service.ts';
import {loadConfig} from '../server/backend/config.ts';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-prepare-task-'))),repo=join(root,'one');mkdirSync(repo);
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args]);git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');writeFileSync(join(repo,'file'),'content');git('add','.');git('commit','-qm','initial');
 const path=join(root,'config.json');writeFileSync(path,JSON.stringify({schemaVersion:1,project:{id:'prepare'},sourceRoot:root,workspaceRoot:join(root,'workspaces'),stateRoot:join(root,'state'),repositories:[{id:'one',path:'one'}],management:{enabled:true},discovery:{mode:'manual'},toolchain:{mode:'system',repositories:{}}}));return{root,config:loadConfig(path)};
}
test('persistent preparation deduplicates, protects its workspace and retains unrelated caches',async()=>{
 const f=fixture();let service=new Service(f.config);
 try{
  const workspace=await service.handle('workspace.create',{name:'test',repositories:['one']});
  service.cache.publish('unrelated','token',{value:1});
  const request={action:'start',workspaceId:workspace.id,repositories:['one'],requestId:'request-one'};
  const first=await service.handle('workspace.prepare.task',request);
  assert.ok(['queued','running'].includes(first.state));assert.equal(first.config,undefined);
  assert.throws(()=>service.workspaces.assertIdle(workspace.id),/preparation is active/);
  const second=await service.handle('workspace.prepare.task',request);assert.equal(first.operationId,second.operationId);
  let status=second;
  for(let i=0;i<100 && ['queued','running'].includes(status.state);i++){await sleep(20);status=await service.handle('workspace.prepare.task',{action:'status',operationId:first.operationId});}
  assert.equal(status.state,'ready',JSON.stringify(status));assert.equal(status.repositories[0].state,'ready');
  assert.equal(service.cache.retained('unrelated')?.value,1);
  await service.close();service=new Service(f.config);
  const restored=await service.handle('workspace.prepare.task',request);assert.equal(restored.operationId,first.operationId);assert.equal(restored.state,'ready');
  await assert.rejects(service.handle('workspace.prepare.task',{...request,workspaceId:'other'}),/another workspace/);
 }finally{await service.close();rmSync(f.root,{recursive:true,force:true});}
});

test('failed durable registration never dispatches preparation',async()=>{
 const f=fixture(),service=new Service(f.config);
 try{
  const workspace=await service.handle('workspace.create',{name:'test',repositories:['one']});
  writeFileSync(join(f.config.stateRoot,'prepare-operations'),'not a directory');
  await assert.rejects(service.handle('workspace.prepare.task',{action:'start',workspaceId:workspace.id,repositories:['one'],requestId:'cannot-save'}));
  assert.equal(service.preparations.active(workspace.id),false);
 }finally{await service.close();rmSync(f.root,{recursive:true,force:true});}
});

test('restarting reconciles an uncertain completed operation without replaying it',async()=>{
 const f=fixture();let service=new Service(f.config);
 try {
  const workspace=await service.handle('workspace.create',{name:'recovery',repositories:['one']});
  let task=await service.handle('workspace.prepare.task',{action:'start',workspaceId:workspace.id,repositories:['one'],requestId:'recover-me'});
  for(let n=0;n<100 && ['queued','running'].includes(task.state);n++){await sleep(20);task=await service.handle('workspace.prepare.task',{action:'status',operationId:task.operationId});}
  assert.equal(task.state,'ready');await service.close();
  const {readFileSync}=await import('node:fs');const path=join(f.config.stateRoot,'prepare-operations',`${task.operationId}.json`);
  const saved=JSON.parse(readFileSync(path,'utf8'));saved.state='running';saved.repositories[0].state='running';writeFileSync(path,JSON.stringify(saved));
  service=new Service(f.config);const recovered=await service.handle('workspace.prepare.task',{action:'status',operationId:task.operationId});
  assert.equal(recovered.state,'ready');assert.equal(recovered.phase,'reconciled');assert.equal(service.preparations.active(workspace.id),false);
 }finally{await service.close();rmSync(f.root,{recursive:true,force:true});}
});

test('workspace progress after restart selects the newest operation rather than UUID file order',async()=>{
 const f=fixture(),service=new Service(f.config);
 try {
  const root=join(f.config.stateRoot,'prepare-operations');mkdirSync(root,{recursive:true});
  for(const [operationId,time] of [['ffffffff-ffff-ffff-ffff-ffffffffffff',1],['00000000-0000-0000-0000-000000000000',2]] as const)writeFileSync(join(root,`${operationId}.json`),JSON.stringify({operationId,workspaceId:'w',state:'ready',phase:'ready',requestIds:[operationId],repositories:[],acceptedAt:time,updatedAt:time}));
  const status=await service.handle('workspace.prepare.task',{action:'status',workspaceId:'w'});assert.equal(status.operationId,'00000000-0000-0000-0000-000000000000');
 }finally{await service.close();rmSync(f.root,{recursive:true,force:true});}
});
