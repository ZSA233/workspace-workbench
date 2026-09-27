/** Real bundled Paseo UI, an isolated host and the approved same-volume repository copies. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import { freezePlugin, distribution } from './refresh-real-fixture.mjs';
const exec=promisify(execFile), source=resolve(import.meta.dirname,'..');
const output=resolve(process.env.WORKBENCH_REFRESH_OUTPUT || join(source,'../.local/verification/panel-refresh'));
const fixture=JSON.parse(await readFile(join(output,'fixture.json'),'utf8'));
const runRoot=await mkdtemp(join(output,'ui-run-')), plugin=join(runRoot,'plugin'), home=await mkdtemp('/tmp/wb-refresh-ui-'), registry=join(runRoot,'projects.json');
const build=await freezePlugin(source,plugin); await writeFile(registry,JSON.stringify({configs:[fixture.config]}));
const listener=createServer(); await new Promise(r=>listener.listen(0,'127.0.0.1',r)); const port=listener.address().port; await new Promise(r=>listener.close(r));
await writeFile(join(home,'config.json'),JSON.stringify({version:1,pluginsEnabled:true,daemon:{listen:`0.0.0.0:${port}`,relay:{enabled:false},mcp:{enabled:false,injectIntoAgents:false}},features:{webUi:{enabled:true}},plugins:{'workspace-workbench-paseo':{source:'directory',path:plugin,enabled:true}}}));
const env={...process.env,PASEO_HOME:home,WORKSPACE_WORKBENCH_PROJECT_REGISTRY:registry,WORKSPACE_WORKBENCH_PLUGIN_ROOT:plugin,PASEO_DICTATION_ENABLED:'false',PASEO_VOICE_MODE_ENABLED:'false'}; delete env.WORKSPACE_WORKBENCH_CONFIG;
const cli=process.env.PASEO_CLI||'paseo';
const daemon=spawn(cli,['daemon','run','--home',home],{env,stdio:['ignore','pipe','pipe']}); let logs='';for(const stream of [daemon.stdout,daemon.stderr]) stream.on('data',b=>{logs=(logs+b).slice(-500000);});
const report={kind:'actual-paseo-real-history-ui',build,groups:{},checks:[],events:[],ok:false,runRoot};
let client,browser,page;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
  for(let n=0;n<120;n++){if(daemon.exitCode!==null)throw Error(`Isolated daemon startup failed: ${logs.slice(-2000)}`);if(await fetch(`http://127.0.0.1:${port}`).then(r=>r.ok).catch(()=>false))break; await sleep(500);}
  client=new DaemonClient({url:`ws://127.0.0.1:${port}/ws`,clientId:'refresh-real-ui',clientType:'mcp',reconnect:{enabled:false},webSocketFactory:(u,o)=>new WebSocket(u,o?.protocols,{headers:o?.headers})});
  let connected=false;for(let n=0;n<120;n++){try{await client.connect();connected=true;break;}catch{await sleep(500);}}assert.ok(connected,'isolated host WebSocket never became ready');
  const rpc=(method,params={})=>client.invokePluginRpc('workspace-workbench-paseo','workspace.workbench.query',{projectConfig:fixture.config,method,params});
  let pluginReady=false;for(let n=0;n<120;n++){try{if((await rpc('observer.health')).ok){pluginReady=true;break;}}catch{}await sleep(500);}assert.ok(pluginReady,'isolated plugin never became ready');
  const workspaceId='verify-current-repository';
  const workspaces=JSON.parse(await readFile(join(fixture.root,'workspaces/records',`${workspaceId}.json`),'utf8'));
  const repository=workspaces.repositories.find(r=>r.repoPath==='halh')||workspaces.repositories[0];
  const proof=join(repository.worktreePath,'workbench-refresh-ui.txt');
  const git=args=>exec('git',['-C',repository.worktreePath,...args],{timeout:60000,maxBuffer:1024*1024});
  await writeFile(proof,`baseline ${Date.now()}\n`);await git(['add','workbench-refresh-ui.txt']);await git(['commit','-qm',`UI baseline ${Date.now()}`]);
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1600,height:1050}});
  page.on('pageerror',e=>{report.pageErrors??=[];report.pageErrors.push(e.message);});
  page.on('websocket',socket=>socket.on('framesent',frame=>{if(typeof frame.payload!=='string')return;try{const v=JSON.parse(frame.payload),m=v.message||v;if(JSON.stringify(m).includes('repository-refresh-')){report.events.push({at:Date.now(),message:m});if(report.events.length>300)report.events.shift();}}catch{}}));
  report.refreshRequests=[];report.refreshResponses=[];
  const findTask=(value,depth=0)=>{if(!value||typeof value!=='object'||depth>6)return null;if(value.taskId!==undefined&&value.state&&value.protocol)return value;for(const child of Object.values(value)){const task=findTask(child,depth+1);if(task)return task;}return null;};
  page.on('websocket',socket=>{
    socket.on('framesent',frame=>{if(typeof frame.payload!=='string')return;try{const v=JSON.parse(frame.payload),m=v.message||v;if(m.input?.method==='observer.refresh'){report.refreshRequests.push({at:Date.now(),...m.input.params});if(report.refreshRequests.length>300)report.refreshRequests.shift();}}catch{}});
    socket.on('framereceived',frame=>{if(typeof frame.payload!=='string'||!frame.payload.includes('taskId'))return;try{const t=findTask(JSON.parse(frame.payload));if(t){report.refreshResponses.push({at:Date.now(),taskId:t.taskId,requestId:t.requestId,state:t.state,phase:t.phase,acceptedAt:t.acceptedAt,queueMs:t.queueMs,cacheHit:t.result?.cacheHit,trace:t.result?.trace,regions:Object.fromEntries(Object.entries(t.result?.regions||{}).map(([name,r])=>[name,{state:r.state,durationMs:r.durationMs,head:r.result?.head||r.result?.repository?.head,error:r.error?.code}]))});if(report.refreshResponses.length>300)report.refreshResponses.shift();}}catch{}});
  });

  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByText('Add project',{exact:true}).first().click();await page.getByText('Search for directory',{exact:true}).click();await page.getByPlaceholder('Search directories or enter a path...').fill(workspaces.treePath);await page.getByText('Open this path',{exact:true}).click();
  await page.getByText('Workspace Workbench',{exact:true}).first().click();await page.getByText('Repositories',{exact:true}).filter({visible:true}).first().waitFor({timeout:30000});
  if(await page.getByText('Main workspace',{exact:true}).count()){await page.getByText('Main workspace',{exact:true}).first().click();await page.getByText(workspaceId,{exact:true}).filter({visible:true}).last().click();}
  await page.getByText(repository.repoPath,{exact:true}).filter({visible:true}).first().click();
  await page.getByText(/current ref:/).filter({visible:true}).first().waitFor({timeout:30000});
  // Wait for initial preparation separately; it is not a cache-switch sample.
  const readyAt=Date.now();
  const start=await rpc('observer.refresh',{workspaceId,repoPath:repository.repoPath,historyMode:'full',maxCommits:50,scope:'working',requestId:'ui-preparation'});
  assert.equal(start.ok,true);let prepared=start.result;
  while(['running','queued'].includes(prepared.state)){await sleep(250);prepared=(await rpc('observer.refresh',{action:'status',requestId:'ui-preparation',taskId:prepared.taskId})).result;}
  report.preparationMs=Date.now()-readyAt;assert.equal(prepared.state,'ready');
  const clickRefresh=async()=>{
    await page.getByRole('button',{name:'Observation status',exact:true}).click();
    const button=page.getByText('Refresh now',{exact:true}).filter({visible:true}).first();
    await button.waitFor();await page.evaluate(()=>{window.__refreshPointer=null;document.addEventListener('pointerdown',()=>{window.__refreshPointer=Date.now();},{once:true,capture:true});});
    await button.click();return page.evaluate(()=>window.__refreshPointer);
  };
  const baselineFiles=(await rpc('repository.changes',{workspaceId,repoPath:repository.repoPath,scope:'branch'})).result.files.length;
  const measured=[];report.rounds=[];
  for(let i=0;i<20;i++){
    const message=`UI refresh proof ${i} ${Date.now()}`;
    const extra=`workbench-refresh-ui-${runRoot.split('/').at(-1)}-${i}.txt`;await writeFile(join(repository.worktreePath,extra),`${message}\n`);await writeFile(proof,`${message}\n`);await git(['add','workbench-refresh-ui.txt',extra]);await git(['commit','-qm',message]);
    const head=(await git(['rev-parse','HEAD'])).stdout.trim();
    const at=await clickRefresh();report.rounds.push({at,head,message});await Promise.all([page.getByText(message,{exact:false}).filter({visible:true}).first().waitFor({timeout:5000}),page.getByText(`HEAD: ${head}`,{exact:true}).filter({visible:true}).first().waitFor({timeout:5000}),page.getByText(`${baselineFiles+i+1} file(s)`,{exact:true}).filter({visible:true}).first().waitFor({timeout:5000})]);
    measured.push(Date.now()-at);

  }
  report.groups['latest-commit-visible']=distribution(measured);assert.ok(report.groups['latest-commit-visible'].p95Ms<=5000);
  report.checks.push('20 actual pointer clicks showed a newly committed graph subject within the critical refresh target');
  const switching=[];
  for(const repo of workspaces.repositories){let t=(await rpc('observer.refresh',{workspaceId,repoPath:repo.repoPath,historyMode:'branch',maxCommits:50,scope:'branch',prefetch:true,requestId:`warm-ui:${repo.repoPath}`})).result;while(['running','queued'].includes(t.state)){await sleep(250);t=(await rpc('observer.refresh',{action:'status',taskId:t.taskId,requestId:`warm-ui:${repo.repoPath}`})).result;}assert.equal(t.state,'ready');}
  for(let i=0;i<20;i++){
    const repo=workspaces.repositories[(i+1)%workspaces.repositories.length];
    const item=page.getByText(repo.repoPath,{exact:true}).filter({visible:true}).first();await item.scrollIntoViewIfNeeded();
    const at=Date.now();await item.click();await page.getByText(new RegExp(`current ref:.*${repo.branch.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`)).filter({visible:true}).first().waitFor({timeout:1000});switching.push(Date.now()-at);
  }
  report.groups['cached-five-repository-switch']=distribution(switching);assert.ok(report.groups['cached-five-repository-switch'].p95Ms<=200);
  report.checks.push('20 switches across all five prewarmed repositories displayed their actual branch details');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await sleep(300);assert.equal(await page.locator('[aria-busy="true"]:visible').count(),0);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  report.checks.push('blur did not leave a busy indicator running');
  await page.screenshot({path:join(runRoot,'final.png'),fullPage:true});
  report.health=(await rpc('observer.health')).result;assert.deepEqual(report.pageErrors||[],[]);report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;if(page){await page.screenshot({path:join(runRoot,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(runRoot,'failure-dom.txt'),await page.locator('body').innerText().catch(()=>''));}}
finally{await browser?.close();await client?.close();try{await exec(cli,['daemon','stop','--home',home,'--timeout','5','--json'],{env,timeout:10000});}catch{}daemon.kill('SIGTERM');await Promise.race([new Promise(r=>daemon.once('exit',r)),sleep(5000)]);if(daemon.exitCode===null&&!daemon.signalCode)daemon.kill('SIGKILL');await writeFile(join(runRoot,'daemon.log'),logs);await writeFile(join(output,'ui-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,error:report.error,groups:report.groups,runRoot},null,2));}
