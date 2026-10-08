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
const output=process.env.WORKBENCH_VERIFY_OUTPUT || '/tmp/workbench-continuous-ui';mkdirSync(output,{recursive:true});
const host=spawn(process.execPath,[join(import.meta.dirname,'verify-live.mjs')],{env:{...process.env,WORKBENCH_LIVE_UI:'1'},detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
let logs='',ui,client,browser,page;const exited=new Promise(r=>host.once('exit',r));host.stderr.on('data',x=>logs+=x);
const ready=new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('host readiness timeout')),120000);createInterface({input:host.stdout}).on('line',line=>{logs+=line+'\n';try{const x=JSON.parse(line);if(x.kind==='ui-ready'){clearTimeout(timer);yes(x);}}catch{}});void exited.then(code=>{clearTimeout(timer);no(Error(`host exited ${code}`));});});
const report={checks:[],pageErrors:[],consoleErrors:[]};
try{
 ui=await ready;client=new DaemonClient({url:ui.url.replace('http:','ws:')+'/ws',clientId:'notes-ui',clientType:'mcp',reconnect:{enabled:false},webSocketFactory:(u,o)=>new WebSocket(u,o?.protocols,{headers:o?.headers})});await client.connect();
 const config=join(ui.project,'project.json');
 const tree=join(ui.project,'one'),git=(...args)=>execFileSync('git',['-C',tree,...args],{encoding:'utf8'}).trim();
 const lines=Array.from({length:500},(_,i)=>`// source context ${i+1}`);writeFileSync(join(tree,'alpha.go'),lines.join('\n')+'\n');writeFileSync(join(tree,'beta.ts'),'export const count = 1;\n');writeFileSync(join(tree,'gamma.json'),'{"count":1}\n');git('add','.');git('commit','-qm','baseline');const base=git('rev-parse','HEAD');
 lines[249]='const requested = 2 // '+ 'long readable context '.repeat(8);writeFileSync(join(tree,'alpha.go'),lines.join('\n')+'\n');writeFileSync(join(tree,'beta.ts'),'export const count = 2;\n');writeFileSync(join(tree,'gamma.json'),'{"count":2}\n');for(let i=0;i<25;i++)writeFileSync(join(tree,`later-${String(i).padStart(2,'0')}.txt`),i===24?Array.from({length:200},(_,n)=>`last delayed content ${n}`).join('\n')+'\n':'later sample\n');git('add','.');git('commit','-qm','final changes');const head=git('rev-parse','HEAD');
 const agent=await client.createAgent({config:{provider:'codex',cwd:ui.project,modeId:'auto',featureValues:{plan_mode:false}}});
 const token=JSON.parse(readFileSync(join(ui.project,'state','orchestration',digest('session:'+agent.id)+'.json'),'utf8')).token;
 const gateway=JSON.parse(readFileSync(join(dirname(ui.continueFile),'paseo','workspace-workbench/gateway.json'),'utf8'));
 const headers={'content-type':'application/json','Authorization':'Bearer '+token,'X-Workbench-Gateway-Key':gateway.key,'X-Workbench-Project':config,'X-Workbench-Role':'interactive'};
 const call=async(name,args)=>{const response=await fetch('http://127.0.0.1:'+gateway.port+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:Math.random().toString(),method:'tools/call',params:{name,arguments:args}})});const body=await response.json();assert.ok(!body.error&&!body.result.isError,JSON.stringify(body));const out=JSON.parse(body.result.content[0].text);assert.ok(out.ok,JSON.stringify(out));return out.result;};
 const scope={workspaceId:'main',repoPath:'one',scope:'compare',comparison:{fromRef:base,toRef:head},paths:['alpha.go','beta.ts']};
 const snapshot=(await call('workbench_change_notes_read',scope)).snapshot;
 await call('workbench_change_notes_write',{workspaceId:'main',repoPath:'one',batch:{requestId:'continuous-notes',snapshotId:snapshot.id,operations:[{id:'context-note',expectedRevision:0,action:'upsert',content:{title:'Hidden context explanation',reason:'Retain the surrounding behavior while changing the default',behavior:'Default becomes two',basis:'requirement',requirement:'Sample requirement',perspective:'implementer',anchors:[{path:'alpha.go',side:'new',start:190,end:190},{path:'beta.ts',side:'new',start:1,end:1}]}}]}});
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1600,height:1050},permissions:['clipboard-read','clipboard-write']});page=await context.newPage();await page.addInitScript(()=>{window.__commits=0;window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject:()=>1,onCommitFiberRoot:()=>window.__commits++,onCommitFiberUnmount:()=>{}};});page.on('pageerror',e=>report.pageErrors.push(e.message));page.on('console',e=>{if(e.type()==='error'&&!e.text().startsWith('workbench_client_diagnostic '))report.consoleErrors.push(e.text());});await page.emulateMedia({colorScheme:'dark'});
 const requests=report.requests=[],statuses=report.readStatuses=[],activeReads=new Set();let holdPath='',held=[],heldReady,failPath='later-22.txt';report.maxConcurrentReads=0;
 await page.routeWebSocket('**/*',socket=>{const server=socket.connectToServer();socket.onMessage(message=>{
  try{const walk=o=>{if(!o||typeof o!=='object')return;if(o.method==='repository.diff.read'){
   const p=o.params;if(p?.action==='start'){requests.push(p);activeReads.add(p.requestId);report.maxConcurrentReads=Math.max(report.maxConcurrentReads,activeReads.size);}else if(p?.action==='release')activeReads.delete(p.requestId);
  }for(const child of Object.values(o))walk(child);};walk(JSON.parse(String(message)));}catch{}server.send(message);
 });server.onMessage(message=>{
  let parsed,hold=false,changed=false;const completed=[];
  try{parsed=JSON.parse(String(message));const walk=o=>{if(!o||typeof o!=='object')return;
   if(o.protocol===1&&o.taskId)statuses.push({request:o.requestId,state:o.state,lines:o.result?.lines?.length,start:o.result?.lines?.[0]?.oldLine,error:o.error?.code});
   if(o.protocol===1&&o.taskId&&['ready','failed','cancelled'].includes(o.state)){
    completed.push(o.requestId);if(o.result?.path===holdPath)hold=true;
    if(failPath&&o.result?.path===failPath){o.state='failed';o.error={code:'ui_injected_file_failure',message:'Sample file unavailable'};delete o.result;changed=true;}
   }for(const child of Object.values(o))walk(child);};walk(parsed);
  }catch{}const send=()=>{for(const id of completed)activeReads.delete(id);socket.send(changed?JSON.stringify(parsed):message);};if(hold){held.push(send);heldReady?.();}else send();
 });});
 await page.goto(ui.url);await page.getByRole('button',{name:'a',exact:true}).click();await page.getByRole('button',{name:'Open Workspace Workbench',exact:true}).click();await page.getByTestId('workbench-graph-content').waitFor({timeout:30000});await page.getByRole('button',{name:'比较仓库',exact:true}).click();await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(base);await page.getByRole('button',{name:'使用此引用',exact:true}).click();const sidebar=page.getByTestId('comparison-sidebar');await sidebar.getByText('alpha.go',{exact:true}).waitFor();
 const started=Date.now();await sidebar.getByText('alpha.go',{exact:true}).click();const panel=page.getByTestId('workbench-diff-panel');await panel.getByRole('tab',{name:'整组差异',exact:true}).waitFor({timeout:30000});await panel.getByTestId('diff-code-unified').filter({hasText:'requested'}).waitFor({timeout:30000});report.firstScreenMs=Date.now()-started;
 assert.equal(await panel.getByTestId('workbench-diff-lines').count(),1);assert.ok(!requests.some(r=>r.path==='later-24.txt'),'offscreen tail must not be prefetched');await page.screenshot({path:join(output,'initial.png')});
 const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 // A directory jump expands only the hidden note location from the canonical patch.
 await panel.getByRole('button',{name:/Change explanations 1|改动说明 1/}).first().click();await page.getByTestId('change-notes-popover').getByRole('button',{name:'Hidden context explanation',exact:true}).click();await page.getByTestId('change-note-card').waitFor();await panel.getByTestId('diff-code-unified').filter({hasText:'source context 190'}).waitFor();await page.getByRole('button',{name:/Close explanation|关闭说明/}).last().click();
 await panel.getByTestId('comparison-sticky-file').getByRole('button',{name:'文件设置 alpha.go',exact:true}).click();await page.getByRole('button',{name:'收起上下文',exact:true}).click();
 const code=panel.getByTestId('diff-code-unified').filter({hasText:'requested'});await code.waitFor();await frames();const before=(await code.boundingBox()).y;
 const expandStarted=Date.now();await panel.getByRole('button',{name:'向前展开 20 行',exact:true}).first().click();await panel.getByTestId('diff-code-unified').filter({hasText:'source context 230'}).waitFor();await frames();const after=(await code.boundingBox()).y;report.expandMs=Date.now()-expandStarted;report.anchorDelta=after-before;assert.ok(Math.abs(after-before)<=2,`Expansion moved the code by ${after-before}px`);

 await panel.getByTestId('comparison-sticky-file').getByRole('button',{name:'文件设置 alpha.go',exact:true}).click();await page.getByRole('button',{name:'展开全部上下文',exact:true}).click();await panel.getByTestId('diff-code-unified').filter({hasText:'source context 249'}).waitFor();await panel.getByTestId('comparison-sticky-file').getByTestId('comparison-context-loading').waitFor();await panel.getByTestId('comparison-sticky-file').getByTestId('comparison-context-loading').waitFor({state:'hidden'});await frames();report.contextRequests=requests.filter(r=>r.readKind==='context').length;report.expandedDocumentHeight=await panel.getByTestId('workbench-diff-lines').evaluate(n=>n.scrollHeight);assert.ok(report.expandedDocumentHeight>11000,`Whole-file expansion incomplete: ${report.expandedDocumentHeight}`);
 await sidebar.getByText('beta.ts',{exact:true}).click();await panel.getByTestId('comparison-sticky-file').filter({hasText:'beta.ts'}).waitFor();await panel.getByTestId('diff-code-unified').filter({hasText:'export const count'}).first().waitFor();assert.equal(await panel.getByRole('tab',{name:'整组差异',exact:true}).count(),1);
 await panel.getByTestId('comparison-sticky-file').getByRole('button',{name:'单独打开 beta.ts',exact:true}).click();await panel.getByRole('tab',{name:'beta.ts',exact:true}).waitFor();await panel.getByRole('tab',{name:'整组差异',exact:true}).click();await panel.getByTestId('comparison-sticky-file').filter({hasText:'beta.ts'}).waitFor();
 report.cacheSwitchMs=[];
 for(let i=0;i<10;i++){await panel.getByRole('tab',{name:'beta.ts',exact:true}).click();const start=Date.now();await panel.getByRole('tab',{name:'整组差异',exact:true}).click();await panel.getByTestId('comparison-sticky-file').filter({hasText:'beta.ts'}).waitFor();report.cacheSwitchMs.push(Date.now()-start);}
 report.cacheSwitchP95Ms=report.cacheSwitchMs.slice().sort((a,b)=>a-b)[Math.ceil(report.cacheSwitchMs.length*.95)-1];
 report.checks.push('Compare opens one continuous tab; file selection jumps within it; a separate file tab reuses the existing viewer');
 await sidebar.getByText('alpha.go',{exact:true}).click();await panel.getByTestId('comparison-sticky-file').filter({hasText:'alpha.go'}).waitFor();
 await panel.getByRole('button',{name:/Change explanations 1|改动说明 1/}).first().click();await page.getByTestId('change-notes-popover').getByRole('button',{name:'Hidden context explanation',exact:true}).click();await page.getByTestId('change-note-card').waitFor();await page.getByRole('button',{name:/Close explanation|关闭说明/}).last().click();
 await panel.getByRole('button',{name:/Change explanations 1|改动说明 1/}).first().click();await page.getByTestId('change-notes-popover').getByRole('button',{name:'Hidden context explanation',exact:true}).click();await page.getByTestId('change-note-card').getByRole('button',{name:'Details',exact:true}).click();await page.getByTestId('change-note-card').getByRole('button',{name:'beta.ts · new 1–1',exact:true}).click();await panel.getByTestId('comparison-sticky-file').filter({hasText:'beta.ts'}).waitFor();await page.getByTestId('change-note-card').waitFor();await page.getByRole('button',{name:/Close explanation|关闭说明/}).last().click();
 await sidebar.getByText('alpha.go',{exact:true}).click();await panel.getByTestId('comparison-sticky-file').filter({hasText:'alpha.go'}).waitFor();
 await page.screenshot({path:join(output,'context-and-notes.png')});await panel.getByTestId('comparison-sticky-file').getByRole('button',{name:'文件设置 alpha.go',exact:true}).click();await page.getByRole('button',{name:'收起上下文',exact:true}).click();
 for(const theme of ['dark','light']){await page.emulateMedia({colorScheme:theme});if(theme==='light'){await page.getByTestId('workbench-graph-content').waitFor();await page.getByRole('button',{name:'比较仓库',exact:true}).click();await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(base);await page.getByRole('button',{name:'使用此引用',exact:true}).click();await sidebar.getByText('alpha.go',{exact:true}).click();}
  await panel.getByTestId('diff-code-unified').filter({hasText:'requested'}).waitFor();await frames();await page.screenshot({path:join(output,`${theme}-wide.png`)});
 }

 // A held, offscreen file cannot take over a later selection; a failed file is local.
 holdPath='later-24.txt';const blocked=new Promise(resolve=>heldReady=resolve);
 await sidebar.getByText(holdPath,{exact:true}).click();await blocked;
 if(process.env.WORKBENCH_VERIFY_RAIL==='1'){
  const rail=panel.getByTestId('diff-overview-rail'),r=await rail.boundingBox(),t=await panel.getByTestId('diff-overview-thumb').boundingBox();await page.mouse.move(r.x+r.width-4,t.y+t.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width-4,t.y+t.height/2-20,{steps:3});
  const frozenHeight=await panel.getByTestId('workbench-diff-lines').evaluate(n=>n.scrollHeight),commits=await page.evaluate(()=>window.__commits);
  holdPath='';for(const send of held)send();held=[];await page.waitForFunction(before=>window.__commits>before,commits);await frames();await frames();assert.equal(await panel.getByTestId('workbench-diff-lines').evaluate(n=>n.scrollHeight),frozenHeight,'arrival must not change drag mapping');await page.mouse.up();
  await page.waitForFunction(before=>document.querySelector('[data-testid="workbench-diff-lines"]').scrollHeight>before+1000,frozenHeight);report.checks.push('A delayed body arriving during rail drag is published after release; drag mapping stays fixed');
 }

 await sidebar.getByText('alpha.go',{exact:true}).click();await panel.getByTestId('comparison-sticky-file').filter({hasText:'alpha.go'}).waitFor();
 holdPath='';for(const send of held)send();held=[];await frames();await panel.getByTestId('comparison-sticky-file').filter({hasText:'alpha.go'}).waitFor();
 await sidebar.getByText('later-22.txt',{exact:true}).click();await panel.getByText('Sample file unavailable · 重试',{exact:true}).waitFor();
 await sidebar.getByText('beta.ts',{exact:true}).click();await panel.getByTestId('diff-code-unified').filter({hasText:'export const count'}).first().waitFor();
 failPath='';await sidebar.getByText('later-22.txt',{exact:true}).click();await panel.getByRole('button',{name:'Sample file unavailable · 重试',exact:true}).click();await page.waitForFunction(()=>{const file=document.querySelector('[data-testid="comparison-file-later-22.txt"]'),list=document.querySelector('[data-testid="workbench-diff-lines"]');if(!file||!list)return false;const a=file.getBoundingClientRect(),b=list.getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom;});await panel.getByTestId('diff-code-unified').filter({hasText:'later sample'}).first().waitFor();
 await sidebar.getByText('alpha.go',{exact:true}).click();await panel.getByTestId('comparison-sticky-file').filter({hasText:'alpha.go'}).waitFor();

 await sidebar.getByRole('button',{name:'搜索变化文件',exact:true}).click();await sidebar.getByRole('textbox',{name:'搜索变化文件',exact:true}).fill('alpha');assert.equal(await sidebar.getByText('beta.ts',{exact:true}).count(),0);assert.match(await panel.getByTestId('diff-hunk-count').innerText(),/\/28/);await sidebar.getByRole('button',{name:'关闭文件搜索',exact:true}).click();
 await panel.getByTestId('comparison-sticky-file').getByRole('button',{name:'折叠 alpha.go',exact:true}).click();assert.equal(await panel.getByTestId('diff-code-unified').filter({hasText:'requested'}).count(),0);await panel.getByTestId('comparison-file-alpha.go').getByRole('button',{name:'展开 alpha.go',exact:true}).press('Enter');await panel.getByTestId('diff-code-unified').filter({hasText:'requested'}).waitFor();
 report.checks.push('Offscreen reads are bounded; delayed results do not steal selection; one file failure and retry preserve the rest');
 report.layouts=[];
 for(const width of [320,480,720,1000]){
  await panel.evaluate((node,width)=>Object.assign(node.style,{position:'fixed',left:'12px',top:'80px',width:width+'px',height:'760px',zIndex:'100'}),width);await frames();
  const measured=await panel.evaluate(node=>{const toolbar=node.querySelector('[data-testid="diff-single-toolbar"]');return {width:node.getBoundingClientRect().width,toolbarHeight:toolbar.getBoundingClientRect().height,overflow:toolbar.scrollWidth>toolbar.clientWidth+1,lists:node.querySelectorAll('[data-testid="workbench-diff-lines"]').length};});
  assert.equal(measured.overflow,false);assert.equal(measured.lists,1);report.layouts.push(measured);await panel.screenshot({path:join(output,`light-${width}.png`)});
 }
 await panel.getByRole('button',{name:/Use split review|切换为双栏审核/}).click();await panel.getByTestId('diff-code-left').first().waitFor();await panel.getByRole('button',{name:/Use unified review|切换为单栏审核/}).click();await panel.getByTestId('diff-code-unified').filter({hasText:'requested'}).waitFor();
 await panel.evaluate(node=>{node.style.width='320px';});await frames();await panel.getByRole('button',{name:'Diff reading settings',exact:true}).click();const menu=page.getByTestId('diff-reading-popover');await menu.getByRole('button',{name:'18px',exact:true}).click();await menu.getByRole('button',{name:'Wrap lines',exact:true}).click();await menu.getByRole('button',{name:'Close Diff settings',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid="diff-code-unified"]')].some(n=>n.textContent.includes('requested')&&n.getBoundingClientRect().height>80&&n.getBoundingClientRect().height<700));
 report.wrap=await code.evaluate(n=>({height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width}));await panel.screenshot({path:join(output,'light-320-wrapped.png')});
 const copied=await code.evaluate(node=>{const selection=document.getSelection(),range=document.createRange();range.selectNodeContents(node);selection.removeAllRanges();selection.addRange(range);const data=new DataTransfer();document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));selection.removeAllRanges();return data.getData('text/plain');});assert.ok(copied.startsWith('const requested = 2'));report.copiedCodeOnly=true;
 report.checks.push('Responsive widths retain one toolbar and one list; split/unified, font size, wrapping and code-only copy remain usable');
 assert.ok(report.maxConcurrentReads<=2,`Read concurrency exceeded two: ${report.maxConcurrentReads}`);

 assert.equal(report.pageErrors.length,0,JSON.stringify(report.pageErrors));assert.equal(report.consoleErrors.length,0,JSON.stringify(report.consoleErrors));report.startedPaths=[...new Set(requests.map(r=>r.path))];report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;if(page){report.header=await page.getByTestId('comparison-sticky-file').evaluate(n=>n.outerHTML).catch(()=>'');report.visible=await page.locator('body').innerText().catch(()=>'');await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}}
finally{await browser?.close();client?.close();if(ui)writeFileSync(ui.continueFile,'continue\n');else if(process.platform!=='win32')process.kill(-host.pid,'SIGTERM');else host.kill('SIGTERM');report.hostExitCode=await exited;if(report.hostExitCode!==0){report.ok=false;process.exitCode=1;}writeFileSync(join(output,'host.log'),logs);writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
