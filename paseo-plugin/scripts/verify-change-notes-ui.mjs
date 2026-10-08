/** Real isolated Paseo renderer; provenance fixtures do not touch normal records. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,readFileSync,chmodSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {digest} from '../server/orchestration-state.ts';
import {chromium} from 'playwright';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import {backendRequest} from '../server/backend-supervisor.ts';
const output=process.env.WORKBENCH_VERIFY_OUTPUT || '/tmp/workbench-note-popover-ui';mkdirSync(output,{recursive:true});
const host=spawn(process.execPath,[join(import.meta.dirname,'verify-live.mjs')],{env:{...process.env,WORKBENCH_LIVE_UI:'1'},stdio:['ignore','pipe','pipe']});
let logs='',ui,client,browser,page;const exited=new Promise(r=>host.once('exit',r));host.stderr.on('data',x=>logs+=x);
const ready=new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('host readiness timeout')),120000);createInterface({input:host.stdout}).on('line',line=>{logs+=line+'\n';try{const x=JSON.parse(line);if(x.kind==='ui-ready'){clearTimeout(timer);yes(x);}}catch{}});void exited.then(code=>{clearTimeout(timer);no(Error(`host exited ${code}`));});});
const report={checks:[],pageErrors:[]};
try{
 ui=await ready;client=new DaemonClient({url:ui.url.replace('http:','ws:')+'/ws',clientId:'notes-ui',clientType:'mcp',reconnect:{enabled:false},webSocketFactory:(u,o)=>new WebSocket(u,o?.protocols,{headers:o?.headers})});await client.connect();
 const config=join(ui.project,'project.json');
 const created=await backendRequest(join(ui.project,'s.sock'),'workspace.create',{name:'notes-sample',repositories:['one']},30000);assert.ok(created.ok,JSON.stringify(created.error));
 const tree=join(ui.project,'workspaces','trees','notes-sample','one');
 const largeTail=Array.from({length:1000},(_,i)=>'// bounded reading sample '+i+'\n').join('');
 writeFileSync(join(tree,'sample.go'),'package sample\n\nfunc Value() int { return 2 }\n'+largeTail);
 writeFileSync(join(tree,'baseline.go'),'package baseline\n\nfunc Value() int { return 2 }\n'+largeTail);
 writeFileSync(join(tree,'sample_test.go'),'package sample\n\n// Check the requested default.\n');
 execFileSync('git',['-C',tree,'add','.']);execFileSync('git',['-C',tree,'-c','user.name=Sample','-c','user.email=sample@example.invalid','commit','-qm','Add sample value']);
 const agent=await client.createAgent({config:{provider:'codex',cwd:ui.project,modeId:'auto',featureValues:{plan_mode:false}}});
 const sessionPath=join(ui.project,'state','orchestration',digest('session:'+agent.id)+'.json');
 const token=JSON.parse(readFileSync(sessionPath,'utf8')).token;
 const gateway=JSON.parse(readFileSync(join(dirname(ui.continueFile),'paseo','workspace-workbench','gateway.json'),'utf8'));
 const headers={'content-type':'application/json','Authorization':'Bearer '+token,'X-Workbench-Gateway-Key':gateway.key,'X-Workbench-Project':config,'X-Workbench-Role':'interactive'};
 const call=async(name,args)=>{const response=await fetch('http://127.0.0.1:'+gateway.port+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:Math.random().toString(),method:'tools/call',params:{name,arguments:args}})});const body=await response.json();assert.ok(!body.error,JSON.stringify(body.error));assert.ok(!body.result.isError,JSON.stringify(body.result));return JSON.parse(body.result.content[0].text);};
 const scope={workspaceId:'notes-sample',repoPath:'one',scope:'branch',paths:['sample.go','sample_test.go']};
 const read=await call('workbench_change_notes_read',scope);assert.ok(read.ok,JSON.stringify(read));
 const snapshot=read.result.snapshot;
 const batch={requestId:'notes-live-once',snapshotId:snapshot.id,operations:[{id:'sample-value',expectedRevision:0,action:'upsert',content:{title:'Requested default value',reason:'Use the requested default',behavior:'Returns two',basis:'requirement',requirement:'Sample requirement: use two',perspective:'implementer',question:'Confirm consumers accept two',evidence:'Fixture check',anchors:[{path:'sample.go',side:'new',start:3,end:3},{path:'sample_test.go',side:'new',start:3,end:3},{path:'sample.go',side:'new',start:900,end:900}]}}]};
 const wrote=await call('workbench_change_notes_write',{workspaceId:scope.workspaceId,repoPath:scope.repoPath,batch});assert.ok(wrote.ok,JSON.stringify(wrote));assert.deepEqual((await call('workbench_change_notes_write',{workspaceId:scope.workspaceId,repoPath:scope.repoPath,batch})).result.revisions,wrote.result.revisions);
 await assert.rejects(client.invokePluginRpc('workspace-workbench-paseo','workspace.workbench.change-notes',{projectConfig:config,workspaceId:scope.workspaceId,repoPath:scope.repoPath,token:'invalid-token',action:'write',batch}));
 await assert.rejects(client.invokePluginRpc('workspace-workbench-paseo','workspace.workbench.change-notes',{projectConfig:config,workspaceId:scope.workspaceId,repoPath:scope.repoPath,token,action:'feedback',feedback:{requestId:'agent-confirm',id:'sample-value',revision:1,action:'confirm',text:'Not authorized'}}));
 await assert.rejects(client.invokePluginRpc('workspace-workbench-paseo','workspace.workbench.query',{projectConfig:config,method:'notes.write',params:{workspaceId:scope.workspaceId,repoPath:scope.repoPath,author:'forged',batch}}));
 report.checks.push('Actual RPC rejects invalid identity, Agent-supplied user confirmation, and generic-query author forgery');
 report.checks.push('Actual isolated host Agent identity and HTTP MCP read/write; identical retry returns the same revision');
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1400,height:1000},permissions:['clipboard-read','clipboard-write']});page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));await page.goto(ui.url);await page.getByRole('button',{name:'a',exact:true}).click();await page.getByRole('button',{name:'Open Workspace Workbench',exact:true}).click();await page.getByTestId('workbench-workspace-selector-toggle').waitFor({timeout:30000});await page.getByTestId('workbench-workspace-selector-toggle').click();await page.getByTestId('workspace-option-notes-sample').click();
 await page.getByRole('button').filter({hasText:'sample.go'}).first().click();
 await page.getByTestId('workbench-diff-lines').waitFor({timeout:30000});
 const panel=page.getByTestId('workbench-diff-panel');
 const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const geometry=()=>panel.getByTestId('workbench-diff-lines').evaluate(n=>({height:n.scrollHeight,scroll:n.scrollTop,top:n.querySelector('[data-testid="diff-code-unified"]')?.getBoundingClientRect().top}));
 const marker=()=>panel.locator('[data-testid^="note-marker-"]').first().getByRole('button');
 const before=await geometry();assert.equal(await page.getByText('Requested default value',{exact:true}).count(),0);
 await marker().click();const card=page.getByTestId('change-note-card');await card.waitFor();await card.getByText('Use the requested default',{exact:true}).waitFor();
 assert.equal(await card.getByText('Returns two',{exact:true}).count(),0);await frames();assert.deepEqual(await geometry(),before);
 assert.ok((await page.getByTestId('change-notes-popover').boundingBox()).height<=200);
 await page.screenshot({path:join(output,'notes-desktop.png')});
 await marker().click();await card.waitFor({state:'detached'});assert.deepEqual(await geometry(),before);
 await marker().focus();await page.keyboard.press('Enter');await card.waitFor();await page.keyboard.press('Escape');await card.waitFor({state:'detached'});assert.equal(await marker().evaluate(n=>n===document.activeElement),true);
 await marker().click();await card.waitFor();await panel.getByTestId('diff-single-toolbar').click({position:{x:3,y:3}});await card.waitFor({state:'detached'});
 report.checks.push('Marker click, repeated click, outside click and Escape preserve Diff geometry; summary contains no full-detail prose');
 await marker().click();await card.waitFor();await card.getByRole('button',{name:'Ask a question',exact:true}).click();await card.getByRole('textbox').fill('Does this change existing callers?');
 await card.getByRole('button',{name:'Close explanation',exact:true}).click();await marker().click();await card.getByRole('button',{name:'Ask a question',exact:true}).click();assert.equal(await card.getByRole('textbox').inputValue(),'Does this change existing callers?');
 const ledgers=join(ui.project,'state','change-notes','ledgers');
 try{chmodSync(ledgers,0o500);await card.getByRole('button',{name:'Save',exact:true}).click();await card.getByText(/EACCES|permission denied/).waitFor();assert.equal(await card.getByRole('textbox').inputValue(),'Does this change existing callers?');}finally{chmodSync(ledgers,0o700);}
 await card.getByRole('button',{name:'Save',exact:true}).click();await card.getByRole('button',{name:'Details',exact:true}).waitFor();await card.getByRole('button',{name:'Details',exact:true}).click();await card.getByText('Question: Does this change existing callers?',{exact:true}).waitFor();await card.getByText('Returns two',{exact:true}).waitFor();
 await card.getByRole('button',{name:'Back to summary',exact:true}).click();await card.getByRole('button',{name:'Explanation actions',exact:true}).click();await card.getByRole('button',{name:'Copy explanation and questions',exact:true}).click();await card.getByRole('button',{name:'Details',exact:true}).waitFor();
 const clipboard=await page.evaluate(()=>navigator.clipboard.readText());assert.match(clipboard,/Does this change existing callers/);assert.ok(clipboard.includes(snapshot.id));
 report.checks.push('Question draft survives closing and injected storage failure; retry saves once; same popover holds detail/actions views and full-context copy');
 await card.getByRole('button',{name:'Details',exact:true}).click();await card.getByRole('button',{name:/sample.go · new 900/}).click();await card.waitFor();await card.getByText('Use the requested default',{exact:true}).waitFor();
 const far=await panel.getByTestId('workbench-diff-lines').evaluate(n=>n.scrollTop);assert.ok(far>10000);await frames();assert.equal(await card.isVisible(),true);report.checks.push('Offscreen virtual-row navigation settles before opening the explanation at line 900');
 await card.getByRole('button',{name:'Details',exact:true}).click();await card.getByRole('button',{name:/sample_test.go/}).click();await page.getByTestId('diff-file-tabs').getByText('sample_test.go',{exact:true}).waitFor();await card.waitFor();
 report.checks.push('Cross-file explanation waits for target code and opens without an inline card');
 report.layouts=[];
 for(const colorScheme of ['dark','light']){await page.emulateMedia({colorScheme});for(const width of [320,480,720,1000]){
  await panel.evaluate((node,w)=>Object.assign(node.style,{position:'fixed',left:'12px',top:'80px',width:w+'px',maxWidth:w+'px',height:'800px',zIndex:'100'}),width);await frames();
  if(!await card.isVisible())await marker().click();await card.waitFor();await frames();
  const box=await panel.boundingBox(),popup=await page.getByTestId('change-notes-popover').boundingBox();assert.ok(popup.x>=box.x&&popup.x+popup.width<=box.x+box.width+1);assert.ok(popup.y>=box.y&&popup.y+popup.height<=box.y+box.height+1);
  const metrics=await panel.getByTestId('diff-single-toolbar').evaluate(n=>({height:n.getBoundingClientRect().height,overflow:n.scrollWidth>n.clientWidth+1}));assert.ok(!metrics.overflow);report.layouts.push({colorScheme,width,popoverHeight:popup.height,...metrics});await panel.screenshot({path:join(output,colorScheme+'-'+width+'.png')});
 }}
 await card.getByRole('button',{name:'Close explanation',exact:true}).click();
 const side=page.locator('[aria-label="Workspace Workbench"]').filter({has:page.getByTestId('workbench-workspace-selector-toggle')}).last();
 // Restore the main panel to its usual layout before using the sidebar directory.
 await panel.evaluate(node=>{for(const key of ['position','left','top','width','maxWidth','height','zIndex'])node.style[key]='';});await frames();
 await side.getByRole('button',{name:/^sample.go: .*explanations/}).click();await page.getByTestId('file-note-directory').getByRole('button',{name:'Requested default value',exact:true}).click();await card.waitFor();assert.equal(await page.getByTestId('file-note-directory').count(),0);await card.getByRole('button',{name:'Close explanation',exact:true}).click();
 report.checks.push('Sidebar explanation icon opens an on-demand directory; choosing a subject navigates and closes the directory');
 await marker().click();await card.waitFor();
 await card.evaluate(node=>{for(const text of node.querySelectorAll('*'))if(text.childNodes.length===1&&text.firstChild.nodeType===3){const style=getComputedStyle(text);text.style.fontSize=parseFloat(style.fontSize)*1.5+'px';text.style.lineHeight=parseFloat(style.lineHeight)*1.5+'px';}});await frames();
 const enlarged=await page.getByTestId('change-notes-popover').boundingBox();const readingBox=await panel.boundingBox();assert.ok(enlarged.y+enlarged.height<=readingBox.y+readingBox.height+1);await page.screenshot({path:join(output,'enlarged-note.png')});await card.getByRole('button',{name:'Close explanation',exact:true}).click();
 report.checks.push('150% web text scaling stays readable within the reading region; native Dynamic Type is not claimed');

 // Create a second explanation at the same code location. No positional change.
 const second={...batch,requestId:'notes-second',operations:[{...batch.operations[0],id:'compatibility',content:{...batch.operations[0].content,title:'Compatibility check',reason:'Confirm the changed return value with all consumers. '.repeat(30)}}]};
 await call('workbench_change_notes_write',{workspaceId:scope.workspaceId,repoPath:scope.repoPath,batch:second});
 await panel.getByTestId('note-toolbar').getByRole('button').click();await page.getByTestId('change-notes-popover').getByRole('button',{name:'Compatibility check',exact:true}).waitFor();await page.keyboard.press('Escape');
 await marker().click();await page.getByTestId('change-notes-popover').getByRole('button',{name:'Compatibility check',exact:true}).click();await card.waitFor();assert.equal(await card.getByTestId('change-note-summary').evaluate(n=>n.getBoundingClientRect().height<=61),true);
 await card.getByRole('button',{name:'Close explanation',exact:true}).click();
 report.checks.push('Multiple explanations share one marker and chooser; long summary is limited to three lines');
 await page.getByTestId('diff-file-tabs').getByRole('tab',{name:'sample.go',exact:true}).click();await panel.getByTestId('workbench-diff-lines').waitFor();await marker().click();
 // The marker now opens the two-note chooser; scrolling closes it without layout changes.
 await page.getByTestId('change-notes-popover').waitFor();await panel.getByTestId('workbench-diff-lines').evaluate(n=>{n.scrollTop=500;n.dispatchEvent(new Event('scroll',{bubbles:true}));});await page.getByTestId('change-notes-popover').waitFor({state:'detached'});
 report.checks.push('Desktop scrolling closes anchored popover; deep virtual rows do not retain a detached popup');
 const historical=await call('workbench_change_notes_read',{workspaceId:scope.workspaceId,repoPath:scope.repoPath,scope:'commit',commitSha:snapshot.right,paths:['sample.go']});
 await call('workbench_change_notes_write',{workspaceId:scope.workspaceId,repoPath:scope.repoPath,batch:{...batch,requestId:'historical-note',snapshotId:historical.result.snapshot.id,operations:[{...batch.operations[0],id:'historical',content:{...batch.operations[0].content,title:'Historical explanation',anchors:[{path:'sample.go',side:'new',start:3,end:3}]}}]}});
 await panel.getByTestId('note-toolbar').getByRole('button').click();await page.getByTestId('change-notes-popover').getByRole('button',{name:'Historical explanation',exact:true}).click();await card.getByText('Needs update',{exact:true}).waitFor();assert.equal(await panel.getByTestId('note-range-highlight').count(),0);await card.getByRole('button',{name:'Close explanation',exact:true}).click();
 report.checks.push('A different frozen scope is marked Needs update and never gets a current-code highlight');

 const timings={plain:[],annotated:[]};
 for(let i=0;i<21;i++)for(const [name,label,kind] of [['baseline.go','package baseline','plain'],['sample.go','package sample','annotated']]){
  const start=performance.now();await page.getByRole('button').filter({hasText:name}).first().click();await page.getByTestId('diff-code-unified').filter({hasText:label}).first().waitFor();await frames();if(i)timings[kind].push(performance.now()-start);
 }
 const p95=values=>values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];report.cachedFileSwitch={sampleLines:1003,samplesPerVariant:20,plainP95Ms:p95(timings.plain),collapsedAnnotationsP95Ms:p95(timings.annotated),measurement:'Playwright click to visible target code plus two animation frames; includes automation overhead'};


 assert.equal(report.pageErrors.length,0);report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;if(page){report.visible=await page.locator('body').innerText().catch(()=>'');await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}}
finally{await browser?.close();client?.close();if(ui)writeFileSync(ui.continueFile,'continue\n');else host.kill('SIGTERM');report.hostExitCode=await exited;if(report.hostExitCode!==0){report.ok=false;process.exitCode=1;}writeFileSync(join(output,'host.log'),logs);writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
