/** Opt-in, interleaved comparison against an existing baseline checkout. No user projects. */
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const baseline=resolve(process.argv[2]||''),current=resolve(import.meta.dirname,'..');
if(!process.argv[2])throw Error('Usage: node --expose-gc --experimental-strip-types scripts/verify-ux-performance.mjs BASELINE_PLUGIN');
const samples=20,delay=ms=>new Promise(r=>setTimeout(r,ms));
const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
const summary=values=>({samples:values.length,median:[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)],p95:p95(values)});
const variants=await Promise.all([baseline,current].map(async root=>({root,...await import(join(root,'client/files-store.ts')),platform:await import(join(root,'client/files-platform.ts'))})));
const report={kind:'interleaved-actual-implementation-comparison',samples,download:[],zip:[],directory:[],limitations:['Transport latency is injected per RPC; staging is a durable-prefix test double with zero disk latency. UI and real OPFS have separate actual-host acceptance. RSS is the Node harness process, not Windows client memory.']};
const block=Buffer.alloc(512*1024,7),data=block.toString('base64'),sha256=createHash('sha256').update(block).digest('hex'),size=8*1024*1024;
const oldBridge=globalThis.WorkbenchFileSave;globalThis.WorkbenchFileSave={open:async()=>({})};
try{
  if(!process.argv.includes('--zip-only'))for(const rtt of [100,200]){
    const results=[[],[]];
    for(let sample=0;sample<samples;sample++)for(const index of sample%2?[1,0]:[0,1]){
      globalThis.gc?.();const variant=variants[index],platform=variant.platform,previous={supported:platform.DownloadStaging.supported,open:platform.DownloadStaging.open};
      let staged=0,reads=0,acks=0,flight=0,peak=0,peakRss=process.memoryUsage().rss;const digest=createHash('sha256');
      platform.DownloadStaging.supported=()=>true;platform.DownloadStaging.open=async()=>({offset:async()=>0,write:async(offset,bytes)=>{assert.equal(offset,staged);digest.update(bytes);staged+=bytes.length;}});
      const store=new variant.FileTransferStore('isolated-benchmark'),task={id:'rtt',direction:'download',name:'data.bin',workspaceId:'main',workspaceName:'Main',instance:'fixed',path:'',size,offset:0,state:'active',createdAt:1,updatedAt:1};
      store.tasks.set(task.id,task);store.readWindow=index===1;
      store.rpc=async input=>{peak=Math.max(peak,++flight);await delay(rtt);flight--;if(input.action==='read'){reads++;assert.ok((input.confirmedOffset||0)<=staged);task.offset=Math.max(task.offset,input.confirmedOffset||0);return {offset:input.offset,size,data,sha256};}if(input.action==='ack'){acks++;assert.ok(input.offset<=staged);task.offset=Math.max(task.offset,input.offset);task.state=task.offset===size?'ready_to_save':'active';return {...task,updatedAt:++task.updatedAt};}throw Error(input.action);};
      const memory=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},20),start=performance.now();
      try{await store.receive({...task});results[index].push({ms:performance.now()-start,reads,acks,peakRequests:peak,peakRss});assert.equal(staged,size);assert.equal(task.offset,size);assert.equal(digest.digest('hex'),createHash('sha256').update(Buffer.alloc(size,7)).digest('hex'));}
      finally{clearInterval(memory);platform.DownloadStaging.supported=previous.supported;platform.DownloadStaging.open=previous.open;}
    }
    const before=summary(results[0].map(v=>v.ms)),after=summary(results[1].map(v=>v.ms));
    report.download.push({rtt,before,after,improvement:1-after.median/before.median,raw:results});assert.ok(1-after.median/before.median>=.30);
  }
}finally{globalThis.WorkbenchFileSave=oldBridge;}
const root=await mkdtemp(join(tmpdir(),'wb-ux-performance-')),resources=[];
try{
  const source=join(root,'source'),repo=join(source,'repo'),wide=join(source,'wide');await mkdir(repo,{recursive:true});await mkdir(wide);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});git('init','-q');git('config','user.name','Performance QA');git('config','user.email','qa@example.invalid');await writeFile(join(repo,'README'),'fixture');git('add','.');git('commit','-qm','fixture');
  for(let i=0;i<640;i++)await writeFile(join(wide,`item-${String(i).padStart(4,'0')}`),'fixed tiny file\n');for(let i=0;i<10;i++)await mkdir(join(wide,`folder-${i}`));
  for(const [index,variant]of variants.entries()){
    const {loadConfig}=await import(join(variant.root,'server/backend/config.ts')),{Workspaces}=await import(join(variant.root,'server/backend/workspaces.ts')),{ObservationCache}=await import(join(variant.root,'server/backend/cache.ts')),{WorkspaceFiles}=await import(join(variant.root,'server/backend/files.ts'));
    const configFile=join(root,`project-${index}.json`);await writeFile(configFile,JSON.stringify({sourceRoot:source,stateRoot:join(root,`state-${index}`),repositories:[{id:'repo',path:'repo'}],discovery:{mode:'manual'}}));
    const config=loadConfig(configFile),workspaces=new Workspaces(config),cache=new ObservationCache(config),files=new WorkspaceFiles(workspaces,cache,()=>{}),resource={workspaces,cache,files,saves:0,saveMs:0};
    const save=files.tasks.journal.save.bind(files.tasks.journal);files.tasks.journal.save=task=>{resource.saves++;const at=performance.now();try{return save(task);}finally{resource.saveMs+=performance.now()-at;}};resources.push(resource);
  }
  const zipped=[[],[]],firstPage=[[],[]];
  for(let sample=0;sample<samples;sample++)for(const index of sample%2?[1,0]:[0,1]){
    const r=resources[index],id=`zip-${index}-${sample}`;r.saves=0;r.saveMs=0;const at=performance.now();await r.files.request({action:'download',id,workspaceId:'main',paths:['wide']});
    let task;for(let i=0;i<10000;i++){task=r.files.tasks.journal.require(id);if(['active','failed'].includes(task.state))break;await delay(2);}assert.equal(task.state,'active',task.error);zipped[index].push({ms:performance.now()-at,saves:r.saves,journalMs:r.saveMs});await r.files.request({action:'control',id,command:'cancel'});
    r.cache.clear();const start=performance.now();const page=await r.files.request({action:'list',workspaceId:'main',path:'wide',...(index?{listingProtocol:2}:{})});firstPage[index].push(performance.now()-start);assert.equal(page.entries.length,200);
  }
  report.zip={before:summary(zipped[0].map(r=>r.saves)),after:summary(zipped[1].map(r=>r.saves)),elapsedBefore:summary(zipped[0].map(r=>r.ms)),elapsedAfter:summary(zipped[1].map(r=>r.ms)),raw:zipped};assert.ok(report.zip.before.median/report.zip.after.median>=10);
  report.directory={before:summary(firstPage[0]),after:summary(firstPage[1]),raw:firstPage};
}finally{for(const r of resources){await r.files.close();await r.workspaces.observationRecords.close();await r.cache.close();}await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({...report,ok:true},null,2));
