/** Real isolated Paseo renderer; provenance fixtures do not touch normal records. */
import assert from 'node:assert/strict';
import ts from 'typescript';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,readFileSync,chmodSync,cpSync,mkdtempSync,symlinkSync} from 'node:fs';
import {join,dirname,relative,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {digest} from '../server/orchestration-state.ts';
import {chromium} from 'playwright';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import {backendRequest} from '../server/backend-supervisor.ts';
const output=process.env.WORKBENCH_VERIFY_OUTPUT || '/tmp/workbench-scroll-ui';mkdirSync(output,{recursive:true});
// Instrument an isolated source copy; never add profiling branches to the daily plugin.
const fixturePlugin=mkdtempSync('/tmp/wb-scroll-source-'),sourcePlugin=process.env.WORKBENCH_VERIFY_PLUGIN||join(import.meta.dirname,'..');
cpSync(sourcePlugin,fixturePlugin,{recursive:true,filter:path=>!['node_modules','.backend-build','dist'].some(part=>relative(sourcePlugin,path).split(sep).includes(part))});
symlinkSync(join(import.meta.dirname,'../node_modules'),join(fixturePlugin,'node_modules'));
const componentPath=join(fixturePlugin,'client/comparison-review.tsx');let component=readFileSync(componentPath,'utf8');component=component.replace('const rows: DocumentRow[] = []',"if((globalThis as any).__wbPerf)(globalThis as any).__wbPerf.builds++; const rows: DocumentRow[] = []");writeFileSync(componentPath,component);
const syntaxPath=join(fixturePlugin,'client/syntax-web.tsx');let syntax=readFileSync(syntaxPath,'utf8');syntax=syntax.replace('const tokens = normalizePrismTokens',"if((globalThis as any).__wbPerf)(globalThis as any).__wbPerf.syntax++; const tokens = normalizePrismTokens");writeFileSync(syntaxPath,syntax);
for(const file of ['client/comparison-review.tsx','client/file-review.tsx']){
 const path=join(fixturePlugin,file),source=readFileSync(path,'utf8'),tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),edits=[];
 const visit=node=>{if(ts.isJsxAttribute(node)&&node.name.text==='onScroll'&&node.initializer&&ts.isJsxExpression(node.initializer)&&node.initializer.expression&&ts.isArrowFunction(node.initializer.expression)&&ts.isBlock(node.initializer.expression.body)){
 const body=node.initializer.expression.body;edits.push([body.getStart(tree)+1,'const __scrollStart=performance.now();try{'],[body.end-1,'}finally{const p=(globalThis as any).__wbPerf;if(p)p.handlerMs.push(performance.now()-__scrollStart);}']);}
 ts.forEachChild(node,visit);};visit(tree);let next=source;for(const [offset,code] of edits.sort((a,b)=>b[0]-a[0]))next=next.slice(0,offset)+code+next.slice(offset);writeFileSync(path,next);
}
const host=spawn(process.execPath,[join(fixturePlugin,'scripts/verify-live.mjs')],{env:{...process.env,WORKBENCH_LIVE_UI:'1'},detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
let logs='',ui,client,browser,page;const exited=new Promise(r=>host.once('exit',r));host.stderr.on('data',x=>logs+=x);
const ready=new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('host readiness timeout')),120000);createInterface({input:host.stdout}).on('line',line=>{logs+=line+'\n';try{const x=JSON.parse(line);if(x.kind==='ui-ready'){clearTimeout(timer);yes(x);}}catch{}});void exited.then(code=>{clearTimeout(timer);no(Error(`host exited ${code}`));});});
const report={checks:[],pageErrors:[],consoleErrors:[]};
try{
 ui=await ready;client=new DaemonClient({url:ui.url.replace('http:','ws:')+'/ws',clientId:'scroll-ui',clientType:'mcp',reconnect:{enabled:false},webSocketFactory:(u,o)=>new WebSocket(u,o?.protocols,{headers:o?.headers})});await client.connect();await client.createAgent({config:{provider:'codex',cwd:ui.project,modeId:'auto',featureValues:{plan_mode:false}}});
 const tree=join(ui.project,'one'),git=(...args)=>execFileSync('git',['-C',tree,...args],{encoding:'utf8'}).trim();
 const base=git('rev-parse','HEAD');mkdirSync(join(tree,'group'),{recursive:true});
 for(let f=0;f<200;f++)writeFileSync(join(tree,'group',`file-${String(f).padStart(3,'0')}.ts`),Array.from({length:100},(_,i)=>`export const item_${f}_${i} = ${i};`).join('\n')+'\n');
 git('add','.');git('commit','-qm','group fixture');const group=git('rev-parse','HEAD');
 writeFileSync(join(tree,'long.ts'),Array.from({length:20000},(_,i)=>`// ${i}`).join('\n')+'\n');git('add','.');git('commit','-qm','long fixture');const end=git('rev-parse','HEAD');
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1600,height:1000}});await page.emulateMedia({colorScheme:'dark'});
 await page.addInitScript(()=>{window.__wbPerf={commits:0,frames:[],tasks:[],builds:0,syntax:0,handlerMs:[]};window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject:()=>1,onCommitFiberRoot:()=>{window.__wbPerf.commits++;},onCommitFiberUnmount:()=>{}};new PerformanceObserver(entries=>{for(const e of entries.getEntries())window.__wbPerf.tasks.push({at:e.startTime,ms:e.duration});}).observe({type:'longtask',buffered:true});});
 page.on('pageerror',e=>report.pageErrors.push(e.message));page.on('console',e=>{if(e.type()==='error'&&!e.text().startsWith('workbench_client_diagnostic '))report.consoleErrors.push(e.text());});
 await page.goto(ui.url);report.page={url:page.url(),title:await page.title()};await page.getByRole('button',{name:'a',exact:true}).click();await page.getByRole('button',{name:'Open Workspace Workbench',exact:true}).click();await page.getByTestId('workbench-graph-content').waitFor({timeout:30000});await page.getByRole('button',{name:'比较仓库',exact:true}).click();
 const refs=async(from,to)=>{await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(from);await page.getByRole('button',{name:'使用此引用',exact:true}).click();await page.getByTestId('comparison-from').filter({hasText:from.slice(0,8)}).waitFor();await page.getByTestId('comparison-to').click();await page.getByLabel('搜索引用或输入提交 SHA',{exact:true}).fill(to);await page.getByRole('button',{name:'使用此引用',exact:true}).click();await page.getByTestId('comparison-to').filter({hasText:to.slice(0,8)}).waitFor();};await refs(base,group);
 const panel=page.getByTestId('workbench-diff-panel'),sidebar=page.getByTestId('comparison-sidebar');await sidebar.getByText('group/file-000.ts',{exact:true}).click();await panel.getByTestId('diff-code-unified').filter({hasText:'item_0_0 ='}).waitFor({timeout:60000});
 async function sample(name,stable=false){
  report[name]=await page.evaluate(async ({duration,stable})=>{
   const list=document.querySelector('[data-testid="workbench-diff-lines"]');const p=window.__wbPerf,started=performance.now(),commits=p.commits,builds=p.builds,syntax=p.syntax,handlerStart=p.handlerMs.length;let previous=started,nextMove=started,dir=1,maximum=0,frames=[],moves=0;
   await new Promise(resolve=>{function frame(now){frames.push(now-previous);previous=now;maximum=Math.max(maximum,list.querySelectorAll('[data-testid^="diff-code-"]').length);
    if(now>=nextMove){const max=stable?Math.min(1000,list.scrollHeight-list.clientHeight):list.scrollHeight-list.clientHeight;let y=list.scrollTop+dir*(stable?40:340);if(y>=max){y=max;dir=-1;}if(y<=0){y=0;dir=1;}list.scrollTop=y;nextMove=now+32;moves++;}
    if(now-started<duration)requestAnimationFrame(frame);else resolve();}requestAnimationFrame(frame);});frames.sort((a,b)=>a-b);
   return {durationMs:performance.now()-started,frameP95Ms:frames[Math.ceil(frames.length*.95)-1],frameMaxMs:frames.at(-1),frames:frames.length,moves,maxMountedRows:maximum,commits:p.commits-commits,documentBuilds:p.builds-builds,syntaxPasses:p.syntax-syntax,scrollHandlerMaxMs:Math.max(0,...p.handlerMs.slice(handlerStart)),longTasks:p.tasks.filter(t=>t.at>=started),scrollHeight:list.scrollHeight};
  },{duration:stable?5000:Number(process.env.WORKBENCH_SCROLL_MS||60000),stable});await page.screenshot({path:join(output,`${name}.png`)});writeFileSync(join(output,`${name}.json`),JSON.stringify(report[name],null,2));
 }
 await sample('group');
 await sidebar.getByText('group/file-000.ts',{exact:true}).click();await panel.getByTestId('diff-code-unified').filter({hasText:'item_0_0 ='}).waitFor();
 await sample('warmup',true);await sample('stable',true);
 await sidebar.getByTestId('comparison-from').click();await refs(group,end);await sidebar.getByText('long.ts',{exact:true}).click();await panel.getByRole('button',{name:'单独打开 long.ts',exact:true}).last().click();await panel.getByTestId('diff-code-unified').filter({hasText:'// 0'}).waitFor({timeout:60000});
 await sample('single');
 report.ok=report.pageErrors.length===0&&report.consoleErrors.length===0;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;if(page){report.visible=await page.locator('body').innerText().catch(()=>'');await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}}
finally{await browser?.close();client?.close();if(ui)writeFileSync(ui.continueFile,'continue\n');else if(process.platform!=='win32')process.kill(-host.pid,'SIGTERM');else host.kill('SIGTERM');report.hostExitCode=await exited;if(report.hostExitCode!==0){report.ok=false;process.exitCode=1;}writeFileSync(join(output,'host.log'),logs);writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
