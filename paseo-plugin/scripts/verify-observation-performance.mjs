/** Reproducible comparison against the committed implementation, isolated Git fixtures. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const plugin=resolve(import.meta.dirname,'..'), repository=resolve(plugin,'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const git=(cwd,args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
if(process.argv[2]==='--sample') {
  const directory=process.argv[3],events=process.argv[4]==='events';
  const {Service}=await import(pathToFileURL(join(directory,'server/backend/service.ts')));
  const {loadConfig}=await import(pathToFileURL(join(directory,'server/backend/config.ts')));
  const {Git}=await import(pathToFileURL(join(directory,'server/backend/git.ts')));
  const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-perf-fixture-')));
  for(const id of ['one','two','three']) {
    const path=join(root,id);mkdirSync(path);git(path,['init','-q']);git(path,['config','user.name','Test']);git(path,['config','user.email','test@example.invalid']);
    writeFileSync(join(path,'file'),'initial\n');git(path,['add','.']);git(path,['commit','-qm','initial']);
  }
  const config=join(root,'project.json');
  writeFileSync(config,JSON.stringify({schemaVersion:1,project:{id:'performance'},sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),repositories:['one','two','three'].map(id=>({id,path:id})),discovery:{mode:'manual'},limits:{cacheTtlSeconds:.5},management:{enabled:true}}));
  const service=new Service(loadConfig(config));let commands=0;
  const run=Git.prototype.run;Git.prototype.run=async function(...args){commands++;return run.apply(this,args);};
  try {
    const list=await service.handle('workspace.list',{}), workspaceId=list.workspaces[0].id;
    const params={workspaceId};await service.handle('workspace.detail',params);await delay(400);
    const before=commands;
    for(let n=0;n<10;n++){await delay(650);await service.handle('workspace.detail',params);await delay(100);}
    await delay(200);const quietGitCommands=commands-before;
    const latencies=[];
    if(events)for(let n=0;n<20;n++){
      const name=`sample-${n}`;const start=Date.now();writeFileSync(join(root,'one',name),'test\n');
      let found=false;
      for(let tries=0;tries<5;tries++){
        await delay(1_000);await service.handle('observer.versions',{workspaceIds:[workspaceId]});
        const d=await service.handle('workspace.detail',params);
        if(d.repositories.some(r=>r.dirtyPaths.includes(name))){found=true;latencies.push(Date.now()-start);break;}
      }
      assert.ok(found,'file mutation did not reach the snapshot');
    }
    latencies.sort((a,b)=>a-b);
    process.stdout.write(JSON.stringify({quietGitCommands,latenciesMs:latencies,p95Ms:latencies.length?latencies[Math.ceil(latencies.length*.95)-1]:null}));
  } finally {await service.close();rmSync(root,{recursive:true,force:true});}
} else {
  const base=realpathSync(mkdtempSync(join(tmpdir(),'wb-perf-baseline-')));
  try {
    const archive=execFileSync('git',['-C',repository,'archive','--format=tar',process.env.WORKBENCH_BASELINE_REF||'HEAD','paseo-plugin'],{maxBuffer:32*1024*1024});
    const tar=join(base,'baseline.tar');writeFileSync(tar,archive);execFileSync('tar',['-xf',tar,'-C',base]);
    symlinkSync(join(plugin,'node_modules'),join(base,'paseo-plugin/node_modules'),'dir');
    const sample=(path,events)=>JSON.parse(execFileSync(process.execPath,['--experimental-strip-types',fileURLToPath(import.meta.url),'--sample',path,events?'events':'quiet'],{encoding:'utf8',timeout:90_000,stdio:['ignore','pipe','inherit']}));
    const before=sample(join(base,'paseo-plugin'),false),after=sample(plugin,true);
    const reduction=1-after.quietGitCommands/before.quietGitCommands;
    assert.ok(reduction>=.9);assert.ok(after.p95Ms<=3000);
    const report={kind:'isolated-git-observation',baseline:git(repository,['rev-parse',process.env.WORKBENCH_BASELINE_REF||'HEAD']),repositories:3,quietPolls:10,before,after,reduction,ok:true};
    const output=join(repository,'.local/verification');mkdirSync(output,{recursive:true});writeFileSync(join(output,'observation-performance.json'),JSON.stringify(report,null,2)+'\n');
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
  } finally {rmSync(base,{recursive:true,force:true});}
}
