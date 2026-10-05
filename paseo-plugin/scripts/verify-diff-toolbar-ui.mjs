/** Real isolated Paseo renderer; provenance fixtures do not touch normal records. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import {backendRequest} from '../server/backend-supervisor.ts';
const output=process.env.WORKBENCH_VERIFY_OUTPUT || '/tmp/workbench-diff-toolbar-ui';mkdirSync(output,{recursive:true});
const host=spawn(process.execPath,[join(process.env.WORKBENCH_VERIFY_PLUGIN||join(import.meta.dirname,'..'),'scripts/verify-live.mjs')],{env:{...process.env,WORKBENCH_LIVE_UI:'1'},stdio:['ignore','pipe','pipe']});
let logs='',ui,client,browser,page;const exited=new Promise(r=>host.once('exit',r));host.stderr.on('data',x=>logs+=x);
const ready=new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('host readiness timeout')),120000);createInterface({input:host.stdout}).on('line',line=>{logs+=line+'\n';try{const x=JSON.parse(line);if(x.kind==='ui-ready'){clearTimeout(timer);yes(x);}}catch{}});void exited.then(code=>{clearTimeout(timer);no(Error(`host exited ${code}`));});});
const report={checks:[],pageErrors:[]};
const baseline=process.env.WORKBENCH_DIFF_BASELINE==='1';
try{
 ui=await ready;client=new DaemonClient({url:ui.url.replace('http:','ws:')+'/ws',clientId:'diff-toolbar-ui',clientType:'mcp',reconnect:{enabled:false},webSocketFactory:(u,o)=>new WebSocket(u,o?.protocols,{headers:o?.headers})});await client.connect();
 await client.createAgent({config:{provider:'codex',cwd:ui.project,modeId:'auto',featureValues:{plan_mode:false}}});
 const git=(...args)=>execFileSync('git',['-C',join(ui.project,'one'),...args],{encoding:'utf8'}).trim();
 const original=Array.from({length:540},(_,i)=>`// line ${i+1}: stable source context`).join('\n')+'\n';
 for(const path of ['compare.go','alpha/item.go','beta/item.go']){mkdirSync(join(ui.project,'one',path.includes('/')?path.split('/')[0]:'.'),{recursive:true});writeFileSync(join(ui.project,'one',path),original);}
 writeFileSync(join(ui.project,'one','asset.bin'),Buffer.from([0,1,2]));writeFileSync(join(ui.project,'one','mode.go'),'package sample\n');git('add','.');git('commit','-qm','test: initial reading fixture');const base=git('rev-parse','HEAD');
 const changed=original.replace('line 10:', 'CHANGED 10:').replace('line 270:', 'CHANGED 270:').replace('line 530:', 'CHANGED 530:');
 for(const path of ['compare.go','alpha/item.go','beta/item.go'])writeFileSync(join(ui.project,'one',path),changed);
 writeFileSync(join(ui.project,'one','asset.bin'),Buffer.from([0,1,3]));chmodSync(join(ui.project,'one','mode.go'),0o755);git('add','.');git('commit','-qm','test: three separate changes');const head=git('rev-parse','HEAD');
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1500,height:1000}});page.on('pageerror',e=>report.pageErrors.push(e.message));
 let holdPath='',held=[],notifyHeld;
 await page.routeWebSocket('**/*',socket=>{const server=socket.connectToServer();socket.onMessage(message=>server.send(message));server.onMessage(message=>{let matched=false;try{const visit=value=>{if(!value||typeof value!=='object')return;if(value.path===holdPath&&typeof value.patch==='string')matched=true;for(const child of Object.values(value))visit(child);};if(holdPath)visit(JSON.parse(String(message)));}catch{}if(matched){held.push(()=>socket.send(message));notifyHeld?.();}else socket.send(message);});});
 const business=[];page.on('websocket',socket=>socket.on('framesent',({payload})=>{if(/repository.diff|repository.compare/.test(String(payload)))business.push(String(payload));}));
 const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const openDiff=async()=>{
   await page.goto(ui.url);await page.getByRole('button',{name:'a',exact:true}).click();await page.getByRole('button',{name:'Open Workspace Workbench',exact:true}).click();await page.getByTestId('workbench-graph-content').waitFor({timeout:30000});
   await page.getByRole('button',{name:'比较仓库',exact:true}).click();await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(base);await page.getByRole('button',{name:'使用此引用',exact:true}).click();
   await page.getByTestId('comparison-to').click();await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(head);await page.getByRole('button',{name:'使用此引用',exact:true}).click();
   await page.getByTestId('comparison-sidebar').getByText('compare.go',{exact:true}).click();await page.getByTestId('workbench-diff-lines').waitFor({timeout:30000});
 };
 report.layouts=[];
 for(const colorScheme of ['dark','light']){
   await page.emulateMedia({colorScheme});await openDiff();
   const panel=baseline?page.locator('[aria-label="Workspace Changes"]').filter({has:page.getByTestId('workbench-diff-lines')}).last():page.getByTestId('workbench-diff-panel');
   for(const width of [320,480,720,1000]){
    await panel.evaluate((node,width)=>Object.assign(node.style,{position:'fixed',left:'12px',top:'80px',width:width+'px',height:'700px',zIndex:'100'}),width);await frames();
    const metrics=await panel.evaluate(node=>{const box=node.getBoundingClientRect(),list=node.querySelector('[data-testid="workbench-diff-lines"]'),toolbar=node.querySelector('[data-testid="diff-single-toolbar"]');return {width:box.width,controlsHeight:list.getBoundingClientRect().top-box.top,toolbarHeight:toolbar?.getBoundingClientRect().height,overflow:toolbar?toolbar.scrollWidth>toolbar.clientWidth+1:false,visibleCodeRows:Array.from(list.querySelectorAll('[data-testid="diff-code-unified"]')).filter(row=>{const r=row.getBoundingClientRect();return r.top>=list.getBoundingClientRect().top&&r.bottom<=box.bottom;}).length};});
    if(!baseline){assert.ok(metrics.toolbarHeight<=36,JSON.stringify(metrics));assert.equal(metrics.overflow,false);assert.equal(await panel.getByTestId('diff-short-range').count(),width>=720?1:0);}
    report.layouts.push({colorScheme,...metrics});await panel.screenshot({path:join(output,`${colorScheme}-${width}.png`)});
   }
   if(!baseline){
    const secondMarker=panel.getByTestId('diff-overview-marker-1');await secondMarker.click();
    await page.waitForFunction(()=>{const list=document.querySelector('[data-testid="workbench-diff-lines"]'),top=list.getBoundingClientRect().top;const first=[...list.querySelectorAll('[data-testid="diff-code-unified"]')].find(n=>n.getBoundingClientRect().bottom>top+1);return first?.textContent.includes('270');});
    await panel.getByTestId('diff-overview-marker-0').click();
    await page.waitForFunction(()=>{const list=document.querySelector('[data-testid="workbench-diff-lines"]'),top=list.getBoundingClientRect().top;const first=[...list.querySelectorAll('[data-testid="diff-code-unified"]')].find(n=>n.getBoundingClientRect().bottom>top+1);return first?.textContent.includes('10:');});
    report.checks.push(`${colorScheme}: overview clicks align the exact changed row rather than the hunk header`);
    const before=business.length;await panel.getByRole('button',{name:'Diff reading settings',exact:true}).click();const menu=page.getByTestId('diff-reading-popover');await menu.waitFor();await menu.getByRole('button',{name:'Comparison details',exact:true}).click();await menu.getByText(base,{exact:true}).first().waitFor();await menu.getByText(head,{exact:true}).first().waitFor();
    const colors=await menu.evaluate(node=>Array.from(node.querySelectorAll('*')).filter(n=>n.childNodes.length===1&&n.firstChild.nodeType===3).map(n=>getComputedStyle(n).color));if(colorScheme==='dark')assert.ok(colors.every(c=>c!=='rgb(0, 0, 0)'));await menu.screenshot({path:join(output,`details-${colorScheme}.png`)});
    await menu.getByRole('button',{name:'Close Diff settings',exact:true}).click();await frames();assert.equal(business.length,before,'menus must not trigger business reads');
    await panel.evaluate(node=>{node.style.width='320px';});await frames();await panel.getByTestId('diff-horizontal-scroll').evaluate(node=>{node.scrollLeft=80;});
    await panel.getByRole('button',{name:'Diff reading settings',exact:true}).click();await menu.getByRole('button',{name:'16px',exact:true}).click();await menu.getByRole('button',{name:'Wrap lines',exact:true}).click();await menu.getByRole('button',{name:'Close Diff settings',exact:true}).click();
    await page.waitForFunction(()=>{const node=document.querySelector('[data-testid="diff-code-unified"]');return node&&node.getBoundingClientRect().height>30&&node.getBoundingClientRect().height<200;});
    const wrapMetrics=await panel.evaluate(node=>{const list=node.querySelector('[data-testid="workbench-diff-lines"]'),bounds=list.getBoundingClientRect(),rows=[...list.querySelectorAll('[data-testid="diff-code-unified"]')].filter(row=>{const r=row.getBoundingClientRect();return r.top>=bounds.top&&r.bottom<=bounds.bottom;});return {visibleRows:rows.length,maxRowHeight:Math.max(...rows.map(row=>row.getBoundingClientRect().height)),horizontalOffset:node.querySelector('[data-testid="diff-horizontal-scroll"]').scrollLeft};});
    assert.ok(wrapMetrics.visibleRows>=4&&wrapMetrics.maxRowHeight<200,JSON.stringify(wrapMetrics));assert.equal(wrapMetrics.horizontalOffset,0);report['wrap-'+colorScheme]=wrapMetrics;await panel.screenshot({path:join(output,`wrapped-${colorScheme}-320.png`)});
    await panel.getByRole('button',{name:'Diff reading settings',exact:true}).click();await menu.getByRole('button',{name:'14px',exact:true}).click();await menu.getByRole('button',{name:'Disable line wrapping',exact:true}).click();await menu.getByRole('button',{name:'Close Diff settings',exact:true}).click();

    await panel.evaluate(node=>{node.style.width='1000px';});await frames();
    const count=panel.getByTestId('diff-hunk-count');await panel.getByRole('button',{name:'Next change hunk',exact:true}).click();await count.filter({hasText:'2 / 3'}).waitFor();
    const scrollTop=()=>panel.getByTestId('workbench-diff-lines').evaluate(node=>Math.max(...[node,...node.querySelectorAll('*')].map(n=>n.scrollTop||0)));
    // Wait for actual scroll completion using scrollend or two unchanged animation frames.
    await page.evaluate(()=>new Promise((resolve,reject)=>{const deadline=performance.now()+5000;let stable=0,previous=-1;const tick=()=>{const node=document.querySelector('[data-testid="workbench-diff-lines"]');const top=Math.max(...[node,...node.querySelectorAll('*')].map(n=>n.scrollTop||0));stable=top===previous?stable+1:0;previous=top;if(stable>=4&&top>0)resolve();else if(performance.now()>deadline)reject(Error('scroll did not settle'));else requestAnimationFrame(tick);};tick();}));
    const beforeScroll=await scrollTop();assert.ok(beforeScroll>0);
    await panel.getByRole('button',{name:'Diff reading settings',exact:true}).click();await menu.getByRole('button',{name:'Close Diff settings',exact:true}).click();assert.ok(Math.abs(await scrollTop()-beforeScroll)<2,'menu preserves code position');
    await page.getByTestId('comparison-sidebar').getByText('alpha/item.go',{exact:true}).click();await panel.getByTestId('diff-hunk-count').waitFor();
    holdPath='beta/item.go';const heldRead=new Promise(resolve=>notifyHeld=resolve);
    await page.getByTestId('comparison-sidebar').getByText('beta/item.go',{exact:true}).click();await heldRead;assert.equal(await panel.getByTestId('workbench-diff-lines').count(),0,'uncached file cannot show previous code');assert.equal(await panel.getByTestId('diff-hunk-navigation').count(),0,'uncached file cannot show old hunk count');holdPath='';for(const release of held)release();held=[];
await panel.getByRole('tab',{name:'beta/item.go',exact:true,selected:true}).waitFor();
    await panel.evaluate(node=>{node.style.width='320px';});
    const tabMetrics=await page.evaluate(()=>new Promise((resolve,reject)=>{let stable=0;const started=performance.now();const check=()=>{
      const tabs=document.querySelector('[data-testid="diff-file-tabs"]'),active=tabs?.querySelector('[role="tab"][aria-selected="true"]');
      const a=active?.getBoundingClientRect(),b=tabs?.getBoundingClientRect();const valid=a&&b&&b.width>50&&b.width<220&&a.x>=b.x-1&&a.right<=b.right+1;
      stable=valid?stable+1:0;
      if(stable>=4)resolve({tabX:a.x,tabRight:a.right,viewportX:b.x,viewportRight:b.right,settledMs:performance.now()-started});
      else if(performance.now()-started>5000)reject(Error(JSON.stringify({tab:a?.toJSON(),viewport:b?.toJSON()})));else requestAnimationFrame(check);
    };check();}));report.activeTabResize=tabMetrics;
    await panel.screenshot({path:join(output,`multi-tabs-${colorScheme}-320.png`)});await panel.evaluate(node=>{node.style.width='1000px';});await frames();
    await panel.getByRole('tab',{name:'compare.go',exact:true}).click();await count.filter({hasText:'2 / 3'}).waitFor();assert.ok(Math.abs(await scrollTop()-beforeScroll)<2,'cached file restores code position');
    await panel.getByRole('tab',{name:'alpha/item.go',exact:true}).click();await panel.getByRole('button',{name:'Close alpha/item.go',exact:true}).click();assert.equal(await panel.getByRole('tab',{name:'alpha/item.go',exact:true}).count(),0);
    await panel.getByRole('tab',{name:'item.go',exact:true}).click({button:'middle'});assert.equal(await panel.getByRole('tab',{name:'item.go',exact:true}).count(),0);
    await panel.getByRole('button',{name:'Next change hunk',exact:true}).click();await count.filter({hasText:'3 / 3'}).waitFor();
    await panel.getByRole('button',{name:'Next change hunk',exact:true}).click();await count.filter({hasText:'1 / 3'}).waitFor();
    const copied=await panel.getByTestId('workbench-diff-lines').evaluate(node=>{const cell=node.querySelector('[data-testid="diff-code-unified"]');const range=document.createRange();range.selectNodeContents(cell);const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);const data=new DataTransfer();document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));selection.removeAllRanges();return data.getData('text/plain');});assert.match(copied,/^\/\/ /);report.copied=copied;
    await panel.getByRole('button',{name:'Use split review',exact:true}).click();await panel.getByTestId('diff-code-left').first().waitFor();await panel.getByRole('button',{name:'Use unified review',exact:true}).click();await panel.getByTestId('diff-code-unified').first().waitFor();
    await panel.getByTestId('diff-single-toolbar').evaluate(node=>{for(const text of node.querySelectorAll('*'))if(text.childNodes.length===1&&text.firstChild.nodeType===3)text.style.fontSize=parseFloat(getComputedStyle(text).fontSize)*1.5+'px';});
    assert.equal(await panel.getByTestId('diff-single-toolbar').evaluate(node=>node.scrollWidth>node.clientWidth+1),false);await panel.screenshot({path:join(output,`enlarged-${colorScheme}.png`)});
    holdPath='asset.bin';const lateRead=new Promise(resolve=>notifyHeld=resolve);await page.getByTestId('comparison-sidebar').getByText('asset.bin',{exact:true}).click();await lateRead;
    await panel.getByRole('tab',{name:'compare.go',exact:true}).click();holdPath='';for(const release of held)release();held=[];await frames();await panel.getByRole('tab',{name:'compare.go',exact:true,selected:true}).waitFor();
    await panel.getByRole('tab',{name:'asset.bin',exact:true}).click();await panel.getByText('Binary file',{exact:true}).waitFor();assert.equal(await panel.getByTestId('diff-hunk-navigation').count(),0);
    await page.getByTestId('comparison-sidebar').getByText('mode.go',{exact:true}).click();await panel.getByText('No text changes to display',{exact:true}).waitFor();assert.equal(await panel.getByTestId('diff-hunk-navigation').count(),0);
    report.checks.push(`${colorScheme}: delayed/late content never replaces another file, binary and mode-only views retain toolbar without phantom hunks`);
    report.checks.push(`${colorScheme}: multi-file labels, close/middle-close, cached scroll restoration, hunk navigation, mode switching, code copy and enlarged type`);
    report.checks.push(`${colorScheme}: compact row, frozen reference details, settings work, menus issue no business reads`);
   }
 }
 assert.equal(report.pageErrors.length,0);report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;if(page){report.visible=await page.locator('body').innerText().catch(()=>'');await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}}
finally{await browser?.close();client?.close();if(ui)writeFileSync(ui.continueFile,'continue\n');else host.kill('SIGTERM');report.hostExitCode=await exited;if(report.hostExitCode!==0){report.ok=false;process.exitCode=1;}writeFileSync(join(output,'host.log'),logs);writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
