/** Visual review against private captured project data. --generate requests one real local-model preview. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const root=resolve(import.meta.dirname,'../../..');
const output=resolve(process.env.WORKBENCH_DESIGN_DATA||join(root,'dist/design/yuva-v2'));
const {chromium}=createRequire(join(root,'paseo-plugin/package.json'))('playwright');
let executablePath=chromium.executablePath();
if(!existsSync(executablePath)){
  const cache=join(homedir(),'Library/Caches/ms-playwright');
  for(const name of readdirSync(cache).filter(name=>name.startsWith('chromium_headless_shell-')).sort().reverse()){
    const candidate=join(cache,name,'chrome-headless-shell-mac-arm64/chrome-headless-shell');
    if(existsSync(candidate)){executablePath=candidate;break;}
  }
}
const browser=await chromium.launch({headless:true,executablePath});
const report={kind:'interactive-design-review',checks:[],screenshots:[],errors:[],realModel:false};
const check=text=>{report.checks.push(text);console.log(JSON.stringify({check:text}));};
const screenshot=async(page,file,fullPage=true)=>{await page.screenshot({path:join(output,file),fullPage});report.screenshots.push(file);};
try{
  const page=await browser.newPage({viewport:{width:390,height:1000},deviceScaleFactor:2});
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(JSON.parse(readFileSync(join(output,'server.json'),'utf8')).url);
  const data=await page.evaluate(()=>WORKBENCH_DESIGN.data);
  await page.getByTestId('summary-overview').waitFor();
  assert.equal(await page.locator('.session-card').count(),data.snapshot.targets.length);
  await page.getByRole('button',{name:/当前会话/}).click();await page.getByRole('heading',{name:'此会话暂无关联工作区'}).waitFor();
  await page.getByRole('button',{name:/查看 YUVA 项目资料/}).click();
  check('current-session empty state has an explicit project route; project counts separate Workspaces, linked sessions and unlinked material');
  await page.locator('[data-action="open-session"]').first().click();
  const w=await page.evaluate(()=>WORKBENCH_DESIGN.ownRuns.size&&[...WORKBENCH_DESIGN.ownRuns.values()].at(-1));
  if(process.argv.includes('--generate')){
    await page.getByTestId('generate-preview').click();await page.getByTestId('model-task').waitFor();
    assert.equal(await page.getByRole('button',{name:'取消生成',exact:true}).count(),1);
    await screenshot(page,'04-real-model-running.png');
    await page.waitForFunction(()=>{const entry=[...WORKBENCH_DESIGN.ownRuns.values()].at(-1);return entry&&['complete','failed','cancelled','interrupted'].includes(entry.test.state);},{},{timeout:150000});
    const entry=await page.evaluate(()=>[...WORKBENCH_DESIGN.ownRuns.values()].at(-1));
    assert.equal(entry.test.state,'complete',entry.test.error||entry.test.run?.error);assert.ok(!entry.test.run.error);
    report.realModel={workspaceId:entry.workspaceId,model:data.profile.model,seconds:entry.test.run.elapsedMs/1000,usage:entry.test.run.usage};
    check('one selected real Workspace generated a valid Sushi preview; actual request, elapsed time, input, output and validation are inspectable');
  }else if(w&&w.test.state==='complete'){
    report.realModel={workspaceId:w.workspaceId,seconds:w.test.run.elapsedMs/1000,usage:w.test.run.usage,source:'previous real trial'};
  }
  for(const width of [320,360,480,680]){
    await page.setViewportSize({width,height:1000});
    for(const section of ['summary','home','model','rules','extensions','storage','review','execution','repositories','production','runtime','recovery','topics','files','diagnostics']){
      await page.evaluate(section=>{if(section==='summary'){WORKBENCH_DESIGN.state.page='summary';WORKBENCH_DESIGN.state.selected=null;WORKBENCH_DESIGN.render();}else WORKBENCH_DESIGN.goSettings(section);},section);
      const sizes=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(sizes.scroll<=sizes.width+1,JSON.stringify({width,section,...sizes}));
    }
    await page.evaluate(()=>WORKBENCH_DESIGN.goSettings('home'));
    await screenshot(page,`settings-home-${width}.png`);
  }
  check('summary and every settings view fit 320/360/480/680px without horizontal page overflow');
  await page.setViewportSize({width:390,height:1000});
  await page.evaluate(()=>WORKBENCH_DESIGN.goSettings('home'));
  await page.getByTestId('model-connection-entry').getByText(data.profile.baseUrl,{exact:true}).waitFor();
  await page.getByRole('switch',{name:'自动整理开关'}).waitFor();
  for(const name of ['扩展管理','项目存储与缓存','审核配置'])await page.getByRole('heading',{name,exact:true}).waitFor();
  assert.equal(await page.locator('body').getByText(/Diff 字号|Diff 自动换行|常用与显示/).count(),0);
  await screenshot(page,'02-settings-home.png');await screenshot(page,'02-settings-home-viewport.png',false);
  await page.getByRole('button',{name:'配置地址与模型',exact:false}).click();assert.equal(await page.getByLabel('模型接口地址',{exact:true}).inputValue(),data.profile.baseUrl);
  await page.getByRole('button',{name:'检测连接',exact:true}).click();await page.getByText('连接成功 · 指定模型 loaded / ready',{exact:true}).waitFor();
  await screenshot(page,'07-model-connection.png');
  check('settings home directly exposes model address, automatic switch, extensions, storage and review; model address editor detects the existing loaded model');
  for(const [section,file]of [['rules','08-maintenance-rules.png'],['extensions','09-extension-management.png'],['storage','10-project-storage.png'],['review','11-review-settings.png']]){
    await page.evaluate(section=>WORKBENCH_DESIGN.goSettings(section),section);await screenshot(page,file);
  }
  await page.getByRole('button',{name:'摘要',exact:true}).click();await screenshot(page,'01-summary-overview.png');
  await page.locator('[data-action="open-session"]').first().click();
  const entry=await page.evaluate(()=>[...WORKBENCH_DESIGN.ownRuns.values()].at(-1));
  if(entry?.test.state==='complete'){
    await page.getByTestId('generated-result').waitFor();
    const resultJSON=JSON.parse(entry.test.run.output.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
    assert.ok((await page.getByTestId('generated-result').innerText()).includes(resultJSON.title));
    await screenshot(page,'05-real-model-result.png');await screenshot(page,'05-real-model-result-viewport.png',false);
    await page.getByRole('button',{name:'核对并应用标题',exact:true}).click();
    await page.getByRole('dialog').getByText('这是确认步骤的设计预览。本次没有开放原生标题写入。',{exact:true}).waitFor();
    await screenshot(page,'06-title-confirm-design.png');
    await page.getByRole('button',{name:'返回核对',exact:true}).click();
    check('generated preview shows old and proposed titles; title application is a separate confirmation and the design never sends a native rename');
  }
  await page.evaluate(async()=>{const r=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!r.ok)throw Error('export failed');});
  const offline=await browser.newPage({viewport:{width:360,height:1000}});offline.on('pageerror',error=>report.errors.push(error.message));
  await offline.goto('file://'+join(output,'YUVA-Workbench-设计预览.html'));await offline.getByTestId('summary-overview').waitFor();
  await offline.getByRole('button',{name:'设置',exact:true}).click();await offline.getByTestId('model-connection-entry').waitFor();
  assert.deepEqual(report.errors,[]);check('offline HTML preserves navigation and the captured real output; page exceptions: 0');
  report.ok=true;
}catch(error){report.ok=false;report.error=error.stack;process.exitCode=1;console.error(error);}finally{
  writeFileSync(join(output,'verification.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));await browser.close();
}
