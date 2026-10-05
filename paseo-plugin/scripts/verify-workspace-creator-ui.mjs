/** Real isolated Paseo renderer; provenance fixtures do not touch normal records. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import {backendRequest} from '../server/backend-supervisor.ts';
const output=process.env.WORKBENCH_VERIFY_OUTPUT || '/tmp/workbench-creator-ui';mkdirSync(output,{recursive:true});
const host=spawn(process.execPath,[join(import.meta.dirname,'verify-live.mjs')],{env:{...process.env,WORKBENCH_LIVE_UI:'1'},stdio:['ignore','pipe','pipe']});
let logs='',ui,client,browser,page;const exited=new Promise(r=>host.once('exit',r));host.stderr.on('data',x=>logs+=x);
const ready=new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('host readiness timeout')),120000);createInterface({input:host.stdout}).on('line',line=>{logs+=line+'\n';try{const x=JSON.parse(line);if(x.kind==='ui-ready'){clearTimeout(timer);yes(x);}}catch{}});void exited.then(code=>{clearTimeout(timer);no(Error(`host exited ${code}`));});});
const report={checks:[],pageErrors:[]};
try{
 ui=await ready;client=new DaemonClient({url:ui.url.replace('http:','ws:')+'/ws',clientId:'creator-ui',clientType:'mcp',reconnect:{enabled:false},webSocketFactory:(u,o)=>new WebSocket(u,o?.protocols,{headers:o?.headers})});await client.connect();
 const agent=await client.createAgent({config:{provider:'codex',cwd:ui.project,modeId:'auto',featureValues:{plan_mode:false}}});await client.updateAgent(agent.id,{name:'Creator fixture'});
 const creator={agentId:agent.id,name:'Creator fixture',recordedAt:new Date().toISOString()};
 const socket=join(ui.project,'s.sock');
 for(const [name,owner] of [['mine-active',creator],['mine-history',creator],['other-active',{...creator,agentId:'other-session'}]]){const r=await backendRequest(socket,'workspace.create',{name,repositories:['one'],creator:owner},30000);assert.ok(r.ok);}
 assert.ok((await backendRequest(socket,'workspace.remove',{workspaceId:'mine-history'},30000)).ok);
 browser=await chromium.launch({headless:true});const browserContext=await browser.newContext({viewport:{width:1280,height:1050}});page=await browserContext.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(ui.url);await page.getByRole('button',{name:'a',exact:true}).click();
 await page.getByRole('button',{name:'Search',exact:true}).click();
 const input=page.getByTestId('command-center-input');await input.fill('Open Workspace Workbench');
 const results=page.getByTestId('command-center-results');await results.getByText('Open Workspace Workbench',{exact:true}).waitFor();assert.equal(await results.getByText('Open Workspace Workbench',{exact:true}).count(),1);await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Open Workspace Workbench',exact:true}).click();
 await page.getByTestId('workbench-graph-content').waitFor({timeout:30000});await page.getByText('Main workspace',{exact:true}).first().click();
 const creatorFilter=page.getByRole('button',{name:'Creator session',exact:true});await creatorFilter.click();
 await page.getByRole('button',{name:/^Creator fixture · .*\(2\)$/}).click();
 await page.getByTestId('workspace-option-mine-active').waitFor();assert.equal(await page.getByTestId('workspace-option-other-active').count(),0);
 const search=page.getByPlaceholder('Search workspaces…');await search.fill('mine');await page.getByRole('button',{name:'Manage multiple',exact:true}).click();await page.getByRole('button',{name:'Select matching items',exact:true}).click();await page.getByText('Selected 1',{exact:true}).waitFor();
 await page.getByRole('button',{name:/^History \d+$/}).click();await page.getByTestId('workspace-option-mine-history').waitFor();await page.getByText('Selected 0',{exact:true}).waitFor();
 await page.screenshot({path:join(output,'creator-desktop.png')});report.listWidth=(await page.getByTestId('workbench-workspace-list').boundingBox()).width;report.checks.push('Header entry exposes creator filtering without an agent context; search/history and batch selection stay scoped; command search has only one Open Workspace Workbench');
 await page.getByRole('button',{name:'Exit selection',exact:true}).click();await page.getByTestId('workspace-option-mine-history').click();
 await page.getByRole('button',{name:'Open Workbench layout menu',exact:true}).click();await page.getByText('Created by session: Creator fixture',{exact:true}).waitFor();report.checks.push('Creator snapshot is visible in workspace details');
 const globalPage=await page.context().newPage();globalPage.on('pageerror',e=>report.pageErrors.push(e.message));await globalPage.goto(ui.url);await globalPage.getByRole('button',{name:'Workspace Workbench',exact:true}).first().click();
 const surface=globalPage.locator('[aria-label="Workspace Workbench"]').filter({has:globalPage.getByTestId('workbench-workspace-selector-toggle')}).last();await surface.waitFor({timeout:30000});await surface.getByTestId('workbench-workspace-selector-toggle').click();
 await surface.getByRole('button',{name:'Creator session',exact:true}).click();await surface.getByRole('button',{name:/^Creator fixture · other-se \(1\)$/}).click();
 await surface.getByTestId('workspace-option-other-active').waitFor();assert.equal(await surface.getByTestId('workspace-option-mine-active').count(),0);
 await globalPage.screenshot({path:join(output,'creator-global.png')});report.checks.push('Global sidebar entry can select another creator without a current agent');await globalPage.close();
 assert.equal(report.pageErrors.length,0);report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;if(page){report.visible=await page.locator('body').innerText().catch(()=>'');await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}}
finally{await browser?.close();client?.close();if(ui)writeFileSync(ui.continueFile,'continue\n');else host.kill('SIGTERM');report.hostExitCode=await exited;if(report.hostExitCode!==0){report.ok=false;process.exitCode=1;}writeFileSync(join(output,'host.log'),logs);writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
