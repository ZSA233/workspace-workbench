import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../server/backend/config.ts';
import {Workspaces} from '../server/backend/workspaces.ts';

function fixture(){
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'wb-roster-metadata-')));
 const path=join(root,'project.json');
 fs.writeFileSync(path,JSON.stringify({schemaVersion:1,sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),repositories:[{id:'one',path:'one'}],discovery:{mode:'manual'}}));
 const workspaces=new Workspaces(loadConfig(path));
 const tree=join(workspaces.config.treesRoot,'saved');
 fs.mkdirSync(join(root,'one'),{recursive:true});fs.mkdirSync(join(tree,'one'),{recursive:true});
 const record={schemaVersion:1,id:'saved',displayName:'Saved workspace',treePath:tree,sourceRoot:root,kind:'managed',managed:true,state:'active',repositories:[{id:'one',repoPath:'one',sourcePath:join(root,'one'),worktreePath:join(tree,'one'),branch:'saved'}],history:{unknown:'preserved'}};
 fs.writeFileSync(workspaces.records.recordPath('saved'),JSON.stringify(record));
 return {root,tree,workspaces};
}

test('roster has no synchronous filesystem or worktree traversal dependency',async()=>{
 const f=fixture();
 const methods=['readFileSync','readdirSync','realpathSync','existsSync','lstatSync'] as const;
 const saved=new Map(methods.map(name=>[name,fs[name]]));
 let calls=0;
 try{
  for(const name of methods)(fs as any)[name]=()=>{calls++;throw Error('Synchronous filesystem access on roster path');};
  syncBuiltinESMExports();
  const rows=await f.workspaces.roster();
  assert.equal(rows.length,2);assert.equal(rows.find(w=>w.id==='saved')?.history.unknown,'preserved');
  assert.equal(calls,0);
 }finally{
  for(const [name,value] of saved)(fs as any)[name]=value;
  syncBuiltinESMExports();await f.workspaces.observationRecords.close();fs.rmSync(f.root,{recursive:true,force:true});
 }
});

test('displayed records do not authorize symlink escapes or weaken fresh operation reads',async()=>{
 const f=fixture(),outside=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'wb-roster-outside-')));
 try{
  fs.rmSync(join(f.tree,'one'),{recursive:true});fs.symlinkSync(outside,join(f.tree,'one'),'dir');
  const rows=await f.workspaces.roster();
  assert.equal(rows.find(w=>w.id==='saved')?.displayName,'Saved workspace');
  assert.throws(()=>f.workspaces.get('saved'),(e:any)=>e.code==='record_invalid');
  const raw=JSON.parse(fs.readFileSync(f.workspaces.records.recordPath('saved'),'utf8'));
  raw.treePath=outside;fs.writeFileSync(f.workspaces.records.recordPath('saved'),JSON.stringify(raw));
  assert.equal((await f.workspaces.roster()).find(w=>w.id==='saved')?.state,'record_invalid');
 }finally{await f.workspaces.observationRecords.close();fs.rmSync(f.root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
});

test('workspace list does not inspect runtimes or perform synchronous path checks after worker publication',async()=>{
 const {Service}=await import('../server/backend/service.ts');
 const f=fixture(),service=new Service(f.workspaces.config);
 const rows=await f.workspaces.roster();
 service.workspaces.observationRecords.request=async()=>({workspaces:rows,orphanScan:{state:'ready',candidates:[],scannedDirectories:0},discovered:{state:'ready',repositories:[],incomplete:false,scannedDirectories:0}});
 const methods=['readFileSync','readdirSync','realpathSync','existsSync','lstatSync'] as const;
 const saved=new Map(methods.map(name=>[name,fs[name]]));let calls=0;
 try{
  for(const name of methods)(fs as any)[name]=()=>{calls++;throw Error('List performed synchronous I/O');};syncBuiltinESMExports();
  const result=await service.handle('workspace.list');
  assert.equal(result.workspaces.length,2);assert.equal(calls,0);
  assert.equal(result.workspaces.find((w:any)=>w.id==='saved').toolchain,undefined);
 }finally{for(const [name,value] of saved)(fs as any)[name]=value;syncBuiltinESMExports();await service.close();await f.workspaces.observationRecords.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test('in-root configured aliases retain display identity while operation validation stays physical',async()=>{
 const f=fixture();
 try{
  fs.symlinkSync(join(f.root,'one'),join(f.root,'alias'),'dir');
  f.workspaces.config.repositories[0].path='alias';
  const path=f.workspaces.records.recordPath('saved'),record=JSON.parse(fs.readFileSync(path,'utf8'));
  record.repositories[0].repoPath='alias';fs.writeFileSync(path,JSON.stringify(record));
  assert.equal(f.workspaces.get('saved').id,'saved');
  assert.equal((await f.workspaces.roster()).find(w=>w.id==='saved')?.state,'active');
 }finally{await f.workspaces.observationRecords.close();fs.rmSync(f.root,{recursive:true,force:true});}
});
