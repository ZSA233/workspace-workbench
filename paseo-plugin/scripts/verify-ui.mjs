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
  await screenshot('01-clean-workbench.png');
  report.checks.push('real plugin panel loaded from the isolated host, empty state rendered');
  const file = join(ui.project,'one','ui-proof.txt');
  let started = Date.now();
  writeFileSync(file,'line one\nline two\n');
  await page.getByText('ui-proof.txt',{exact:true}).first().waitFor({timeout:7000});
  report.initialUpdateMs = Date.now()-started;
  await screenshot('02-automatic-refresh.png');
  await page.getByText('ui-proof.txt',{exact:true}).first().click();
  await page.getByText('line one',{exact:true}).waitFor();
  for (let n=0;n<10;n++) {
    const text=`automatic edit ${n}`;started=Date.now();appendFileSync(file,text+'\n');
    await page.getByText(text,{exact:true}).waitFor({timeout:7000});
    report.latenciesMs.push(Date.now()-started);
  }
  report.p95Ms=[...report.latenciesMs].sort((a,b)=>a-b)[Math.ceil(report.latenciesMs.length*.95)-1];
  assert.ok(report.p95Ms<=3000,`UI p95 exceeded 3 seconds: ${report.p95Ms}`);
  await screenshot('03-live-file-diff.png');
  report.checks.push('file click opened the real diff; ten disk edits appeared without manual refresh');
  let before;
  for(let n=0;n<30;n++){ before=await health(); if(!before.git.running&&!before.git.queued)break;await sleep(100); }
  await sleep(16_000);
  const after=await health();report.idle={seconds:16,gitCommands:after.git.commands-before.git.commands};assert.equal(report.idle.gitCommands,0);
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
