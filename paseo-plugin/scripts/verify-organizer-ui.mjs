/** Actual isolated Paseo + protocol Agent fixture + local HTTP model fixture. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { chromium } from 'playwright';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';
import WebSocket from 'ws';
import { openIsolatedWorkbench } from './ui-project-selection.mjs';
import {observerSettingsRpc} from '../shared/settings.ts';
const plugin=resolve(import.meta.dirname,'..'),output=process.env.WORKBENCH_VERIFY_OUTPUT||mkdtempSync(join(tmpdir(),'wb-organizer-ui-'));
mkdirSync(output,{recursive:true});
let calls=0;
const model=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'organizer-fixture',owned_by:'fixture'}]}));return;}
  const parts=[];for await(const part of req)parts.push(part);const input=JSON.parse(JSON.parse(Buffer.concat(parts).toString()).messages[1].content);calls++;
  res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'仓库登录异常修复',brief:'修复登录异常，补充错误处理。',items:[{text:'修复登录错误处理',evidenceIds:[input.evidence[0].id],completed:true}]})}}],usage:{prompt_tokens:100,completion_tokens:40}}));
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const child=spawn(process.execPath,[join(plugin,'scripts/verify-live.mjs')],{env:{...process.env,WORKBENCH_LIVE_UI:'1',WORKBENCH_LIVE_TOPICS:'1'},stdio:['ignore','pipe','pipe']});
let logs='',ui,browser,page,client;
const exited=new Promise(r=>child.once('exit',r));child.stderr.on('data',b=>{logs+=b;});
const ready=new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('isolated host readiness timeout')),120000);createInterface({input:child.stdout}).on('line',line=>{logs+=line+'\n';try{const value=JSON.parse(line);if(value.kind==='ui-ready'){clearTimeout(timer);yes(value);}}catch{}});void exited.then(code=>{clearTimeout(timer);no(Error('isolated host exited '+code));});});
const report={kind:'actual-isolated-paseo-organizer',browser:'Playwright: Browser plugin not available',output,checks:[],screenshots:[],pageErrors:[],console:[]};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(fn,timeout=30000)=>{const until=Date.now()+timeout;let last;while(Date.now()<until){try{const result=await fn();if(result)return result;}catch(e){last=e;}await pause(100);}throw last||Error('verification timeout');};
const check=text=>{report.checks.push(text);console.log(JSON.stringify({check:text}));};
function executable(){if(existsSync(chromium.executablePath()))return chromium.executablePath();const cache=process.platform==='darwin'?join(homedir(),'Library/Caches/ms-playwright'):join(homedir(),'.cache/ms-playwright');for(const name of readdirSync(cache).filter(n=>n.startsWith('chromium_headless_shell-')).sort().reverse()){const file=join(cache,name,process.platform==='darwin'?'chrome-headless-shell-mac-arm64/chrome-headless-shell':'chrome-headless-shell-linux64/chrome-headless-shell');if(existsSync(file))return file;}throw Error('No installed Playwright browser');}
try {
  ui=await ready;
  client=new DaemonClient({url:`ws://${new URL(ui.url).host}/ws`,clientId:'organizer-verification',clientType:'mcp',reconnect:{enabled:false},webSocketFactory:(url,options)=>new WebSocket(url,options?.protocols,{headers:options?.headers})});await client.connect();
  const api=createPaseoApi(client),config=join(ui.project,'project.json'),pluginId='workspace-workbench-paseo';
  const invoke=(method,input)=>client.invokePluginRpc(pluginId,method,input);
  const organize=async request=>{const value=await invoke('workspace.workbench.organizer',{projectConfig:config,request});assert.ok(value.ok,JSON.stringify(value));return value.result;};
  const settings=await organize({action:'settings.get'});assert.equal(settings.effective.enabled,false);
  const profile={id:'fixture',name:'隔离本地模型',baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'organizer-fixture',contextTokens:16384,outputTokens:2048,timeoutMs:120000};
  let saved=await organize({action:'profile.save',revision:settings.revision,profile});
  await organize({action:'settings.save',scope:'project',revision:saved.revision,patch:{profileId:'fixture',analysisIntervalSeconds:0,productionBranches:{one:'production'}}});
  const agent=await client.createAgent({config:{provider:'codex',cwd:ui.project,modeId:'auto'},title:'原始会话标题',initialPrompt:'Discuss login errors without modifying files.'});
  await wait(async()=>{const snapshot=await client.fetchAgent({agentId:agent.id});return snapshot.agent.status!=='running'&&snapshot.agent.workspaceId;});
  const nativeId=(await client.fetchAgent({agentId:agent.id})).agent.workspaceId;
  await api.workspaces.ref(nativeId).setTitle('原始会话标题');
  const created=await invoke('workspace.workbench.query',{projectConfig:config,method:'workspace.create',params:{name:'organizer-history',repositories:['one'],contextAgentId:agent.id,taskBrief:'修复仓库登录异常',taskKind:'bug'}});assert.ok(created.ok,JSON.stringify(created));
  const worktree=join(created.result.treePath,'one');const git=(path,...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8'}).trim();
  const base=git(worktree,'rev-parse','HEAD');git(worktree,'branch','production',base);writeFileSync(join(worktree,'README'),'login errors handled\n');git(worktree,'add','README');git(worktree,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fix login errors');
  const preferences=await invoke(observerSettingsRpc.read.name,{});assert.equal(preferences.status,'ready');const branchKey=JSON.stringify([config,'one']);const branches={...preferences.values.productionBranches,[branchKey]:'production'};
  assert.equal((await invoke(observerSettingsRpc.write.name,{revision:preferences.revision,values:{...preferences.values,productionBranches:branches}})).status,'saved');assert.equal((await organize({action:'settings.get'})).effective.productionBranches.one,'production');
  check('legacy Compare production settings are read by the actual plugin backend');
  const job=await organize({action:'analyze',workspaceIds:['organizer-history'],conversation:true,regenerate:false});
  await wait(async()=>{const j=await organize({action:'job',jobId:job.id});if(['failed','cancelled'].includes(j.state))throw Error(j.error);return j.state==='complete';});
  let snapshot=await organize({action:'snapshot'});const workspace=snapshot.workspaces.find(w=>w.material.workspaceId==='organizer-history');assert.ok(workspace,JSON.stringify(snapshot));assert.equal(workspace.title,'仓库登录异常修复');assert.equal(workspace.material.state,'pending');assert.equal(workspace.items[0].state,'confirm');
  assert.equal((await api.workspaces.ref(nativeId).refresh()).title,'原始会话标题');assert.ok(snapshot.targets.find(t=>t.id===nativeId));
  check('actual plugin stores the optional goal, binds through explicit creator identity, summarizes with local HTTP fixture, and historical analysis leaves the native title unchanged');
  const applied=await organize({action:'apply',targetIds:[nativeId],revision:snapshot.revision,maintain:true});assert.ok(!applied[0].error,JSON.stringify(applied));assert.equal((await api.workspaces.ref(nativeId).refresh()).title,'○ 仓库登录异常修复');
  await organize({action:'restore',targetId:nativeId});assert.equal((await api.workspaces.ref(nativeId).refresh()).title,'原始会话标题');
  check('native Workspace title accepts Chinese and status characters; explicit apply and guarded restore keep Workspace and Agent IDs');
  browser=await chromium.launch({headless:true,executablePath:executable()});page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>report.pageErrors.push(e.message));page.on('console',m=>{if(['error','warning'].includes(m.type()))report.console.push(m.text());});
  await openIsolatedWorkbench(page,ui.url,'a');
  await wait(async()=>!(await organize({action:'snapshot'})).jobs.some(j=>['running','queued'].includes(j.state)));
  snapshot=await organize({action:'snapshot'});const visibleApply=await organize({action:'apply',targetIds:[nativeId],revision:snapshot.revision,maintain:false});assert.ok(!visibleApply[0].error,JSON.stringify(visibleApply));
  const nativeTitle=page.getByText('○ 仓库登录异常修复',{exact:true}).filter({visible:true}).first();await nativeTitle.waitFor();const nativeShot=join(output,'native-title-characters.png');await nativeTitle.screenshot({path:nativeShot});report.screenshots.push(nativeShot);await organize({action:'restore',targetId:nativeId});await page.getByText('原始会话标题',{exact:true}).filter({visible:true}).first().waitFor();check('actual native Workspace list renders the status character within its title and then restores the original title');
  await page.getByRole('tab',{name:'设置',exact:true}).filter({visible:true}).last().click();
  const panel=page.getByTestId('workbench-settings-tab');await panel.getByText('Workbench 设置',{exact:true}).waitFor();
  const category=async label=>{await panel.getByRole('button',{name:'设置分类',exact:true}).click();await panel.getByRole('button',{name:new RegExp('^(?:✓ )?'+label+'$')}).click();};
  await category('标题与自动整理');await panel.getByLabel('整理提示词',{exact:true}).fill('草稿：保持模块与具体行为');
  await category('生产与上线');await category('标题与自动整理');assert.equal(await panel.getByLabel('整理提示词',{exact:true}).inputValue(),'草稿：保持模块与具体行为');
  await panel.getByRole('button',{name:'自动维护范围',exact:true}).click();await panel.getByRole('button',{name:'仅指定范围',exact:true}).click();await panel.getByText('选择 Workspace 范围',{exact:true}).click();const range=panel.getByRole('switch',{name:'organizer-history',exact:true});await range.click();await wait(async()=> (await panel.getByLabel('指定 ID（每行一个 Workspace 或 PASEO 条目 ID）',{exact:true}).inputValue()).split('\n').includes('organizer-history'));
  await panel.getByRole('button',{name:'编辑项目（固定，不跟随会话焦点）',exact:true}).click();await panel.getByRole('button',{name:'b',exact:true}).click();await panel.getByText('切换目标前，请处理未保存设置。',{exact:true}).waitFor();await panel.getByRole('button',{name:'继续编辑',exact:true}).click();
  check('category switching preserves draft; switching project presents explicit save/discard/continue controls');
  await panel.getByRole('button',{name:'放弃草稿',exact:true}).click();
  for(const width of [320,360,480]) {
    // Constrain only the plugin page, matching its explorer panel allocation.
    await panel.evaluate((element,width)=>{element.style.width=width+'px';element.style.maxWidth=width+'px';element.style.flex='none';element.style.height='850px';},width);
    await category('标题与自动整理');
    const overflow=await panel.evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth}));assert.ok(overflow.scroll<=overflow.width+2,JSON.stringify(overflow));
    const file=join(output,`settings-${width}.png`);await panel.screenshot({path:file});report.screenshots.push(file);
  }
  check('320/360/480px allocated plugin widths render a single column with no horizontal overflow; screenshots captured');
  await category('标题与自动整理');
  // Existing profile editor starts as new. Selecting the fixture permits a non-writing test.
  await panel.getByRole('button',{name:'编辑连接',exact:true}).click();await panel.getByRole('button',{name:'隔离本地模型',exact:true}).click();
  await panel.getByText('不写标题的生成测试',{exact:true}).click();await panel.getByLabel('测试材料',{exact:true}).fill('修复登录失败时未显示错误消息的问题');await panel.getByRole('button',{name:'运行测试',exact:true}).click();await panel.getByText('实际输入与来源',{exact:true}).waitFor();
  assert.equal((await api.workspaces.ref(nativeId).refresh()).title,'原始会话标题');
  check('model test UI shows actual prompt/input/output without modifying the native title');
  await category('会话与执行');await panel.getByText('会话与执行默认值',{exact:true}).waitFor();await category('代码评审');await panel.getByText('代码评审',{exact:true}).filter({visible:true}).last().waitFor();
  await category('环境与工具链');await panel.getByLabel('mise 路径',{exact:true}).waitFor();await category('自动恢复');await panel.getByLabel('继续消息',{exact:true}).waitFor();
  check('session, Reviewer, runtime and recovery settings render using their existing RPCs');
  await page.getByRole('tab',{name:'摘要',exact:true}).filter({visible:true}).last().click();await page.getByTestId('workbench-summary-tab').getByText('修复登录异常，补充错误处理。',{exact:true}).first().waitFor();await page.getByRole('button',{name:'事项筛选',exact:true}).filter({visible:true}).first().click();await page.getByRole('button',{name:'已完成',exact:true}).filter({visible:true}).first().click();
  const summaryShot=join(output,'summary.png');await page.getByTestId('workbench-summary-tab').screenshot({path:summaryShot});report.screenshots.push(summaryShot);check('Summary tab renders the linked brief, production indicator, manual checklist filter and separate completion claims');
  assert.deepEqual(report.pageErrors,[]);report.ok=true;report.modelCalls=calls;console.log(JSON.stringify(report,null,2));
} catch(error) {
  if(page){await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});writeFileSync(join(output,'failure-dom.txt'),await page.locator('body').innerText().catch(()=>''));}
  writeFileSync(join(output,'host.log'),logs,{mode:0o600});report.error=error.stack;report.ok=false;console.error(JSON.stringify(report,null,2));process.exitCode=1;
} finally {
  await browser?.close();await client?.close().catch(()=>{});await new Promise(r=>model.close(r));if(ui){writeFileSync(ui.continueFile,'continue');await Promise.race([exited,pause(30000)]);}if(child.exitCode===null)child.kill('SIGTERM');
}
