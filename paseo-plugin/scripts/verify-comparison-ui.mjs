/** Real isolated Paseo renderer; provenance fixtures do not touch normal records. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import {backendRequest} from '../server/backend-supervisor.ts';
const output=process.env.WORKBENCH_VERIFY_OUTPUT || '/tmp/workbench-compact-comparison-ui';mkdirSync(output,{recursive:true});
const host=spawn(process.execPath,[join(import.meta.dirname,'verify-live.mjs')],{env:{...process.env,WORKBENCH_LIVE_UI:'1'},stdio:['ignore','pipe','pipe']});
let logs='',ui,client,browser,page;const exited=new Promise(r=>host.once('exit',r));host.stderr.on('data',x=>logs+=x);
const ready=new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('host readiness timeout')),120000);createInterface({input:host.stdout}).on('line',line=>{logs+=line+'\n';try{const x=JSON.parse(line);if(x.kind==='ui-ready'){clearTimeout(timer);yes(x);}}catch{}});void exited.then(code=>{clearTimeout(timer);no(Error(`host exited ${code}`));});});
const report={checks:[],pageErrors:[]};
try{
 ui=await ready;client=new DaemonClient({url:ui.url.replace('http:','ws:')+'/ws',clientId:'creator-ui',clientType:'mcp',reconnect:{enabled:false},webSocketFactory:(u,o)=>new WebSocket(u,o?.protocols,{headers:o?.headers})});await client.connect();
 await client.createAgent({config:{provider:'codex',cwd:ui.project,modeId:'auto',featureValues:{plan_mode:false}}});
 const git=(...args)=>execFileSync('git',['-C',join(ui.project,'one'),...args],{encoding:'utf8'}).trim();
 const base=git('rev-parse','HEAD');
 writeFileSync(join(ui.project,'one','compare.go'),'package sample\n\n// 中文 tab and a deliberately long line to verify wrapping in the narrow viewer '+ 'sample '.repeat(35)+'\nfunc timeout() int { return 5 }\n');
 writeFileSync(join(ui.project,'one','alternate.go'),'package sample\nfunc alternate() int { return 7 }\n');
 for(let i=0;i<30;i++)writeFileSync(join(ui.project,'one',`sample-${String(i).padStart(2,'0')}.txt`),`sample ${i}\n`);
 git('add','compare.go','alternate.go',...Array.from({length:30},(_,i)=>`sample-${String(i).padStart(2,'0')}.txt`));git('commit','-qm','comparison UI fixture');const head=git('rev-parse','HEAD');const longRef='feature/a-long-comparison-reference-for-layout-validation';git('branch',longRef,base);
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1600,height:1050}});page.on('pageerror',e=>report.pageErrors.push(e.message));await page.emulateMedia({colorScheme:'dark'});
 let holdRef='',held=[],notifyHeld;const business=[];
 await page.routeWebSocket('**/*',socket=>{const server=socket.connectToServer();socket.onMessage(message=>{if(String(message).includes('repository.compare'))business.push(String(message));server.send(message);});server.onMessage(message=>{
   let matched=false;try{const inspect=value=>{if(!value||typeof value!=='object')return;if(value.comparison?.fromRef===holdRef&&Array.isArray(value.files))matched=true;for(const child of Object.values(value))inspect(child);};if(holdRef)inspect(JSON.parse(String(message)));}catch{}
   if(matched){held.push(()=>socket.send(message));notifyHeld?.();}else socket.send(message);
 });});
 await page.goto(ui.url);
 await page.getByRole('button',{name:'a',exact:true}).click();
 await page.getByRole('button',{name:'Open Workspace Workbench',exact:true}).click();
 await page.getByTestId('workbench-graph-content').waitFor({timeout:30000});
 await page.getByRole('button',{name:'比较仓库',exact:true}).click();
 await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(base);
 await page.getByRole('button',{name:'使用此引用',exact:true}).click();
 await page.getByText('compare.go',{exact:true}).first().waitFor({timeout:30000});
 await page.getByTestId('comparison-to').click();await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(head);await page.getByRole('button',{name:'使用此引用',exact:true}).click();
 await page.getByTestId('comparison-to').filter({hasText:head.slice(0,8)}).waitFor();
 const sidebar=page.getByTestId('comparison-sidebar');
 report.controlsHeight=(await page.getByTestId('comparison-controls').boundingBox()).height;assert.ok(report.controlsHeight<=150);
 assert.equal(await page.getByLabel('搜索变化文件',{exact:true}).filter({has:page.locator('input')}).count(),0);
 await page.screenshot({path:join(output,'comparison-sidebar.png')});
 const chooseFrom=async value=>{await page.getByTestId('comparison-from').click();await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(value);await page.getByRole('button',{name:'使用此引用',exact:true}).click();};
 const nextFrames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await nextFrames();const beforeMenus=business.length;
 await page.getByRole('button',{name:'比较设置',exact:true}).click();await page.getByTestId('comparison-popover').waitFor();report.popoverBounds=await page.getByTestId('comparison-popover').boundingBox();report.popoverLayers=await page.getByTestId('comparison-popover').evaluate(node=>{const result=[];while(node){const css=getComputedStyle(node),box=node.getBoundingClientRect();result.push({tag:node.tagName,opacity:css.opacity,z:css.zIndex,position:css.position,x:box.x,y:box.y,width:box.width,height:box.height});node=node.parentElement;}return result;});await page.getByTestId('comparison-popover').screenshot({path:join(output,'popover-detail.png')});await page.screenshot({path:join(output,'comparison-menu.png')});
 await page.getByRole('button',{name:'使用平铺文件列表',exact:true}).click();await page.getByRole('button',{name:'使用目录树',exact:true}).click();
 await page.getByTestId('comparison-popover').getByRole('button',{name:'关闭比较设置',exact:true}).click();await nextFrames();assert.equal(business.length,beforeMenus,'opening menu and switching tree mode do not read Git');
 await page.getByRole('button',{name:'搜索变化文件',exact:true}).click();await page.getByRole('textbox',{name:'搜索变化文件',exact:true}).fill('alternate');assert.equal(await sidebar.getByText('compare.go',{exact:true}).count(),0);
 await page.getByRole('button',{name:'关闭文件搜索',exact:true}).click();await sidebar.getByText('compare.go',{exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'搜索变化文件',exact:true}).count(),0);
 const waiting=new Promise(resolve=>notifyHeld=resolve);holdRef=longRef;await chooseFrom(longRef);await waiting;
 assert.match(await page.getByTestId('comparison-from').getAttribute('aria-label'),new RegExp(base));await sidebar.getByText('compare.go',{exact:true}).waitFor();
 await chooseFrom('missing-comparison-reference');await page.getByRole('button',{name:'比较失败，查看原因与重试',exact:true}).waitFor();holdRef='';for(const release of held)release();held=[];await nextFrames();
 assert.match(await page.getByTestId('comparison-from').getAttribute('aria-label'),new RegExp(base),'late older response cannot replace displayed comparison');
 await chooseFrom(base);await page.getByRole('button',{name:'比较失败，查看原因与重试',exact:true}).waitFor({state:'hidden'});
 report.checks.push('Menus and layout toggles cause no business reads; search closes without hidden filter; delayed and failed comparisons retain matching old content and ignore late responses');
 const reopenComparison=async()=>{
   await page.getByTestId('workbench-graph-content').waitFor();await page.getByRole('button',{name:'比较仓库',exact:true}).click();await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(base);await page.getByRole('button',{name:'使用此引用',exact:true}).click();await page.getByTestId('comparison-to').click();await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(head);await page.getByRole('button',{name:'使用此引用',exact:true}).click();await sidebar.getByText('compare.go',{exact:true}).waitFor();
 };
 report.widthChecks=[];
 const originalStyle=await sidebar.getAttribute('style');
 for(const colorScheme of ['dark','light']){
   await page.emulateMedia({colorScheme});if(colorScheme==='light')await reopenComparison();
   for(const width of [280,320,400]){
     await sidebar.evaluate((element,width)=>{Object.assign(element.style,{position:'fixed',top:'130px',right:'4px',bottom:'8px',left:'auto',width:`${width}px`,maxWidth:`${width}px`,minWidth:`${width}px`,zIndex:'100',backgroundColor:getComputedStyle(document.body).backgroundColor});},width);
     await nextFrames();
     const metrics=await sidebar.evaluate(element=>{const root=element.getBoundingClientRect(),controls=element.querySelector('[data-testid="comparison-controls"]').getBoundingClientRect(),from=element.querySelector('[data-testid="comparison-from"]').getBoundingClientRect(),to=element.querySelector('[data-testid="comparison-to"]').getBoundingClientRect();return {width:root.width,height:controls.height,sameRow:Math.abs(from.y-to.y)<1,overflow:element.scrollWidth>element.clientWidth+1};});
     assert.equal(metrics.width,width);assert.ok(metrics.height<=150&&metrics.sameRow&&!metrics.overflow,JSON.stringify(metrics));report.widthChecks.push({colorScheme,...metrics});
     await sidebar.screenshot({path:join(output,`compact-${colorScheme}-${width}.png`)});
   }
 }
 // Isolated 150% text enlargement; this is web evidence, not native font scaling.
 const fontStyles=await sidebar.evaluate(element=>Array.from(element.querySelectorAll('*')).filter(node=>node.childNodes.length===1&&node.firstChild.nodeType===3).map(node=>{const value=node.style.fontSize;node.dataset.qaFont=value;node.style.fontSize=`${parseFloat(getComputedStyle(node).fontSize)*1.5}px`;return value;}));
 await nextFrames();report.enlargedType={factor:1.5,controlsHeight:(await page.getByTestId('comparison-controls').boundingBox()).height};assert.ok(report.enlargedType.controlsHeight<=150);await sidebar.screenshot({path:join(output,'compact-enlarged-type.png')});
 await sidebar.evaluate(element=>{for(const node of element.querySelectorAll('[data-qa-font]')){node.style.fontSize=node.dataset.qaFont;delete node.dataset.qaFont;}});
 await sidebar.evaluate((element,style)=>element.setAttribute('style',style||''),originalStyle);await page.emulateMedia({colorScheme:'dark'});await reopenComparison();await nextFrames();

 await page.getByText('compare.go',{exact:true}).first().click();
 await page.getByTestId('workbench-diff-lines').waitFor({timeout:30000});
 await page.getByText('14px',{exact:true}).waitFor();
 await page.getByRole('button',{name:'自动换行',exact:true}).click();
 await page.getByText('换行 ✓',{exact:true}).waitFor();
 await page.getByRole('button',{name:'代码字号',exact:true}).click();await page.getByText('16px',{exact:true}).waitFor();
 report.codeFonts=await page.getByTestId('workbench-diff-lines').evaluate(node=>Array.from(node.querySelectorAll('*')).filter(el=>el.textContent==='package'||el.textContent==='sample').map(el=>({text:el.textContent,font:getComputedStyle(el).fontFamily,size:getComputedStyle(el).fontSize,html:el.outerHTML.slice(0,400)})));
 assert.ok(report.codeFonts.length>0);assert.ok(report.codeFonts.every(item=>/Consolas|monospace|Menlo/.test(item.font)),'syntax tokens use actual monospace font');
 report.copied=await page.getByTestId('workbench-diff-lines').evaluate(node=>{
   const cells=node.querySelectorAll('[data-testid="diff-code-right"]');const range=document.createRange();range.setStart(cells[0],0);range.setEnd(cells[cells.length-1],cells[cells.length-1].childNodes.length);const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);const data=new DataTransfer();document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));selection.removeAllRanges();return data.getData('text/plain');
 });assert.match(report.copied,/package sample/);assert.ok(!/^\d+\s|^\+/m.test(report.copied));
 await page.screenshot({path:join(output,'comparison-diff.png')});
 report.cachedClickMs=[];
 for(let i=0;i<22;i++){
   const alternate=i%2===0;await page.evaluate(()=>{document.addEventListener('click',()=>window.__comparisonClick=performance.now(),{once:true,capture:true});});
   await page.getByText(alternate?'alternate.go':'compare.go',{exact:true}).last().click();
   await page.getByTestId('workbench-diff-lines').getByText(alternate?'alternate':'timeout',{exact:true}).waitFor();
   const elapsed=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-window.__comparisonClick)))));if(i>=2)report.cachedClickMs.push(elapsed);
 }
 report.cachedClickP95=[...report.cachedClickMs].sort((a,b)=>a-b)[18];assert.ok(report.cachedClickP95<=200,`cached UI P95 ${report.cachedClickP95}`);
 await page.setViewportSize({width:1080,height:900});await page.getByTestId('diff-code-unified').first().waitFor();await page.screenshot({path:join(output,'comparison-narrow.png')});

 report.checks.push('Actual host sidebar selects fixed endpoints; changed file opens main Diff; font and wrap controls work');
 await page.getByRole('button',{name:'返回浏览',exact:true}).click();await page.getByTestId('workbench-graph-content').waitFor();
 report.checks.push('Returning from comparison restores existing graph');
 await page.getByRole('button',{name:'提交比较操作',exact:true}).first().click();await page.getByText('设为比较起点',{exact:true}).last().click();
 await page.getByRole('button',{name:'提交比较操作',exact:true}).nth(1).click();await page.getByText('与起点比较',{exact:true}).click();await page.getByTestId('comparison-from').waitFor();
 assert.match(await page.getByTestId('comparison-from').getAttribute('aria-label'),/[a-f0-9]{40}/);assert.match(await page.getByTestId('comparison-to').getAttribute('aria-label'),/[a-f0-9]{40}/);report.checks.push('Commit menus select both endpoints without changing normal click behavior');
 assert.equal(report.pageErrors.length,0);report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;if(page){report.visible=await page.locator('body').innerText().catch(()=>'');await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}}
finally{await browser?.close();client?.close();if(ui)writeFileSync(ui.continueFile,'continue\n');else host.kill('SIGTERM');report.hostExitCode=await exited;if(report.hostExitCode!==0){report.ok=false;process.exitCode=1;}writeFileSync(join(output,'host.log'),logs);writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
