/** Actual bundled Paseo UI in a fresh headless browser and isolated daemon. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { backendRequest } from '../server/backend-supervisor.ts';
const exec = promisify(execFile);
const plugin = resolve(import.meta.dirname, '..'), root = resolve(plugin, '..');
const output = resolve(process.env.WORKBENCH_VERIFY_OUTPUT || join(root, '.local/verification/ui'));
mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, [join(plugin, 'scripts/verify-live.mjs')], {
  cwd: root, env: { ...process.env, WORKBENCH_LIVE_UI: '1' }, stdio: ['ignore','pipe','pipe'],
});
let logs = '', ui, browser;
const exited = new Promise(resolveExit => child.once('exit', code => resolveExit(code)));
child.stderr.on('data', b => { logs += b; });
const ready = new Promise((resolveReady, reject) => {
  const timer = setTimeout(() => reject(Error('isolated UI did not start')), 90_000);
  createInterface({ input: child.stdout }).on('line', line => {
    logs += line + '\n';
    try { const value = JSON.parse(line); if (value.kind === 'ui-ready') { clearTimeout(timer); resolveReady(value); } } catch {}
  });
  void exited.then(code => { clearTimeout(timer); reject(Error(`isolated host exited before UI: ${code}`)); });
});
const report = { kind: 'actual-paseo-headless-ui', checks: [], screenshots: [], latenciesMs: [], pageErrors: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  ui = await ready;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  page.on('pageerror', e => report.pageErrors.push(e.message));
  let measuringRpc = false;
  const rpcMethods = new Map();
  page.on('websocket', socket => socket.on('framesent', frame => {
    if (!measuringRpc || typeof frame.payload !== 'string') return;
    try {
      const value = JSON.parse(frame.payload);
      const message = value.type === 'session' ? value.message : value;
      if (message?.type !== 'plugin.rpc.invoke.request' || message.pluginId !== 'workspace-workbench-paseo') return;
      rpcMethods.set(message.method, (rpcMethods.get(message.method) || 0) + 1);
    } catch {}
  }));
  const screenshot = async name => { await page.screenshot({ path: join(output,name), fullPage: true }); report.screenshots.push(name); };
  const health = async () => { const response = await backendRequest(join(ui.project,'s.sock'), 'observer.health'); assert.ok(response?.ok); return response.result; };
  const panel = async () => {
    await page.getByText('Workspace Workbench',{exact:true}).first().click();
    await page.getByText('Repositories',{exact:true}).waitFor({timeout:15_000});
  };
  await page.goto(ui.url);
  await page.getByText('Add project',{exact:true}).first().click();
  await page.getByText('Search for directory',{exact:true}).click();
  await page.getByPlaceholder('Search directories or enter a path...').fill(ui.project);
  await page.getByText('Open this path',{exact:true}).click();
  await page.getByText('Workspace Workbench',{exact:true}).first().click();
  await page.getByText('Select project',{exact:true}).waitFor();
  await page.getByText(basename(ui.project),{exact:true}).last().click();
  await page.getByText('Repositories',{exact:true}).waitFor();
  await page.getByText('No file changes in this scope.',{exact:true}).waitFor();
  assert.equal(await page.getByText('Not loaded',{exact:true}).count(),0);
  await page.getByText('one · main',{exact:true}).click();
  await page.getByText(/current ref:/i).waitFor();
  report.checks.push('clicking a repository row opened the compact reference details drawer');
  await screenshot('01-clean-workbench.png');
  report.checks.push('real plugin panel loaded from the isolated host; clean repository rows had no misleading Not loaded label');
  await page.getByText('Main workspace',{exact:true}).first().click();
  await screenshot('01-orphan-candidate.png');
  await page.getByRole('button',{name:'Unclaimed legacy'}).click();
  await page.getByText('Adopt existing workspace',{exact:true}).waitFor();
  await page.getByText(/Source repository identified through Git worktrees/).waitFor();
  await page.getByText('Create branch',{exact:true}).first().click();
  await screenshot('01-orphan-adoption-preview.png');
  await page.getByText('Confirm adoption',{exact:true}).click();
  await page.getByText('Adopt existing workspace',{exact:true}).waitFor({state:'detached'});
  const adopted = await backendRequest(join(ui.project,'s.sock'),'workspace.detail',{workspaceId:'legacy'},5000);
  assert.ok(adopted?.ok);
  assert.equal(adopted.result.workspace.state,'active');
  assert.equal(adopted.result.repositories.length,3);
  assert.equal(adopted.result.repositories.filter(repo=>repo.branch).length,1);
  assert.ok(adopted.result.repositories.some(repo=>repo.repoPath==='extra'));
  await page.getByText('Repositories',{exact:true}).waitFor({timeout:20000});
  await page.getByText('extra · recovered/legacy/extra',{exact:true}).waitFor({timeout:20000});
  await page.getByText('No file changes in this scope.',{exact:true}).waitFor({timeout:20000});
  await page.getByText(/Reached the start of history/).first().waitFor({timeout:20000});
  await screenshot('01-orphan-adopted.png');
  await page.getByText('legacy',{exact:true}).first().click();
  await page.getByText('Main workspace',{exact:true}).last().click();
  report.checks.push('real UI discovered an orphan worktree, previewed it, adopted it with one optional branch, and switched to the managed workspace');
  await page.getByText('Main workspace',{exact:true}).first().click();
  const workspaceSearch = page.getByPlaceholder('Search workspaces…');
  await workspaceSearch.waitFor();
  await workspaceSearch.fill('legacy');
  await page.getByText('legacy',{exact:true}).first().waitFor();
  await workspaceSearch.fill('no-workspace-match-verify');
  await page.getByText('No matching workspaces',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Clear search'}).click();
  await page.getByText(/Commit (?:now|\d)/).first().waitFor({timeout:15_000});
  await page.getByRole('button',{name:'Open Workbench layout menu'}).click();
  await page.getByText('Created:',{exact:false}).waitFor();
  await page.getByText('Record updated:',{exact:false}).waitFor();
  await page.getByText('Latest commit:',{exact:false}).waitFor();
  await page.keyboard.press('Escape');
  report.checks.push('workspace dropdown search filtered names; open-triggered Git metadata populated compact commit ages and exact timestamps appeared in the menu');
  const file = join(ui.project,'one','ui-proof.txt');
  let started = Date.now();
  writeFileSync(file,'line one\nline two\n');
  await page.getByText('ui-proof.txt',{exact:true}).first().waitFor({timeout:7000});
  await page.getByText('+2',{exact:true}).first().waitFor({timeout:7000});
  assert.equal(await page.getByText('Not loaded',{exact:true}).count(),0);
  report.initialUpdateMs = Date.now()-started;
  await screenshot('02-automatic-refresh.png');
  report.checks.push('only the selected repository displayed calculated colored change counts');
  await page.getByText('ui-proof.txt',{exact:true}).first().click();
  await page.getByText('line one',{exact:true}).waitFor();
  for (let n=0;n<10;n++) {
    const text=`automatic edit ${n}`;started=Date.now();appendFileSync(file,text+'\n');
    await page.getByText(text,{exact:true}).waitFor({timeout:7000});
    report.latenciesMs.push(Date.now()-started);
  }
  report.p95Ms=[...report.latenciesMs].sort((a,b)=>a-b)[Math.ceil(report.latenciesMs.length*.95)-1];
  assert.ok(report.p95Ms<=3000,`UI p95 exceeded 3 seconds: ${report.p95Ms}`);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  appendFileSync(file,'while unfocused\n');
  await sleep(2500);
  assert.equal(await page.getByText('while unfocused',{exact:true}).count(),0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByText('while unfocused',{exact:true}).waitFor({timeout:7000});
  await screenshot('03-live-file-diff.png');
  report.checks.push('file click opened the real diff; ten disk edits appeared without manual refresh; blur paused updates and focus resumed them');
  let before;
  for(let n=0;n<30;n++){ before=await health(); if(!before.git.running&&!before.git.queued)break;await sleep(100); }
  measuringRpc = true;
  await sleep(16_000);
  measuringRpc = false;
  const after=await health();report.idle={seconds:16,gitCommands:after.git.commands-before.git.commands,rpcCalls:[...rpcMethods.values()].reduce((a,b)=>a+b,0),rpcMethods:Object.fromEntries(rpcMethods)};assert.equal(report.idle.gitCommands,0);
  assert.ok(report.idle.rpcCalls<=32,`idle Workbench RPC rate exceeded 2/s: ${report.idle.rpcCalls}/16s`);
  report.checks.push('visible UI generated zero additional Git commands during 16 idle seconds');
  await exec(process.env.PASEO_CLI || 'paseo',['plugin','reload','workspace-workbench-paseo','--host',new URL(ui.url).host,'--json'],{timeout:60_000});
  // Full plugin reload reconstructs the client bundle. File-tab selections are
  // currently memory-only, so explicitly reopen through the real navigation.
  await panel();
  await page.getByText('ui-proof.txt',{exact:true}).first().click();
  appendFileSync(file,'after plugin reload\n');
  await page.getByText('after plugin reload',{exact:true}).waitFor({timeout:15_000});
  await screenshot('04-after-plugin-reload.png');
  report.checks.push('plugin reload completed; reopening the file restored the current diff');
  const prior=await health();
  assert.equal(prior.process.configPath,join(ui.project,'project.json'));
  process.kill(prior.process.pid,'SIGKILL');
  await page.getByText('after plugin reload',{exact:true}).waitFor();
  await screenshot('05-retained-snapshot.png');
  started=Date.now();appendFileSync(file,'after backend recovery\n');
  await page.getByText('after backend recovery',{exact:true}).waitFor({timeout:25_000});
  const recovered=await health();assert.notEqual(recovered.process.pid,prior.process.pid);
  report.recovery={elapsedMs:Date.now()-started,beforePid:prior.process.pid,afterPid:recovered.process.pid,buildId:recovered.buildId};
  await screenshot('06-backend-recovered.png');
  report.checks.push('owned test backend crashed; existing page retained content and recovered automatically');
  unlinkSync(file);await panel();
  await page.getByText('No file changes in this scope.',{exact:true}).waitFor({timeout:10_000});
  await screenshot('07-empty-after-cleanup.png');
  report.checks.push('file deletion restored the clean/empty state');
  await page.getByRole('button',{name:'Open Workbench layout menu'}).click();
  await page.getByText(/^(选择仓库|Select repositories)$/).click();
  await page.getByText(/^(主工作区仓库范围|Main workspace repository scope)$/).waitFor();
  const secretCandidate = page.getByText(/go-secrets · (已发现|discovered)/);
  await secretCandidate.waitFor();
  assert.match(await secretCandidate.innerText(), /^○/);
  await screenshot('08-main-repository-picker.png');
  await page.getByText(/extra · (已发现|discovered)/).click();
  await page.getByText(/^(保存范围|Save scope)$/).click();
  await page.getByText(/^(主工作区仓库范围|Main workspace repository scope)$/).waitFor({state:'detached'});
  report.checks.push('main workspace repository picker showed go-secrets unchecked and selected a different unregistered repository without changing the managed catalog');
  await page.getByRole('button',{name:'Open Workbench layout menu'}).click();
  await page.getByText('Select Gitlink workspaces',{exact:true}).click();
  await page.getByText('Gitlink workspace scope',{exact:true}).waitFor();
  await page.getByText(/outer · 1 Gitlinks/).click();
  await page.getByText('Save scope',{exact:true}).last().click();
  await page.getByText('Gitlink workspace scope',{exact:true}).waitFor({state:'detached'});
  await page.getByText('Main workspace',{exact:true}).first().click();
  await page.getByText('outer',{exact:true}).last().click();
  await page.getByText('Child pointers',{exact:true}).waitFor();
  await page.getByText('halh',{exact:true}).last().click();
  await page.getByText(/Reached the start of history/).first().waitFor({timeout:10000});
  await screenshot('09-gitlink-workspace.png');
  report.checks.push('real Gitlink workspace appeared as one selectable workspace; its pointer selected the child repository');
  await page.getByRole('button',{name:'Open Workbench layout menu'}).click();
  await page.getByText('New Workspace',{exact:true}).last().click();
  await page.getByPlaceholder('Workspace name',{exact:true}).fill('ui-gitlink');
  await page.getByText('Workspace layout',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Create',exact:true}).last().click();
  await page.getByText('ui-gitlink',{exact:true}).first().waitFor({timeout:15000});
  const created = await backendRequest(join(ui.project,'s.sock'),'workspace.detail',{workspaceId:'ui-gitlink'},5000);
  assert.ok(created?.ok);
  assert.equal(created.result.workspace.layout,'gitlink');
  assert.deepEqual(created.result.repositories.map(repo=>repo.branch),['feature/ui-gitlink','feature/ui-gitlink']);
  await page.getByText('No file changes in this scope.',{exact:true}).waitFor({timeout:10000});
  await page.getByText('BASE',{exact:true}).first().waitFor({timeout:10000});
  await screenshot('10-created-gitlink-workspace.png');
  await page.setViewportSize({width:900,height:900});
  await screenshot('10-created-gitlink-workspace-narrow.png');
  await page.setViewportSize({width:1600,height:1050});
  report.checks.push('real UI created a nested Gitlink Workspace with a shared branch in outer and child repositories');
  await page.getByText('ui-gitlink',{exact:true}).first().click();
  await page.getByText('Main workspace',{exact:true}).last().click();
  await page.getByText(/Agent.*(Review|审核)/i).last().click();
  await page.getByText(/主工作区审核始终手动|Main workspace reviews are always manual/).waitFor();
  await screenshot('11-main-read-only-review.png');
  report.checks.push('main workspace exposes the independent read-only Agent Review tab');
  assert.deepEqual(report.pageErrors,[]);
  report.ok=true;
} catch(error) {
  report.ok=false;report.error=error.message;
  if(browser) for(const context of browser.contexts()) for(const page of context.pages()) {
    await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});
    writeFileSync(join(output,'failure-dom.txt'),await page.locator('body').innerText().catch(()=>''));
  }
  process.exitCode=1;
} finally {
  await browser?.close();
  if(ui)writeFileSync(ui.continueFile,'continue\n');
  const code=await Promise.race([exited,sleep(30_000).then(()=> 'timeout')]);
  if(code!==0){report.ok=false;report.lifecycleExit=code;process.exitCode=1;if(code==='timeout')child.kill('SIGTERM');}
  writeFileSync(join(output,'host.log'),logs);
  writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
