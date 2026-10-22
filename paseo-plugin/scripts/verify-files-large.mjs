/** Bounded-memory transfer/ZIP64 proof in a disposable real Git project (> 4 GiB). */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, open, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadConfig } from '../server/backend/config.ts';
import { Workspaces } from '../server/backend/workspaces.ts';
import { ObservationCache } from '../server/backend/cache.ts';
import { WorkspaceFiles } from '../server/backend/files.ts';
const root = await mkdtemp(join(tmpdir(), 'wb-files-large-')), output = resolve(process.env.WORKBENCH_VERIFY_OUTPUT || join(import.meta.dirname,'../../.local/verification/files'));
await mkdir(output,{recursive:true});
let files, workspaces, cache;
const report = { kind: 'node-file-service-real-files', bytes: 4 * 1024 ** 3 + 37, chunkBytes: 512*1024, checks: [], peakRss: 0, baselineRss: process.memoryUsage().rss };
const memory = setInterval(() => { report.peakRss = Math.max(report.peakRss,process.memoryUsage().rss); },25);
const hash = b => createHash('sha256').update(b).digest('hex');
try {
  await mkdir(join(root,'repo')); const git=(...args)=>execFileSync('git',['-C',join(root,'repo'),...args],{stdio:'pipe'});
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');await writeFile(join(root,'repo/README'),'initial');git('add','.');git('commit','-qm','initial');
  await writeFile(join(root,'project.json'),JSON.stringify({sourceRoot:root,repositories:[{id:'repo',path:'repo'}]}));
  const config=loadConfig(join(root,'project.json'));workspaces=new Workspaces(config);cache=new ObservationCache(config);files=new WorkspaceFiles(workspaces,cache,()=>{});
  const workspaceId=workspaces.list()[0].id, request=input=>files.request(input), size=report.bytes;
  await mkdir(join(root,'payload'));
  await request({action:'upload',id:'large',workspaceId,path:'payload',name:'large.zip',size,modifiedAt:1});
  const bytes=Buffer.alloc(report.chunkBytes,0x41), data=bytes.toString('base64'), sha256=hash(bytes), expected=createHash('sha256');
  const start=Date.now();
  for(let offset=0;offset<size;offset+=bytes.length){const n=Math.min(bytes.length,size-offset), part=bytes.subarray(0,n); expected.update(part); const result=await request({action:'chunk',id:'large',offset,data:n===bytes.length?data:part.toString('base64'),sha256:n===bytes.length?sha256:hash(part)});assert.equal(result.offset,offset+n);if(offset%(512*1024*1024)===0)console.log(JSON.stringify({phase:'upload',offset:offset+n,size}));}
  await request({action:'finish',id:'large'});
  const wait=async(id,states)=>{const until=Date.now()+180000;while(Date.now()<until){const task=await request({action:'task',id});if(states.includes(task.state))return task; if(task.state==='failed')throw Error(task.error);await new Promise(r=>setTimeout(r,50));}throw Error('Task timeout');};
  const uploaded=await wait('large',['complete']); assert.equal(uploaded.sha256,expected.digest('hex'));assert.equal((await stat(join(root,'payload/large.zip'))).size,size);report.uploadMs=Date.now()-start;report.checks.push('all >4 GiB upload chunks durably confirmed and full SHA-256 matched');
  await request({action:'download',id:'download',workspaceId,paths:['payload/large.zip']});await wait('download',['active']);
  const downloaded=createHash('sha256'), readStart=Date.now();
  for(let offset=0;offset<size;offset+=bytes.length){const response=await request({action:'read',id:'download',offset});const chunk=Buffer.from(response.data,'base64');assert.equal(hash(chunk),response.sha256);downloaded.update(chunk);await request({action:'ack',id:'download',offset:offset+chunk.length});}
  assert.equal(downloaded.digest('hex'),uploaded.sha256); report.downloadMs=Date.now()-readStart;report.checks.push('all >4 GiB download chunks matched uploaded bytes with bounded buffers');
  const zipStart=Date.now();await request({action:'download',id:'archive',workspaceId,paths:['payload']});const archive=await wait('archive',['active']);
  const destination=await open(join(root,'archive.zip'),'wx');try{for(let offset=0;offset<archive.size;){const chunk=await request({action:'read',id:'archive',offset});const buffer=Buffer.from(chunk.data,'base64');await destination.write(buffer);offset+=buffer.length;}}finally{await destination.close();}
  const zipInfo=execFileSync('python3',['-c','import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); i=z.getinfo("payload/large.zip"); print(json.dumps({"fileSize":i.file_size,"zip64":b"\\x01\\x00" in i.extra,"valid":z.testzip() is None}))',join(root,'archive.zip')],{encoding:'utf8',timeout:180000});report.zip=JSON.parse(zipInfo);assert.equal(report.zip.fileSize,size);assert.equal(report.zip.valid,true);assert.equal(report.zip.zip64,true);report.archiveBytes=archive.size; assert.ok(archive.size > 4*1024**3); report.zipMs=Date.now()-zipStart;report.checks.push('streaming ZIP64 archive and entry both >4 GiB validate through Python zipfile without extraction');
  assert.ok(report.peakRss-report.baselineRss<256*1024*1024,'memory growth stays bounded independently of total bytes');report.ok=true;
}catch(e){report.ok=false;report.error=e.stack;process.exitCode=1;}
finally{clearInterval(memory);await files?.close();await workspaces?.observationRecords.close();await cache?.close();await rm(root,{recursive:true,force:true});await writeFile(join(output,'files-large-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
