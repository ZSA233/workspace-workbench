import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createDiffPerformanceFixture,percentile95} from './diff-performance-fixture.mjs';
import {Service} from '../server/backend/service.ts';
import {loadConfig} from '../server/backend/config.ts';
const root=await mkdtemp(join(tmpdir(),'comparison-performance-')),repo=join(root,'repo');await mkdir(repo);
const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
git('init','-q','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');
let service;
try{
 const sample=await createDiffPerformanceFixture(repo),base=git('rev-parse','HEAD');git('add','diff-performance');git('commit','-qm','500 modifications');const head=git('rev-parse','HEAD');
 const config=join(root,'project.json');await writeFile(config,JSON.stringify({schemaVersion:1,project:{id:'sample'},sourceRoot:root,workspaceRoot:join(root,'workspaces'),stateRoot:join(root,'state'),repositories:[{id:'repo',path:'repo'}],discovery:{mode:'manual'}}));
 service=new Service(loadConfig(config));const cold=[],warm=[],diff=[];
 const params={workspaceId:'main',repoPath:'repo',comparison:{fromRef:base,toRef:head}};
 for(let i=0;i<20;i++){
  service.cache.invalidateWorkspace('main');let at=performance.now();const files=await service.handle('repository.compare',params);cold.push(performance.now()-at);assert.equal(files.files.length,500);
  at=performance.now();await service.handle('repository.compare',params);warm.push(performance.now()-at);
  at=performance.now();const result=await service.handle('repository.diff',{workspaceId:'main',repoPath:'repo',scope:'compare',comparison:files.comparison,path:files.files[i].path});diff.push(performance.now()-at);assert.match(result.patch,/\+changed/);
 }
 const report={kind:'isolated-real-git-service-not-ui',sample,samples:20,appCacheColdNames:{p95:percentile95(cold),max:Math.max(...cold)},appCacheWarmNames:{p95:percentile95(warm),max:Math.max(...warm)},firstDiff:{p95:percentile95(diff),max:Math.max(...diff)}};
 console.log(JSON.stringify(report,null,2));assert.ok(percentile95(cold)<=5000);assert.ok(percentile95(diff)<=3000);
}finally{service?.observation.close();await rm(root,{recursive:true,force:true});}
