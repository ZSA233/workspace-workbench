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
const output=process.env.WORKBENCH_VERIFY_OUTPUT || '/tmp/workbench-comparison-notes-ui';mkdirSync(output,{recursive:true});
const host=spawn(process.execPath,[join(import.meta.dirname,'verify-live.mjs')],{env:{...process.env,WORKBENCH_LIVE_UI:'1'},stdio:['ignore','pipe','pipe']});
let logs='',ui,client,browser,page;const exited=new Promise(r=>host.once('exit',r));host.stderr.on('data',x=>logs+=x);
const ready=new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('host readiness timeout')),120000);createInterface({input:host.stdout}).on('line',line=>{logs+=line+'\n';try{const x=JSON.parse(line);if(x.kind==='ui-ready'){clearTimeout(timer);yes(x);}}catch{}});void exited.then(code=>{clearTimeout(timer);no(Error(`host exited ${code}`));});});
const report={checks:[],pageErrors:[],consoleErrors:[]};
try{
 ui=await ready;client=new DaemonClient({url:ui.url.replace('http:','ws:')+'/ws',clientId:'notes-ui',clientType:'mcp',reconnect:{enabled:false},webSocketFactory:(u,o)=>new WebSocket(u,o?.protocols,{headers:o?.headers})});await client.connect();
 const config=join(ui.project,'project.json');
 const tree=join(ui.project,'one');const git=(...args)=>execFileSync('git',['-C',tree,...args],{encoding:'utf8'}).trim();
 const base=git('rev-parse','HEAD');
 writeFileSync(join(tree,'sample.go'),'package sample\n\nfunc Value() int { return 2 }\n');git('add','.');git('commit','-qm','Add default');const older=git('rev-parse','HEAD');
 writeFileSync(join(tree,'sample.go'),'package sample\n\nfunc Value() int { return 3 }\n');git('commit','-qam','Revise default');const head=git('rev-parse','HEAD');
 git('update-ref','refs/remotes/origin/main',base);git('branch','feature/sample',head);
 const agent=await client.createAgent({config:{provider:'codex',cwd:ui.project,modeId:'auto',featureValues:{plan_mode:false}}});
 const token=JSON.parse(readFileSync(join(ui.project,'state','orchestration',digest('session:'+agent.id)+'.json'),'utf8')).token;
 const gateway=JSON.parse(readFileSync(join(dirname(ui.continueFile),'paseo','workspace-workbench','gateway.json'),'utf8'));
 const headers={'content-type':'application/json','Authorization':'Bearer '+token,'X-Workbench-Gateway-Key':gateway.key,'X-Workbench-Project':config,'X-Workbench-Role':'interactive'};
 const call=async(name,args)=>{const response=await fetch('http://127.0.0.1:'+gateway.port+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:Math.random().toString(),method:'tools/call',params:{name,arguments:args}})});const body=await response.json();assert.ok(!body.error&&!body.result.isError,JSON.stringify(body));const out=JSON.parse(body.result.content[0].text);assert.ok(out.ok,JSON.stringify(out));return out.result;};
 const scope={workspaceId:'main',repoPath:'one',scope:'compare',paths:['sample.go']};
 const old=await call('workbench_change_notes_read',{...scope,comparison:{fromRef:base,toRef:older,fromLabel:'origin/main',toLabel:'feature/sample',mode:'endpoints'}});
 const content={title:'保留默认值兼容',reason:'根据需求调整默认值，同时让旧调用方式继续可用。',behavior:'默认值更新为三。',basis:'requirement',requirement:'样例需求：调整默认值。',perspective:'implementer',evidence:'隔离样例',anchors:[{path:'sample.go',side:'new',start:3,end:3}]};
 await call('workbench_change_notes_write',{workspaceId:'main',repoPath:'one',batch:{requestId:'old-once',snapshotId:old.snapshot.id,operations:[{id:'default',expectedRevision:0,action:'upsert',content:{...content,behavior:'默认值更新为二。'}}]}});
 const fresh=await call('workbench_change_notes_read',{...scope,comparison:{fromRef:base,toRef:head,fromLabel:'origin/main',toLabel:'feature/sample',mode:'endpoints'}});
 await call('workbench_change_notes_write',{workspaceId:'main',repoPath:'one',batch:{requestId:'new-once',snapshotId:fresh.snapshot.id,operations:[{id:'default',expectedRevision:1,action:'upsert',content},{id:'contract',expectedRevision:0,action:'upsert',content:{...content,title:'调用边界保持不变',question:'需要确认调用者是否接受新默认值。'}}]}});
 report.checks.push('Real host authenticated MCP read/write freezes comparison labels and SHAs, migrates one note and preserves historical revision');
 const catalogInput={projectConfig:config,workspaceId:'main',repoPath:'one',action:'catalog'};
 const catalog=await client.invokePluginRpc('workspace-workbench-paseo','workspace.workbench.change-notes',catalogInput);assert.equal(catalog.result.total,2);
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1500,height:1000},permissions:['clipboard-read','clipboard-write']});page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});await page.emulateMedia({colorScheme:'dark'});
 const business=[];let holdSha='',held=[],notifyHeld;
 await page.routeWebSocket('**/*',socket=>{const server=socket.connectToServer();socket.onMessage(message=>{if(String(message).includes('repository.compare'))business.push(String(message));server.send(message);});server.onMessage(message=>{let matched=false;try{const walk=x=>{if(!x||typeof x!=='object')return;if(x.comparison?.toSha===holdSha&&Array.isArray(x.files)&&x.summary)matched=true;for(const c of Object.values(x))walk(c);};if(holdSha)walk(JSON.parse(String(message)));}catch{}if(matched){held.push(()=>socket.send(message));notifyHeld?.();}else socket.send(message);});});
 await page.goto(ui.url);report.url=page.url();report.title=await page.title();await page.getByRole('button',{name:'a',exact:true}).click();await page.getByRole('button',{name:'Open Workspace Workbench',exact:true}).click();await page.getByTestId('workbench-graph-content').waitFor({timeout:30000});await page.getByRole('button',{name:'比较仓库',exact:true}).click();
 await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(base);await page.getByRole('button',{name:'使用此引用',exact:true}).click();
 const sidebar=page.getByTestId('comparison-sidebar');await sidebar.getByText('sample.go',{exact:true}).waitFor();
 const openDirectory=()=>sidebar.getByRole('button',{name:'比较说明记录 2',exact:true}).click();
 const chooseHead=()=>page.getByRole('button',{name:`打开比较 origin/main 到 feature/sample ${head.slice(0,8)}`,exact:true}).click();
 const chooseOlder=()=>page.getByRole('button',{name:`打开比较 origin/main 到 feature/sample ${older.slice(0,8)}`,exact:true}).click();
 await openDirectory();await page.getByTestId('comparison-note-directory').waitFor();const reads=business.length;
 await page.getByLabel('搜索比较说明',{exact:true}).fill('origin/main');await page.getByRole('button',{name:`打开比较 origin/main 到 feature/sample ${older.slice(0,8)}`,exact:true}).waitFor();assert.equal(business.length,reads);
 await page.getByLabel('搜索比较说明',{exact:true}).fill('not-present');await page.getByText('没有匹配的比较说明',{exact:true}).waitFor();
 await page.getByLabel('搜索比较说明',{exact:true}).fill('');await chooseHead();await sidebar.getByTestId('comparison-to').filter({hasText:head.slice(0,7)}).waitFor();await sidebar.getByText('sample.go',{exact:true}).click();
 await page.getByTestId('workbench-diff-lines').waitFor({timeout:30000});await page.getByTestId('workbench-diff-panel').locator('[data-testid^="note-marker-"]').first().getByRole('button').click();await page.getByRole('button',{name:'保留默认值兼容',exact:true}).click();await page.getByTestId('change-note-card').getByText(content.reason,{exact:true}).waitFor();
 await page.screenshot({path:join(output,'compare-note-diff.png')});await page.getByRole('button',{name:/^(关闭说明|Close explanation)$/,exact:true}).last().click();
 report.checks.push('Directory -> frozen comparison -> file -> main Diff marker opens correct note; search and directory do not request Git');
 await openDirectory();await page.screenshot({path:join(output,'directory-natural.png')});await page.getByRole('button',{name:'复制本次比较的说明请求',exact:true}).click();await page.getByText('已复制说明请求',{exact:true}).waitFor();const copied=await page.evaluate(()=>navigator.clipboard.readText());assert.ok(copied.includes(base)&&copied.includes(head)&&copied.includes('fromLabel'));
 await page.getByRole('button',{name:`查看比较说明 ${older.slice(0,8)}`,exact:true}).click();await page.getByRole('button',{name:'保留默认值兼容 · 历史修订',exact:true}).click();const card=page.getByTestId('change-note-card');await card.getByText(/历史修订 v1|Historical revision v1/).waitFor();await card.getByRole('button',{name:/Explanation actions|说明操作/}).click();assert.equal(await card.getByRole('button',{name:/^Edit explanation$|^编辑说明$/}).count(),0);await card.getByRole('button',{name:/Back to summary|返回简短说明/}).click();await card.getByRole('button',{name:/View latest revision|查看最新版本/}).click();await card.getByText(content.reason,{exact:true}).waitFor();
 await page.getByRole('button',{name:'关闭比较设置',exact:true}).last().click();await openDirectory();
 // Hold a real old comparison response: old file and label remain until the chosen snapshot is ready.
 holdSha=older;const heldReady=new Promise(r=>notifyHeld=r);await chooseOlder();await heldReady;assert.ok((await sidebar.getByTestId('comparison-to').innerText()).includes(head.slice(0,7)));
 holdSha='';for(const release of held)release();held=[];await sidebar.getByTestId('comparison-to').filter({hasText:older.slice(0,7)}).waitFor();await sidebar.getByRole('button',{name:'历史比较版本',exact:true}).waitFor();
 report.checks.push('Fixed historical selection retains previous content while loading; old revision is read-only and latest revision is reachable');
 const frames=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));report.layouts=[];
 for(const colorScheme of ['dark','light']){
  await page.emulateMedia({colorScheme});
  if(colorScheme==='light'){await page.getByTestId('workbench-graph-content').waitFor();await page.getByRole('button',{name:'比较仓库',exact:true}).click();await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(base);await page.getByRole('button',{name:'使用此引用',exact:true}).click();await sidebar.getByText('sample.go',{exact:true}).waitFor();}
  for(const width of [320,480,720]){
   await sidebar.evaluate((element,width)=>Object.assign(element.style,{position:'fixed',top:'120px',right:'4px',bottom:'8px',width:`${width}px`,maxWidth:`${width}px`,minWidth:`${width}px`,zIndex:'1',backgroundColor:getComputedStyle(document.body).backgroundColor}),width);await frames();
   const metrics=await sidebar.evaluate(n=>({height:n.querySelector('[data-testid="comparison-controls"]').getBoundingClientRect().height,overflow:n.scrollWidth>n.clientWidth+1}));assert.ok(metrics.height<=150&&!metrics.overflow,JSON.stringify(metrics));report.layouts.push({colorScheme,width,...metrics});
   await openDirectory();await page.getByTestId('comparison-note-directory').waitFor();await frames();report.layouts.at(-1).popover=await page.getByTestId('comparison-popover').evaluate(n=>{const b=n.getBoundingClientRect(),hit=document.elementFromPoint(b.x+20,b.y+20);return {visibleAtCenter:n.contains(hit),width:b.width,height:b.height};});assert.ok(report.layouts.at(-1).popover.visibleAtCenter,'Popover must be above the sidebar');await page.screenshot({path:join(output,`${colorScheme}-${width}.png`)});await page.getByRole('button',{name:'关闭比较设置',exact:true}).last().click();
  }
 }
 assert.equal(report.pageErrors.length,0);report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;if(page){report.visible=await page.locator('body').innerText().catch(()=>'');await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}}
finally{await browser?.close();client?.close();if(ui)writeFileSync(ui.continueFile,'continue\n');else host.kill('SIGTERM');report.hostExitCode=await exited;if(report.hostExitCode!==0){report.ok=false;process.exitCode=1;}writeFileSync(join(output,'host.log'),logs);writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
