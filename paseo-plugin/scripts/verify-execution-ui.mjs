/** Actual isolated Paseo UI; bound/failure states are injected, not model handoff evidence. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import {backendRequest} from '../server/backend-supervisor.ts';
const output=process.env.WORKBENCH_VERIFY_OUTPUT || '/tmp/workbench-execution-ui';mkdirSync(output,{recursive:true});
const host=spawn(process.execPath,[join(import.meta.dirname,'verify-live.mjs')],{env:{...process.env,WORKBENCH_LIVE_UI:'1'},stdio:['ignore','pipe','pipe']});
let logs='',ui,client,browser,page;const exited=new Promise(r=>host.once('exit',r));host.stderr.on('data',x=>logs+=x);
const ready=new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('host readiness timeout')),120000);createInterface({input:host.stdout}).on('line',line=>{logs+=line+'\n';try{const x=JSON.parse(line);if(x.kind==='ui-ready'){clearTimeout(timer);yes(x);}}catch{}});void exited.then(code=>{clearTimeout(timer);no(Error(`host exited ${code}`));});});
const report={checks:[],pageErrors:[]};
try{
 ui=await ready;client=new DaemonClient({url:ui.url.replace('http:','ws:')+'/ws',clientId:'execution-ui',clientType:'mcp',reconnect:{enabled:false},webSocketFactory:(u,o)=>new WebSocket(u,o?.protocols,{headers:o?.headers})});await client.connect();
 const agent=await client.createAgent({config:{provider:'codex',cwd:ui.project,modeId:'auto',featureValues:{plan_mode:false}}});await client.updateAgent(agent.id,{name:'Execution fixture'});
 for(const name of ['execution-sample','other-sample'])assert.ok((await backendRequest(join(ui.project,'s.sock'),'workspace.create',{name,repositories:['one']},30000)).ok);
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>report.pageErrors.push(e.message));await page.emulateMedia({colorScheme:'dark'});
 let injected=null;const requests=new Map(),mutations=[];
 const visit=(value,fn)=>{if(!value||typeof value!=='object')return;fn(value);for(const child of Object.values(value))visit(child,fn);};
 await page.routeWebSocket('**/*',socket=>{const server=socket.connectToServer();socket.onMessage(message=>{try{visit(JSON.parse(String(message)),value=>{if(value.type==='plugin.rpc.invoke.request'){requests.set(value.requestId,value);if(/delegate|handoff-preview/.test(value.method))mutations.push(value.method);}});}catch{}server.send(message);});server.onMessage(message=>{let outgoing=message;try{const parsed=JSON.parse(String(message));visit(parsed,value=>{if(value.type==='plugin.rpc.invoke.response'){const req=requests.get(value.payload?.requestId);if(req?.method==='workspace.workbench.binding'&&req.input?.workspaceId==='execution-sample'&&injected)value.payload.output=injected;}});outgoing=JSON.stringify(parsed);}catch{}socket.send(outgoing);});});
 await page.goto(ui.url);await page.getByRole('button',{name:'a',exact:true}).click();await page.getByRole('button',{name:'Open Workspace Workbench',exact:true}).click();await page.getByTestId('workbench-graph-content').waitFor({timeout:30000});
 const select=async id=>{await page.getByTestId('workbench-workspace-selector-toggle').click();await page.getByTestId('workspace-option-'+id).click();};
 const details=page.getByTestId('execution-session-details');
 const openDetails=async()=>{await page.getByRole('button',{name:'Open Workbench layout menu',exact:true}).click();await page.getByText('Execution session / handoff',{exact:true}).click();await details.waitFor();};
 const closeDetails=()=>page.keyboard.press('Escape');
 await select('execution-sample');await openDetails();await details.getByText('No execution session is bound to this workspace.',{exact:true}).waitFor();await closeDetails();
 assert.equal(await page.getByText('Follow execution session',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:/^Open execution session/}).count(),0);
 report.checks.push('Actual unbound backend response: no banner or session icon; details are available on demand');
 const bound={ok:true,binding:{workspaceId:'execution-sample',paseoWorkspaceId:'fixture',treePath:ui.project,agentId:agent.id,relationship:'child',status:'running',updatedAt:new Date().toISOString()},agent:{id:agent.id,workspaceId:null,cwd:ui.project,provider:'codex',model:null,status:'running',relationship:'child',parentAgentId:null,planningState:'unknown',permissionModeId:'full-access'}};
 injected=bound;await openDetails();await details.getByRole('button',{name:'Reload binding',exact:true}).click();await details.getByText('full-access',{exact:true}).waitFor();await details.getByText('Not observed',{exact:true}).waitFor();await closeDetails();
 const icon=page.getByRole('button',{name:/^Open execution session ·/});await icon.waitFor();
 report.widthChecks=[];
 for(const colorScheme of ['dark','light']){
  await page.emulateMedia({colorScheme});await page.getByTestId('workbench-workspace-selector-toggle').waitFor();if(colorScheme==='light'){await select('execution-sample');await icon.waitFor();}
  const header=page.getByTestId('workbench-workspace-header');const original=await header.getAttribute('style');
  for(const width of [280,320,400]){
   await header.evaluate((node,width)=>{node.style.width=width+'px';node.style.maxWidth=width+'px';},width);
   const metrics=await header.evaluate(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,overflow:node.scrollWidth>node.clientWidth+1,colors:Array.from(node.querySelectorAll('*')).filter(n=>n.childNodes.length===1&&n.firstChild.nodeType===3).map(n=>getComputedStyle(n).color)}));
   assert.equal(metrics.overflow,false);if(colorScheme==='dark')assert.ok(metrics.colors.every(c=>c!=='rgb(0, 0, 0)'));report.widthChecks.push({colorScheme,...metrics});await header.screenshot({path:join(output,`header-${colorScheme}-${width}.png`)});
  }
  await header.evaluate((node,style)=>node.setAttribute('style',style||''),original);
  await openDetails();
  const colors=await details.evaluate(node=>Array.from(node.querySelectorAll('*')).filter(n=>n.childNodes.length===1&&n.firstChild.nodeType===3).map(n=>({text:n.textContent,color:getComputedStyle(n).color})));
  assert.ok(colors.length>0);if(colorScheme==='dark')assert.ok(colors.every(x=>x.color!=='rgb(0, 0, 0)'));report[colorScheme+'Colors']=colors;await page.screenshot({path:join(output,`details-${colorScheme}.png`)});
  await details.evaluate(node=>{for(const text of node.querySelectorAll('*'))if(text.childNodes.length===1&&text.firstChild.nodeType===3)text.style.fontSize=parseFloat(getComputedStyle(text).fontSize)*1.5+'px';});
  assert.equal(await details.evaluate(node=>node.scrollWidth>node.clientWidth+1),false);await page.screenshot({path:join(output,`details-${colorScheme}-enlarged.png`)});await closeDetails();
 }
 injected={ok:false,error:{code:'fixture_unavailable',message:'Injected temporary binding failure'}};await openDetails();await details.getByRole('button',{name:'Reload binding',exact:true}).click();await details.getByText('Status is not updated; showing the last successful observation.',{exact:true}).waitFor();await details.getByText('full-access',{exact:true}).waitFor();await closeDetails();await icon.waitFor();
 injected={...bound,binding:{...bound.binding,status:'archived'}};await openDetails();await details.getByRole('button',{name:'Reload binding',exact:true}).click();await details.getByRole('button',{name:'Open execution session',exact:true}).waitFor({state:'hidden'});await closeDetails();
 await page.getByRole('button',{name:/^Execution session ·/}).click();await details.waitFor();await closeDetails();
 await select('other-sample');assert.equal(await page.getByRole('button',{name:/^Execution session ·/}).count(),0);assert.equal(await details.count(),0);
 report.checks.push('Injected states on actual host renderer: bound, unknown mode despite full-access, retained failed refresh, archived details, workspace isolation');
 injected=bound;await select('execution-sample');await openDetails();await details.getByRole('button',{name:'Reload binding',exact:true}).click();await details.getByRole('button',{name:'Open execution session',exact:true}).waitFor();await closeDetails();await icon.click();await page.getByText('Execution fixture',{exact:true}).first().waitFor();report.navigationUrl=page.url();
 report.checks.push('Verified session icon invokes host navigation to a real isolated idle agent; no task was sent');
 assert.equal(mutations.length,0);assert.equal(report.pageErrors.length,0);report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;if(page){report.visible=await page.locator('body').innerText().catch(()=>'');await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}}
finally{await browser?.close();client?.close();if(ui)writeFileSync(ui.continueFile,'continue\n');else host.kill('SIGTERM');report.hostExitCode=await exited;if(report.hostExitCode!==0){report.ok=false;process.exitCode=1;}writeFileSync(join(output,'host.log'),logs);writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
