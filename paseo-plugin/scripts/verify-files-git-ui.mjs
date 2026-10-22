/** Git file-tree acceptance with a real isolated Paseo plugin + Chromium UI. Never touches the normal host or registry. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
const plugin = resolve(import.meta.dirname, '..'), output = resolve(process.env.WORKBENCH_VERIFY_OUTPUT || await mkdtemp(join(tmpdir(), 'wb-files-git-ui-')));
await mkdir(output, { recursive: true });
let child, client, browser, ui, logs = '';
const report = { output, runner: 'Playwright Chromium', console: [], flow: 'Workspace > Files > expand real Git paths > colored file letters, directory dots and ignored items', kind: 'actual-paseo-files-git-chromium', checks: [], errors: [], screenshots: [], limitations: ['Actual Paseo plugin in Chromium. Windows native and physical Pocket remain separate acceptance targets; touch here uses a 1100px emulated viewport.'] };
const check = message => { report.checks.push(message); console.log(JSON.stringify({ check: message })); };
const pause = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, timeout = 20000) => { const until = Date.now()+timeout; while (Date.now()<until) { const value = await fn(); if (value) return value; await pause(100); } throw Error('Timed out waiting for file proof'); };
try {
  if (process.env.WORKBENCH_FILES_HOST_LOG) ui = JSON.parse((await readFile(process.env.WORKBENCH_FILES_HOST_LOG, 'utf8')).split('\n').find(line => line.includes('"ui-ready"')));
  else {
    child = spawn(process.execPath, [join(plugin, 'scripts/verify-live.mjs')], { cwd: resolve(plugin, '..'), env: { ...process.env, WORKBENCH_LIVE_UI: '1', WORKBENCH_VERIFY_OUTPUT: output }, stdio: ['ignore', 'pipe', 'pipe'] });
    ui = await new Promise((resolveReady, reject) => { const timer = setTimeout(() => reject(Error('Isolated host did not start')), 90000); child.stderr.on('data', b => { logs += b; }); createInterface({ input: child.stdout }).on('line', line => { logs += line+'\n'; try { const value=JSON.parse(line); if(value.kind==='ui-ready') { clearTimeout(timer); resolveReady(value); } } catch {} }); child.once('exit', code => { clearTimeout(timer); reject(Error('Host exited: '+code)); }); });
  }
  if (child) await writeFile(join(output, 'git-files-ui-host.log'), logs);
  assert.match(ui.project, /^\/(?:private\/)?tmp\/wb-live-[^/]+\/a$/);
  client = new DaemonClient({ url: `ws://${new URL(ui.url).host}/ws`, clientId: 'git-files-proof', clientType: 'mcp', reconnect: { enabled: false }, webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }) }); await client.connect();
  const projectConfig = join(ui.project, 'project.json');
  const observer = async (method, params={}) => { const response = await client.invokePluginRpc('workspace-workbench-paseo', 'workspace.workbench.query', { projectConfig, method, params }); assert.ok(response.ok, JSON.stringify(response.error)); return response.result; };
  await observer('workspace.create', { name: 'file-proof-space', repositories: ['one'] });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.on('pageerror', e => report.errors.push(e.message)); page.on('console', message => { if (['warning','error'].includes(message.type())) report.console.push({ type: message.type(), text: message.text() }); });
  await page.goto(ui.url);
  await page.getByText('Workspace Workbench', { exact: true }).first().waitFor({ timeout: 20000 }); await pause(1000);
  if (await page.getByText('Add project', { exact: true }).first().isVisible().catch(() => false)) { await page.getByText('Add project', { exact: true }).first().click(); await page.getByText('Search for directory', { exact: true }).click(); await page.getByPlaceholder('Search directories or enter a path...').fill(ui.project); await page.getByText('Open this path', { exact: true }).click(); }
  await page.getByText('Workspace Workbench', { exact: true }).first().click();
  await page.getByText('Repositories', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 20000 });
  await page.getByText('Files', { exact: true }).click(); await page.locator('[data-file-path=""]').waitFor({ timeout: 20000 }); await page.locator('[data-file-path="one"]').waitFor({timeout:20000});
  const repo = join(ui.project,'one'), git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:'pipe'}).trim();
  const put=async(path,value)=>{await mkdir(join(repo,path.split('/').slice(0,-1).join('/')),{recursive:true});await writeFile(join(repo,path),value);};
  for(const name of ['src/changed.ts','src/staged.ts','old/rename.ts','removed/file.txt','conflicts/merge.ts','assets/photo.png','settings.toml']) await put(name,'initial '+name+'\n');
  await put('.gitignore','dist/\n*.tmp\n'); git('add','.gitignore','src','old','removed','conflicts','assets','settings.toml');git('commit','-qm','Git decoration fixture');
  const branch=git('branch','--show-current');git('checkout','-qb','decoration-conflict');await put('conflicts/merge.ts','other\n');git('commit','-qam','other side');git('checkout','-q',branch);await put('conflicts/merge.ts','main\n');git('commit','-qam','main side');try{git('merge','decoration-conflict');}catch{}
  await put('src/changed.ts','modified\n');await put('src/staged.ts','staged\n');git('add','src/staged.ts');await put('src/staged.ts','staged then edited\n');await put('src/added.py','added');git('add','src/added.py');
  await put('src/cache.tmp','ignored');await put('dist/generated.js','ignored build');await mkdir(join(repo,'moved'));git('mv','old/rename.ts','moved/renamed.ts');await rm(join(repo,'removed/file.txt'));
  for(let i=0;i<80;i++)await put(`src/item-${String(i).padStart(3,'0')}.ts`,'new file');
  assert.equal((await observer('observer.health')).fileDecorationsProtocol,1);
  await page.locator('[data-file-path="one"]').click();await page.locator('[data-file-path="one/src"]').waitFor({timeout:20000});
  await page.getByText('↻ Refresh',{exact:true}).click();
  const row=path=>page.locator(`[data-file-path="${path}"]`);
  await wait(async()=>await row('one/conflicts').getAttribute('data-git-mark')==='!');
  assert.equal(await row('one/src').getAttribute('data-git-mark'),'M');assert.equal(await row('one/dist').getAttribute('data-git-ignored'),'true');
  assert.equal(await row('one/dist').getAttribute('data-git-mark'),'');assert.match(await row('one/dist').getAttribute('title'),/\.gitignore:1.*dist\//);
  await row('one/dist').hover();assert.match(await row('one/dist').getAttribute('title'),/ignored/);
  await row('one/dist').click({button:'right'});await page.getByText(/Git: ignored; untracked content/).waitFor();await page.getByText('Copy',{exact:true}).last().click();
  check('actual Git colors reach collapsed directories; ignored folders show their source rule in hover and context menu and remain copyable');
  await row('one/moved').click();await wait(async()=>await row('one/moved/renamed.ts').getAttribute('data-git-mark')==='R');assert.match(await row('one/moved/renamed.ts').getAttribute('title'),/From：one\/old\/rename.ts/);
  await row('one/moved').click();await row('one/src').click();await row('one/src/changed.ts').waitFor({timeout:15000});
  await wait(async()=>await row('one/src/changed.ts').getAttribute('data-git-mark')==='M');assert.equal(await row('one/src/added.py').getAttribute('data-git-mark'),'A');assert.equal(await row('one/src/cache.tmp').getAttribute('data-git-ignored'),'true');
  assert.ok(await row('one/src/changed.ts').locator('[data-testid="geometric-icon-FileCode"]').count());assert.ok(await row('one/src/cache.tmp').locator('[data-testid="geometric-icon-File"]').count());
  const size=await row('one/src/changed.ts').evaluate(el=>({height:el.getBoundingClientRect().height,font:[...el.querySelectorAll('*')].find(e=>e.textContent==='changed.ts')&&getComputedStyle([...el.querySelectorAll('*')].find(e=>e.textContent==='changed.ts')).fontSize}));assert.equal(size.height,22);assert.equal(size.font,'12px');report.density=size;
  await page.screenshot({path:join(output,'git-tree-initial.png')});report.screenshots.push('git-tree-initial.png');
  check('dense rendered file rows keep 22px height and 12px names with separate Git letters and neutral code icons');
  const beforeColor=await row('one/src/cache.tmp').evaluate(el=>getComputedStyle([...el.querySelectorAll('*')].find(e=>e.textContent==='cache.tmp')).color);report.initialIgnoredColor=beforeColor;
  await page.emulateMedia({colorScheme:'dark'});await pause(1000);if(!await row('one/src/cache.tmp').count()){await page.getByText('Files',{exact:true}).filter({visible:true}).click();await row('one/src/cache.tmp').waitFor({timeout:20000});}report.darkIgnoredColor=await row('one/src/cache.tmp').evaluate(el=>getComputedStyle([...el.querySelectorAll('*')].find(e=>e.textContent==='cache.tmp')).color);
  await page.screenshot({path:join(output,'git-tree-dark-system.png')});report.screenshots.push('git-tree-dark-system.png');
  report.themeSwitched=beforeColor!==report.darkIgnoredColor;
  if(!report.themeSwitched)report.limitations.push('Host did not follow system color preference; actual second theme still needs UI verification.');
  else check('host system theme switching updates ignored-item contrast while retaining compact density');

  const stagedRow=row('one/src/item-050.ts');await stagedRow.scrollIntoViewIfNeeded();await stagedRow.click();
  const selection=await stagedRow.getByRole('button').evaluate(el=>({color:getComputedStyle(el).backgroundColor,y:el.getBoundingClientRect().y}));assert.notEqual(selection.color,'rgba(0, 0, 0, 0)');
  git('add','src/item-050.ts');await wait(async()=>await stagedRow.getAttribute('data-git-mark')==='A');
  const after=await stagedRow.getByRole('button').evaluate(el=>({color:getComputedStyle(el).backgroundColor,y:el.getBoundingClientRect().y}));assert.equal(after.color,selection.color);assert.ok(Math.abs(after.y-selection.y)<1);
  check('real index changes update U to A without replacing directory pages, selection or scroll');
  await page.getByText('Main workspace',{exact:true}).first().click();await page.getByText('file-proof-space',{exact:true}).first().click();
  await wait(async()=>/Git: 0 uncommitted/.test(await row('one').getAttribute('title')||''));assert.equal(await row('one').getAttribute('data-git-mark'),'');
  await page.getByText('file-proof-space',{exact:true}).first().click();await page.getByText('Main workspace',{exact:true}).first().click();await stagedRow.waitFor({timeout:15000});assert.equal(await stagedRow.getAttribute('data-git-mark'),'A');
  check('switching Workspaces isolates clean and changed decorations and restores the previous tree');
  const mobileContext=await browser.newContext({viewport:{width:1100,height:900},hasTouch:true,isMobile:true,colorScheme:'dark'}), mobile=await mobileContext.newPage();
  mobile.on('pageerror',error=>report.errors.push('touch: '+error.message)); mobile.on('console', message => { if (['warning','error'].includes(message.type())) report.console.push({ type: message.type(), text: 'touch: '+message.text() }); });
  await mobile.goto(ui.url);await mobile.getByText('Workspace Workbench',{exact:true}).first().waitFor({timeout:20000});await mobile.getByText('Workspace Workbench',{exact:true}).first().click();await mobile.getByText('Files',{exact:true}).filter({visible:true}).click();await mobile.locator('[data-file-path="one"]').waitFor({timeout:20000});await mobile.locator('[data-file-path="one"]').tap();
  const ignoredTouch=mobile.locator('[data-file-path="one/dist"]');await ignoredTouch.waitFor({timeout:15000});await wait(async()=>await ignoredTouch.getAttribute('data-git-ignored')==='true');
  const touchBox=await ignoredTouch.boundingBox();assert.equal(touchBox.height,30);report.touchRowHeight=touchBox.height;
  const cdp=await mobileContext.newCDPSession(mobile);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchBox.x+60,y:touchBox.y+15}]});await pause(850);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await mobile.getByText(/Git: ignored; untracked content/).waitFor({timeout:10000});await mobile.getByText('Copy',{exact:true}).last().waitFor();await pause(350);assert.equal(await mobile.getByText('Confirm',{exact:true}).count(),0,'long-press release must not activate a newly mounted menu item');await mobile.screenshot({path:join(output,'git-touch-long-press.png')});report.screenshots.push('git-touch-long-press.png');
  await mobile.getByText('Copy',{exact:true}).last().tap();await mobile.getByText(/1 copied$/).waitFor({timeout:5000});check('actual Chromium touch events open the existing file menu, suppress release click-through and allow the next menu tap; coarse-pointer rows are 30px');await mobileContext.close();
  report.page={url:page.url(),title:await page.title(),nonBlank:(await page.locator('body').innerText()).includes('Workspace Workbench'),frameworkOverlay:await page.locator('vite-error-overlay,nextjs-portal').count()};
  assert.ok(report.page.nonBlank);assert.equal(report.page.frameworkOverlay,0);

  assert.deepEqual(report.errors, []); assert.equal(report.console.some(message => message.type === 'error'), false); report.ok = true;
} catch (e) { report.ok = false; report.error = e.stack || String(e); if (browser) { const page = browser.contexts().at(-1)?.pages().at(-1); if (page) { await page.screenshot({ path: join(output, 'git-files-failure.png') }).catch(() => {}); await writeFile(join(output, 'git-files-failure.txt'), await page.locator('body').innerText().catch(() => '')); } } process.exitCode=1; }
finally { await browser?.close(); await client?.close(); if (ui && child) { await writeFile(ui.continueFile, 'done'); await Promise.race([new Promise(r => child.once('exit', r)), pause(30000)]); } await writeFile(join(output, 'git-files-ui-report.json'), JSON.stringify(report,null,2)); await writeFile(join(output, 'git-files-ui-host.log'), logs); console.log(JSON.stringify(report,null,2)); }
