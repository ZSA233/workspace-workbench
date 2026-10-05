/** Actual isolated host and real provider sessions. No normal registry or project is changed. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import {digest} from '../server/orchestration-state.ts';
const output=process.env.WORKBENCH_VERIFY_OUTPUT || '/tmp/workbench-lightweight-live';mkdirSync(output,{recursive:true});
const child=spawn(process.execPath,[join(import.meta.dirname,'verify-live.mjs')],{env:{...process.env,WORKBENCH_LIVE_UI:'1'},stdio:['ignore','pipe','pipe']});
let logs='',ui,client;const exited=new Promise(r=>child.once('exit',r));child.stderr.on('data',x=>logs+=x);
const ready=new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('host readiness timeout')),120000);createInterface({input:child.stdout}).on('line',line=>{logs+=line+'\n';try{const x=JSON.parse(line);if(x.kind==='ui-ready'){clearTimeout(timer);yes(x);}}catch{}});void exited.then(code=>{clearTimeout(timer);no(Error(`isolated host exited ${code}`));});});
const report={checks:[],sessions:[],output};const save=()=>writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));
const wait=async(fn,ms=180000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,250));}throw Error('evidence condition timed out');};
const png=()=>{const crc=data=>{let v=0xffffffff;for(const b of data){v^=b;for(let n=0;n<8;n++)v=(v>>>1)^((v&1)?0xedb88320:0);}return(v^0xffffffff)>>>0;};const chunk=(n,data)=>{const name=Buffer.from(n),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([length,name,data,sum]);};const h=Buffer.alloc(13);h.writeUInt32BE(64,0);h.writeUInt32BE(64,4);h[8]=8;h[9]=2;const pixels=Buffer.alloc(64*193);for(let y=0;y<64;y++)for(let x=0;x<64;x++)pixels[y*193+1+x*3]=255;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);};
try{
 ui=await ready;report.project=ui.project;report.url=ui.url;save();console.log(JSON.stringify({phase:'host-ready',...ui}));
 client=new DaemonClient({url:ui.url.replace('http:','ws:')+'/ws',clientId:'lightweight-verification',clientType:'mcp',reconnect:{enabled:false},webSocketFactory:(u,o)=>new WebSocket(u,o?.protocols,{headers:o?.headers})});await client.connect();
 const config=join(ui.project,'project.json'),state=join(ui.project,'state','orchestration');
 const localState=key=>{const path=join(state,digest(key)+'.json');return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;};
 const invoke=(name,input)=>client.invokePluginRpc('workspace-workbench-paseo',name,{projectConfig:config,...input});
 const picture=png();
 for(const provider of (process.env.WORKBENCH_LIGHT_PROVIDERS || 'codex,claude').split(',')){
  const models=await client.listProviderModels(provider,{cwd:ui.project});const model=models.models.find(x=>x.isDefault&&x.isSelectable!==false)?.id||models.models.find(x=>x.isSelectable!==false)?.id;assert.ok(model);
  const userToken='USER-'+randomUUID(),fileCode='FILE-'+randomUUID(),name=`light-${provider}`,pictureName=`${name}.png`,specName=`${name}.txt`;
  writeFileSync(join(ui.project,'one',pictureName),picture);writeFileSync(join(ui.project,'one',specName),`Required file code: ${fileCode}\n`);
  const parent=await client.createAgent({config:{provider,model,cwd:ui.project,modeId:provider==='codex'?'auto':'bypassPermissions',...(provider==='codex'?{featureValues:{plan_mode:false}}:{})},initialPrompt:`Isolated handoff verification. Remember userToken ${userToken}. Initial requested color is blue. Retain the dominant color of the attached picture without describing it. Reply only ACK. Do not write files or invoke Workbench tools.`,images:[{data:picture.toString('base64'),mimeType:'image/png'}]});
  const first=await client.waitForFinish(parent.id,120000);assert.equal(first.status,'idle',first.error||'parent failed');
  await client.sendMessage(parent.id,'Correction: requested color is amber. Blue is superseded. Preserve the export API and add no dependencies. Reply only ACK.');assert.equal((await client.waitForFinish(parent.id,120000)).status,'idle');
  const session=localState(`session:${parent.id}`);assert.ok(session?.token,'actual session hook did not bind an identity');
  // Creator is taken from the token, not supplied as an Agent-selected creator field.
  const created=await invoke('workspace.workbench.workspace-create',{token:session.token,requestId:`create-${name}`,name,repositories:['one']});assert.ok(created.ok,JSON.stringify(created.error));assert.equal(created.result.creator.agentId,parent.id);
  const files=[{id:'picture',kind:'image',path:pictureName,repositoryId:'one'},{id:'spec',kind:'document',path:specName,repositoryId:'one'}];
  const request={requestId:`handoff-${name}`,workspaceId:created.workspaceId,task:'In repository one inside the assigned workspace, write result.json containing userToken recalled from the original conversation, requestedColor from the latest correction, pictureColor from the supplied picture, fileCode from the required file, actualCwd and branch obtained with tools. Read the supplied originals using Workbench handoff tools. If any information is missing use null, never guess or search old source directories. Do not change any other file. Report completion.',references:files};
  // For an existing workspace, source references are registered originals so untracked files need not exist in its worktree.
  for(const ref of files){const registered=await invoke('workspace.workbench.artifact.register',{token:session.token,artifact:{title:ref.id,kind:ref.kind,path:`one/${ref.path}`}});assert.ok(registered.ok,JSON.stringify(registered.error));delete ref.path;delete ref.repositoryId;ref.assetId=registered.reference.assetId;}
  const accepted=await invoke('workspace.workbench.orchestrate',{token:session.token,action:'submit',request});assert.ok(accepted.ok,JSON.stringify(accepted));
  console.log(JSON.stringify({phase:'submitted',provider,parentAgentId:parent.id,workspaceId:created.workspaceId}));
  const progress=await wait(()=>{const value=localState(`workflow:${parent.id}:${request.requestId}`);if(['failed','handoff-blocked'].includes(value?.stage)){if(provider==='claude' && value.result?.error?.code==='execution_provider_unverified')return value;throw Error(JSON.stringify(value.result));}return value?.stage==='handed-off'?value:null;});
  if(progress.stage!=='handed-off'){report.sessions.push({provider,model,parentAgentId:parent.id,workspaceId:created.workspaceId,status:'unsupported_execution_policy',error:progress.result.error});save();console.log(JSON.stringify({phase:'provider-limit-confirmed',provider}));continue;}
  const workerId=progress.result.agentId;const done=await client.waitForFinish(workerId,180000);assert.equal(done.status,'idle',done.error||'worker did not finish');
  const repo=created.result.repositories[0].worktreePath;const result=JSON.parse(readFileSync(join(repo,'result.json'),'utf8'));
  assert.equal(result.userToken,userToken);assert.equal(result.requestedColor,'amber');assert.equal(String(result.pictureColor).toLowerCase(),'red');assert.equal(result.fileCode,fileCode);assert.ok([resolve(repo),resolve(created.result.treePath)].includes(resolve(result.actualCwd)),`Unexpected execution directory: ${result.actualCwd}`);assert.equal(result.branch,created.result.repositories[0].branch);assert.equal(existsSync(join(ui.project,'one','result.json')),false);
  const manifest=JSON.parse(readFileSync(join(ui.project,'state','handoff-bundles',progress.bundle.id,'1','manifest.json'),'utf8'));assert.equal(manifest.sources.length,2);assert.ok(manifest.historyFile);assert.ok(progress.result.transfer.sources.every(x=>x.status==='ready'));
  const retry=await invoke('workspace.workbench.orchestrate',{token:session.token,action:'submit',request});assert.ok(retry.ok);assert.equal(localState(`workflow:${parent.id}:${request.requestId}`).result.agentId,workerId);
  report.sessions.push({provider,model,parentAgentId:parent.id,workerId,workspaceId:created.workspaceId,result,transfer:progress.result.transfer});save();console.log(JSON.stringify({phase:'verified',provider}));
  if(provider==='codex') {
    report.controls=[];
    const history=readFileSync(join(ui.project,'state','handoff-bundles',progress.bundle.id,'1',manifest.historyFile),'utf8');
    for(const kind of ['no-history','no-attachments']) {
      const target=await invoke('workspace.workbench.workspace-create',{token:session.token,requestId:kind,name:`control-${kind}`,repositories:['one']});assert.ok(target.ok);
      const cwd=target.result.repositories[0].worktreePath;
      const payload=kind==='no-history'?{images:[{data:picture.toString('base64'),mimeType:'image/png'}],attachments:[{type:'text',mimeType:'text/plain',title:'Required file',text:`Required file code: ${fileCode}`}]}:{attachments:[{type:'text',mimeType:'text/plain',contextKind:'chat_history',title:'Chat history',text:history}]};
      const control=await client.createAgent({config:{provider,model,cwd,modeId:'auto',featureValues:{plan_mode:false}},initialPrompt:'This is a context-transfer control. Use only the information actually attached to this message. Write result.json in the actual current directory with userToken, requestedColor from the latest user correction, pictureColor from an attached image, and fileCode from the provided reference text when available. Set unknown fields to null. Do not guess, call MCP tools, or search source directories or session stores. Do not edit any other file.',...payload});
      assert.equal((await client.waitForFinish(control.id,120000)).status,'idle');const actual=JSON.parse(readFileSync(join(cwd,'result.json'),'utf8'));
      report.controls.push({kind,agentId:control.id,result:actual});save();
      if(kind==='no-history'){assert.equal(actual.userToken,null);assert.equal(actual.requestedColor,null);assert.equal(String(actual.pictureColor).toLowerCase(),'red');assert.equal(actual.fileCode,fileCode);}
      else {assert.equal(actual.userToken,userToken);assert.equal(actual.requestedColor,'amber');assert.equal(actual.pictureColor,null);assert.equal(actual.fileCode,null);}
      console.log(JSON.stringify({phase:'control-verified',kind}));
    }
  }

 }
 report.checks.push('Real Codex received history, image and frozen file originals with correct worktree writes and idempotent retry; Claude execution is explicitly blocked by the existing verified-provider policy');
 report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;console.error(error.stack);}
finally{client?.close();if(ui)writeFileSync(ui.continueFile,'continue\n');else child.kill('SIGTERM');report.hostExitCode=await exited;if(report.hostExitCode!==0){report.ok=false;process.exitCode=1;}writeFileSync(join(output,'host.log'),logs);save();console.log(JSON.stringify(report,null,2));}
