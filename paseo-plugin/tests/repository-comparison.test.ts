import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Git} from '../server/backend/git.ts';
import {resolveComparison,fetchComparisonRef,remoteFetchState} from '../server/backend/repository-comparison.ts';
import {Service} from '../server/backend/service.ts';
import {loadConfig} from '../server/backend/config.ts';
const command=(root:string,...args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-comparison-'))),repo=join(root,'repo');mkdirSync(repo);
 command(repo,'init','-q','-b','main');command(repo,'config','user.name','Test');command(repo,'config','user.email','test@example.invalid');
 const commit=(name:string,text:string)=>{writeFileSync(join(repo,name),text);command(repo,'add','.');command(repo,'commit','-qm',text);return command(repo,'rev-parse','HEAD');};
 const base=commit('file','base\n');command(repo,'checkout','-qb','feature');const target=commit('file','feature\n');command(repo,'checkout','-q','main');const production=commit('production','production\n');command(repo,'checkout','-q','feature');
 const config=join(root,'config.json');writeFileSync(config,JSON.stringify({schemaVersion:1,project:{id:'sample'},sourceRoot:root,workspaceRoot:join(root,'workspaces'),stateRoot:join(root,'state'),repositories:[{id:'repo',path:'repo'}],discovery:{mode:'manual'},management:{enabled:true}}));
 return {root,repo,base,target,production,commit,config};
}
test('endpoint and contribution comparisons freeze distinct bases; names, counts and patch agree',async()=>{
 const f=fixture(),service=new Service(loadConfig(f.config));
 try{
 const git=new Git(f.repo,10000);
 const endpoints=await resolveComparison(git,{fromRef:'main',toRef:'feature'}),contribution=await resolveComparison(git,{fromRef:'main',toRef:'feature',mode:'contribution'});
 assert.equal(endpoints.leftSha,f.production);assert.equal(contribution.leftSha,f.base);
 const params={workspaceId:'main',repoPath:'repo',comparison:{fromRef:'main',toRef:'feature'}};
 const files=await service.handle('repository.compare',params);
 assert.deepEqual(files.files.map((v:any)=>v.path).sort(),['file','production']);
 const counts=await service.handle('repository.compare',{...params,action:'counts'});assert.equal(counts.fromOnly,1);assert.equal(counts.toOnly,1);
 const commits=await service.handle('repository.compare',{...params,action:'commits',side:'to'});assert.equal(commits.commits[0].sha,f.target);
 const before=await service.observation.diffContent.read({workspaceId:'main',repoPath:'repo',path:'file',scope:'compare',comparison:endpoints},Date.now()+15000);
 f.commit('file','later\n');
 const after=await service.observation.diffContent.read({workspaceId:'main',repoPath:'repo',path:'file',scope:'compare',comparison:endpoints},Date.now()+15000);
 assert.equal(before.patch,after.patch);assert.match(after.patch,/\+feature/);assert.ok(after.observation.immutableIdentity);
 const same=await git.files('compare',f.target,f.target);assert.equal(same.length,0);
 }finally{service.observation.close();rmSync(f.root,{recursive:true,force:true});}
});
test('unrelated histories reject contribution comparison but allow endpoint comparison',async()=>{
 const f=fixture();try{command(f.repo,'checkout','--orphan','other');command(f.repo,'rm','-rf','.');f.commit('other','unrelated');const git=new Git(f.repo,10000);
 await assert.rejects(resolveComparison(git,{fromRef:f.target,toRef:'other',mode:'contribution'}),(e:any)=>e.code==='comparison_unrelated');
 assert.equal((await resolveComparison(git,{fromRef:f.target,toRef:'other'})).leftSha,f.target);
 await assert.rejects(resolveComparison(git,{fromRef:'--help',toRef:'HEAD'}));
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('multiple merge bases are never silently selected',async()=>{
 const f=fixture();try{const git=new Git(f.repo,10000),tree=command(f.repo,'rev-parse',`${f.base}^{tree}`);
 const a=command(f.repo,'commit-tree',tree,'-p',f.base,'-m','a'),b=command(f.repo,'commit-tree',tree,'-p',f.base,'-m','b');
 const x=command(f.repo,'commit-tree',tree,'-p',a,'-p',b,'-m','x'),y=command(f.repo,'commit-tree',tree,'-p',b,'-p',a,'-m','y');
 await assert.rejects(resolveComparison(git,{fromRef:x,toRef:y,mode:'contribution'}),(e:any)=>e.code==='comparison_multiple_bases');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('explicit fetch only updates selected tracking ref and deduplicates request identity',async()=>{
 const f=fixture(),remote=join(f.root,'remote');command(f.root,'clone','-q','--bare',f.repo,remote);command(f.repo,'remote','add','origin',remote);command(f.repo,'fetch','-q','origin');
 const service=new Service(loadConfig(f.config));try{
 const before=command(f.repo,'rev-parse','HEAD');const input={workspaceId:'main',repoPath:'repo',ref:'origin/main',requestId:'fetch-once'};
 const accepted=await fetchComparisonRef(service.observation,input);assert.equal(accepted.state,'running');
 await service.workspaces.mutations.run(async()=>{});
 assert.equal(remoteFetchState(service.observation,f.repo).state,'ready');assert.equal(command(f.repo,'rev-parse','HEAD'),before);
 assert.equal((await fetchComparisonRef(service.observation,input)).state,'ready');
 }finally{service.observation.close();rmSync(f.root,{recursive:true,force:true});}
});
test('comparison rename, literal path, binary and deletion preserve normal diff semantics',async()=>{
 const f=fixture();try{
 const base=command(f.repo,'rev-parse','HEAD');command(f.repo,'mv','file','renamed');writeFileSync(join(f.repo,':(glob)*'),'literal\n');writeFileSync(join(f.repo,'binary'),Buffer.from([0,1,2,3]));command(f.repo,'add','.');command(f.repo,'commit','-qm','rename and binary');const head=command(f.repo,'rev-parse','HEAD');
 const git=new Git(f.repo,10000),files=await git.files('compare',base,head);
 assert.ok(files.some(file=>file.path==='renamed'&&file.oldPath==='file'));
 assert.match((await git.diff('compare','renamed',base,head,{oldPath:'file'})).patch,/rename from file/);
 assert.match((await git.diff('compare',':(glob)*',base,head)).patch,/\+literal/);
 assert.match((await git.diff('compare','binary',base,head)).patch,/Binary files/);
 command(f.repo,'rm','renamed');command(f.repo,'commit','-qm','delete');assert.match((await git.diff('compare','renamed',head,command(f.repo,'rev-parse','HEAD'))).patch,/deleted file mode/);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
