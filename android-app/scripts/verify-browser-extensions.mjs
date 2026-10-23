#!/usr/bin/env node
// Original Paseo 0.12 web UI + two actual plugins; only an isolated fixture is accepted.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
const require = createRequire(new URL('../../paseo-plugin/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: { fixture: { type: 'string' }, output: { type: 'string' } } });
assert(values.fixture, 'Pass --fixture LOG from POCKET_TEST_WORKBENCH=1 POCKET_TEST_EXTENSION_HELPER=1 serve-isolated-paseo.mjs');
const output = resolve(values.output || '/tmp/pocket-browser-extensions'); await mkdir(output, { recursive: true });
const fixture = (await readFile(values.fixture, 'utf8')).split('\n').flatMap(row => {
  try { const value = JSON.parse(row); return value.kind === 'actual-isolated-paseo-with-protocol-fixture' ? [value] : []; } catch { return []; }
}).at(-1);
assert(fixture?.project && new URL(fixture.url).hostname === '127.0.0.1' && /\/paseo-pocket-host-[^/]+$/.test(fixture.home), 'Only an isolated temporary fixture may be tested');
const project = JSON.parse(await readFile(fixture.projectConfig, 'utf8'));
assert.equal(project.sourceRoot, fixture.project);
const sources=await Promise.all(['pocket-extensions.js','pocket-extensions-core.js','pocket-extensions-paseo-0.12.js'].map(p=>readFile(root+'/android-app/app/src/main/assets/'+p,'utf8')));
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1400,height:1000},hasTouch:true});
const requests = []; let recording = false;
page.on('websocket', socket => socket.on('framesent', ({payload}) => { if (!recording) return; try { const walk = value => { if (!value || typeof value !== 'object') return; if (value.type === 'plugin.rpc.invoke.request' && value.pluginId === 'workspace-workbench-paseo') requests.push({ method: value.method, action: value.input?.method || value.input?.action }); for (const child of Object.values(value)) walk(child); }; walk(JSON.parse(String(payload))); } catch {} }));
const observeBusiness = async ms => { requests.length = 0; recording = true; await new Promise(r => setTimeout(r, ms)); recording = false; return requests.filter(value => value.method === 'workspace.workbench.query'); };
const report={kind:'actual-Paseo-012-two-plugins-Pocket-extension-QA',checks:[],errors:[],warnings:[],screenshots:[]};
page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(['warning','error'].includes(m.type()))report.warnings.push(m.text())});
await page.addInitScript(({sources,origin})=>{window.__extensionMessages=[];window.PocketExtensionsChannel={postMessage:s=>{const m=JSON.parse(s);window.__extensionMessages.push(m);if(m.type==='hello')queueMicrotask(()=>window.__pocketExtensions.activate(m.doc,'qa'))}};window.__pocketExtensions=(0,eval)(sources[0])({origin,token:'qa',webVersion:'0.12.0',bundleSha256:'0551012c13e098ebdd9ba96ef639952b84ba25a15e766d41b215c20841bd3381'},(0,eval)(sources[1]),(0,eval)(sources[2]));},{sources,origin:fixture.url});
const visible=l=>l.filter({visible:true}),wbTab=()=>page.getByTestId('pocket-tab-workspace-workbench-paseo-workbench'),wb=()=>page.getByTestId('pocket-panel-workspace-workbench-paseo-workbench'),ex=n=>page.getByTestId('pocket-tab-pocket-example-inspector-'+n),ep=n=>page.getByTestId('pocket-panel-pocket-example-inspector-'+n);
const shot=async name=>{await page.screenshot({path:output+'/'+name+'.png'});report.screenshots.push(name+'.png')};
try{
 await page.goto(fixture.url);await page.waitForFunction(()=>window.__paseoHostRuntimeStore?.getHosts().length);const initialHost=await page.evaluate(()=>window.__paseoHostRuntimeStore.getHosts()[0].serverId);await page.goto(fixture.url+'/h/'+initialHost+'/agent/'+fixture.agents[0]);await visible(page.getByRole('button',{name:'Open Workspace Workbench',exact:true})).waitFor();
 const workspaceRoute=page.url();await page.setViewportSize({width:390,height:844});await visible(page.getByRole('button',{name:'Open Workspace Workbench',exact:true})).waitFor({state:'hidden'});await page.getByTestId('workspace-explorer-toggle').click();
 await wbTab().waitFor();await ex(8).waitFor();assert.equal(await visible(page.getByTestId('workbench-graph-content')).count(),0);assert.equal(await page.getByTestId('example-context-1').count(),0);assert(await page.getByTestId('explorer-close').isVisible());
 report.unopenedBusinessRequests = await observeBusiness(4000); assert.deepEqual(report.unopenedBusinessRequests, []);
 await wbTab().click();await visible(page.getByTestId('workbench-graph-content')).waitFor();assert.equal(page.url(),workspaceRoute);await shot('01-workbench-sidebar');
 report.checks.push('Two real plugins expose nine extension tabs; unopened panels do not mount, the close control remains visible, and Workbench loads actual repository/graph data without navigation.');
 await wb().getByRole('tab', { name: 'Files', exact: true }).click();
 const initialFolder = wb().locator('[data-file-path="one"]'); await initialFolder.waitFor(); if (await initialFolder.getByTestId('geometric-icon-ChevronRight').count()) await initialFolder.click(); await wb().locator('[data-file-path="one/README.md"]').waitFor();
 await wb().locator('[data-file-path="one/README.md"]').click();
 await page.getByTestId('explorer-tab-files').click(); await new Promise(r => setTimeout(r, 1000));
 report.hiddenBusinessRequests = await observeBusiness(6000); assert.deepEqual(report.hiddenBusinessRequests, []);
 await wbTab().click(); await visible(wb().locator('[data-file-path="one/README.md"]')).waitFor();
 report.checks.push('Unopened Workbench starts zero business RPCs; the hidden idle Files panel stops its version/list/decorations queries and preserves its expanded directory on return.');
 for(let n=1;n<=8;n++){await ex(n).click();await page.getByTestId('example-rpc-'+n).getByText(/pocket-example RPC/).waitFor();assert((await page.getByTestId('example-context-'+n).innerText()).includes(fixture.agents[0]));}
 const proof=await page.evaluate(()=>({mounted:window.__pocketExampleProof.mounted,maximum:window.__pocketExampleProof.maximum,cacheShared:window.__pocketExampleProof.cacheShared,reads:window.__pocketExampleProof.reads}));assert.equal(proof.mounted,2);assert(proof.maximum<=2);assert(proof.cacheShared);report.proof=proof;
 const cdp = await page.context().newCDPSession(page);
 const memory = async () => { await cdp.send('HeapProfiler.collectGarbage'); const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value])); return { heapBytes: metrics.JSHeapUsedSize, nodes: (await cdp.send('Memory.getDOMCounters')).nodes }; };
 await cdp.send('Performance.enable'); report.retainedMemory = [await memory()];
 for (let batch = 0; batch < 2; batch++) {
   for (let n = 0; n < 30; n++) { await ex(n % 2 ? 8 : 7).click(); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
   report.retainedMemory.push(await memory());
 }
 assert.equal(await page.evaluate(() => window.__pocketExampleProof.reads), 8);
 assert.equal(await page.locator('[data-pocket-panel-key]').count(), 2);
 report.checks.push('Sixty retained-panel switches keep two mounts and eight initial example RPCs; collected heap and DOM counters are recorded after each batch.');
 await ep(8).getByRole('button',{name:'Retitle example tab'}).click();assert.equal(await ex(8).getAttribute('title'),'Retitled 8');await shot('02-other-plugin-and-overflow');
 report.checks.push('All eight independent example panels use their own real RPC and correct agent context; only two mounts survive LRU eviction, all share the installation query cache, and update() changes the title in place.');
 await page.getByTestId('explorer-close').click();await page.getByTestId('workspace-explorer-toggle').click();assert.equal(await ex(8).getAttribute('aria-selected'),'true');
 await page.reload();await page.getByTestId('workspace-explorer-toggle').click();await ep(8).waitFor();await visible(page.getByTestId('example-rpc-8')).waitFor();assert.equal(await ex(8).getAttribute('aria-selected'),'true');report.checks.push('Closing/reopening and full document reload restore the stable extension selection.');
 await page.emulateMedia({colorScheme:'dark'});await shot('03-dark-example');
 const hostId=new URL(page.url()).pathname.split('/')[2];
 await page.goto(fixture.url+'/h/'+hostId+'/agent/'+fixture.agents[1]);await page.getByTestId('workspace-explorer-toggle').click();await wbTab().waitFor();assert.equal(await ex(8).getAttribute('aria-selected'),'false');await ex(1).click();await page.getByTestId('example-rpc-1').getByText(/pocket-example RPC/).waitFor();assert((await page.getByTestId('example-context-1').innerText()).includes(fixture.agents[1]));
 await page.goto(workspaceRoute);await page.getByTestId('workspace-explorer-toggle').click();await ep(8).waitFor();assert.equal(await ex(8).getAttribute('aria-selected'),'true');report.checks.push('Two different Paseo Workspaces retain separate selections and validated agent ownership.');
 const saved=page.url();await wbTab().click();await visible(page.getByTestId('workbench-graph-content')).waitFor();await wb().getByRole('tab',{name:'Files',exact:true}).click();
 let entry=wb().locator('[data-file-path="one/README.md"]');const folder=wb().locator('[data-file-path="one"]');await folder.waitFor();if(await folder.getByTestId('geometric-icon-ChevronRight').count())await folder.click();await entry.waitFor();await entry.dblclick();await page.getByTestId('workbench-document-panel').waitFor();await page.getByTestId('workbench-document-panel').getByText('Pocket extension fixture',{exact:true}).waitFor();await visible(page.getByTestId('explorer-header')).waitFor({state:'hidden'});report.checks.push('Opening a real Markdown file from Workbench closes the mobile sidebar and uses the existing File Viewer in the workspace.');
 await page.getByRole('button',{name:/Back to files|返回文件/,exact:true}).click();
 await visible(page.getByTestId('explorer-header')).waitFor();await visible(wb()).waitFor();await visible(wb().locator('[data-file-path="one/README.md"]')).waitFor();
 report.checks.push('Returning to files restores the existing Workbench file selection and Files Tab.');
 const repository = join(fixture.project, 'one');
 const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
 const base = git('rev-parse', 'HEAD');
 await writeFile(join(repository, 'README.md'), '# Pocket extension fixture\n\nUpdated Diff content. ' + Date.now() + '\n');
 git('add', 'README.md'); git('commit', '-qm', 'Pocket comparison fixture'); const head = git('rev-parse', 'HEAD');
 await wb().getByRole('tab', { name: 'Git', exact: true }).click();
 await visible(page.getByTestId('workbench-graph-content')).waitFor();
 await wb().getByRole('button', { name: '比较仓库', exact: true }).first().click();
 await page.getByLabel('搜索引用或输入提交 SHA', { exact: true }).fill(base);
 await page.getByRole('button', { name: '使用此引用', exact: true }).click();
 await page.getByTestId('comparison-to').click();
 await page.getByLabel('搜索引用或输入提交 SHA', { exact: true }).fill(head);
 await page.getByRole('button', { name: '使用此引用', exact: true }).click();
 await page.getByTestId('comparison-sidebar').getByText('README.md', { exact: true }).click();
 await page.getByTestId('comparison-file-README.md').getByRole('button', { name: '单独打开 README.md', exact: true }).press('Enter');
 await page.getByTestId('workbench-diff-panel').getByTestId('diff-code-unified').first().waitFor();
 await visible(page.getByTestId('explorer-header')).waitFor({ state: 'hidden' });
 await page.getByTestId('workspace-explorer-toggle').click(); await visible(wb()).waitFor();
 report.checks.push('A real fixed comparison opens its existing Diff viewer and closes the sidebar; reopening retains Workbench.');
 // The repository comparison may ask for a new basis after its Git fixture changed.
 const picker = page.getByRole('button', { name: '关闭比较设置', exact: true });
 if ((await wb().getByTestId('comparison-from').innerText()).includes('选择起点')) await page.getByTestId('comparison-popover').waitFor();
 if (await visible(picker).count()) await visible(picker).last().click();
 await ex(8).click();await visible(ep(8)).waitFor();
 const reload=execFileSync('paseo',['plugin','reload','pocket-example','--host',new URL(fixture.url).host,'--json'],{encoding:'utf8',timeout:60000});assert.equal(JSON.parse(reload).status,'running');await ex(8).waitFor();await page.getByTestId('example-rpc-8').getByText(/pocket-example RPC/).waitFor();assert.equal(await ex(8).getAttribute('aria-selected'),'true');
 report.checks.push('Actual host reload retires the old plugin generation, remounts its new RPC context and preserves the selected stable Tab.');
 await page.context().setOffline(true);await new Promise(r=>setTimeout(r,800));assert.equal(await ex(8).getAttribute('aria-selected'),'true');await page.context().setOffline(false);report.checks.push('Temporary network loss retains the selected plugin Tab and cached content.');
 execFileSync('paseo', ['plugin', 'remove', 'pocket-example', '--host', new URL(fixture.url).host, '--json'], { encoding: 'utf8', timeout: 60000 });
 await ex(8).waitFor({ state: 'hidden' }); await wbTab().waitFor();
 assert.equal(await page.locator('[data-pocket-panel-key]').count(), 1);
 report.checks.push('Confirmed plugin removal clears its tabs and mounts while preserving the original sidebar and Workbench registration.');
 const fallback = await browser.newPage({ viewport: { width: 390, height: 844 } });
 fallback.on('pageerror', error => report.errors.push(error.message));
 await fallback.addInitScript(({sources,origin}) => { window.__pocketExtensions=(0,eval)(sources[0])({origin,token:'qa',webVersion:'0.12.0',bundleSha256:'unknown'},(0,eval)(sources[1]),(0,eval)(sources[2])); }, { sources, origin: fixture.url });
 await fallback.goto(fixture.url); await fallback.waitForFunction(() => window.__paseoHostRuntimeStore?.getHosts().length);
 const fallbackHost = await fallback.evaluate(() => window.__paseoHostRuntimeStore.getHosts()[0].serverId);
 await fallback.goto(fixture.url+'/h/'+fallbackHost+'/agent/'+fixture.agents[0]);
 await fallback.getByTestId('workspace-explorer-toggle').click(); await fallback.getByTestId('explorer-tab-files').click();
 await fallback.getByTestId('file-explorer-tree-scroll').waitFor(); assert.equal(await fallback.evaluate(() => !!window.Pocket), false);
 assert.equal(await fallback.locator('[data-pocket-tabs]').count(), 0); await fallback.close();
 report.checks.push('With an incompatible fingerprint the actual original page retains its built-in Files sidebar, without a Pocket API or extension tabs.');
 assert.deepEqual(report.errors,[]);report.url=page.url();report.title=await page.title();report.ok=true;
}catch(e){report.ok=false;report.failure=e.stack;report.body=(await page.locator('body').innerText()).slice(-5500);report.messages=await page.evaluate(()=>window.__extensionMessages);await shot('failure');throw e}
finally{await writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close()}
