/** Actual isolated host with delayed browser transport; no production registry writes. */
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, mkdtempSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { backendRequest } from '../server/backend-supervisor.ts';
const exec = promisify(execFile);
const plugin = resolve(import.meta.dirname, '..');
const output = process.env.WORKBENCH_VERIFY_OUTPUT || '/tmp/workbench-cold-graph-ui';
mkdirSync(output, { recursive: true });
const realStatus = process.env.WORKBENCH_COLD_GRAPH_REAL_STATUS === '1';
const bin = realStatus ? mkdtempSync('/tmp/wb-cold-git-') : null;
const gate = join(output, 'hold-status'), entered = join(output, 'status-entered');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
if (bin) {
  const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh
case "$PWD" in */cold-graph-*/one)
  for arg in "$@"; do
    if [ "$arg" = status ] && [ -e ${quote(gate)} ]; then
      touch ${quote(entered)}
      while [ -e ${quote(gate)} ]; do sleep 0.05; done
      break
    fi
  done;;
esac
exec ${quote(actualGit)} "$@"
`, { mode: 0o755 });
}
const child = spawn(process.execPath, [join(plugin, 'scripts/verify-live.mjs')], { env: { ...process.env, WORKBENCH_LIVE_UI: '1', ...(bin ? { PATH: `${bin}:${process.env.PATH}` } : {}) }, stdio: ['ignore','pipe','pipe'] });
let ui, browser, page, logs = '';
const exit = new Promise(resolve => child.once('exit', resolve));
child.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('isolated host readiness timeout')), 90000);
  createInterface({ input: child.stdout }).on('line', line => {
    logs += line + '\n';
    try { const value = JSON.parse(line); if (value.kind === 'ui-ready') { clearTimeout(timer); resolve(value); } } catch {}
  });
  void exit.then(code => { clearTimeout(timer); reject(Error(`host exited: ${code}`)); });
});
const report = { mode: realStatus ? 'actual-git-status-gate' : 'simulated-partial-control-response', checks: [], pageErrors: [] };
const until = async predicate => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error('explicit readiness condition was not reached');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
try {
  ui = await ready;
  const git = async (path, args) => (await exec('git', ['-C', path, ...args])).stdout.trim();
  const workspaces = [];
  for (let i = 0; i < (realStatus ? 6 : 12); i++) {
    const name = `cold-graph-${i}`;
    const result = await backendRequest(join(ui.project, 's.sock'), 'workspace.create', { name, repositories: ['one','two','three'] }, 30000);
    assert.ok(result.ok, JSON.stringify(result));
    const tree = result.result.repositories[0].worktreePath;
    writeFileSync(join(tree, 'README'), `Cold graph proof ${name}\n`);
    await git(tree, ['commit', '-qam', `Cold graph proof ${name}`]);
    if (i % 2) writeFileSync(join(result.result.repositories[0].worktreePath, 'README'), 'uncommitted cold fixture\n');
    workspaces.push(name);
  }
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  const tasks = new Map();
  report.refreshControls = [];
  page.on('websocket', socket => socket.on('framesent', frame => {
    const value = String(frame.payload);
    if (value.includes('observer.refresh')) report.refreshControls.push({ at: Date.now(), action: /\"action\":\"(start|status|release)\"/.exec(value)?.[1] || 'unknown' });
  }));
  report.controlResponses = [];
  await page.routeWebSocket('**/*', socket => {
    const server = socket.connectToServer();
    server.onMessage(message => {
      let altered = false;
      try {
        const value = JSON.parse(String(message));
        const visit = data => {
          if (!data || typeof data !== 'object') return;
          if (data.protocol === 1 && data.taskId && data.result?.regions) {
            const count = tasks.get(data.taskId) || 0;
            tasks.set(data.taskId, count + 1);
            report.controlResponses.push({ workspaceId: data.result.regions.summary?.result?.workspaceId, repoPath: data.result.regions.summary?.result?.repoPath, taskId: data.taskId, state: data.state, count, regions: Object.fromEntries(Object.entries(data.result.regions).map(([area, region]) => [area, region.state])) });
            // Force the initial control response through polling, even on fast Git.
            if (!realStatus && count < 2 && data.state === 'ready' && data.result.regions.graph && data.result.regions.summary?.result?.workspaceId?.startsWith('cold-graph-')) {
              data.state = 'running';
              for (const [area, region] of Object.entries(data.result.regions)) {
                region.state = 'running';
                if (area === 'summary' && region.result?.repository) {
                  region.result.repository.observationPending = true;
                  region.result.repository.dirty = null;
                  region.result.repository.status = 'unknown';
                } else delete region.result;
              }
              altered = true;
            }
          }
          for (const nested of Object.values(data)) visit(nested);
        };
        visit(value);
        if (altered) message = JSON.stringify(value);
      } catch {}
      setTimeout(() => { try { socket.send(message); } catch {} }, 100);
    });
  });
  await page.goto(ui.url);
  await page.getByText('Add project', { exact: true }).first().click();
  await page.getByText('Search for directory', { exact: true }).click();
  await page.getByPlaceholder('Search directories or enter a path...').fill(ui.project);
  await page.getByText('Open this path', { exact: true }).click();
  await page.getByText('Workspace Workbench', { exact: true }).first().click();
  await page.getByTestId('workbench-graph-content').waitFor({ timeout: 30000 });
  let current = 'Main workspace';
  report.coldSelections = [];
  for (const workspace of workspaces) {
    if (realStatus) { if (existsSync(entered)) unlinkSync(entered); writeFileSync(gate, 'hold'); }
    await page.getByText(current, { exact: true }).first().click();
    await page.getByPlaceholder('Search workspaces…').fill(workspace);
    await page.getByText(workspace, { exact: true }).last().click();
    const started = Date.now();
    await page.getByTestId('workbench-graph-content').getByText(`Cold graph proof ${workspace}`, { exact: false }).waitFor({ timeout: 15000 });
    const elapsedMs = Date.now() - started;
    if (realStatus) {
      await until(() => existsSync(entered));
      assert.ok(existsSync(gate), 'graph must become visible before releasing Git status');
      await page.screenshot({ path: join(output, `${workspace}-graph-before-status.png`) });
      await page.getByTestId('workbench-graph-content').getByText(`Cold graph proof ${workspace}`, { exact: false }).click();
      await page.getByText('Selected commit', { exact: true }).waitFor();
      unlinkSync(gate);
      await until(() => report.controlResponses.some(value => value.workspaceId === workspace && value.repoPath === 'one' && value.regions.summary === 'ready' && value.regions.graph === 'ready'));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.getByText('Selected commit', { exact: true }).waitFor();
    }
    report.coldSelections.push({ workspace, elapsedMs, ...(realStatus ? { graphVisibleBeforeStatusRelease: true, selectionRetainedAfterSummary: true } : {}) });
    current = workspace;
  }
  report.checks.push(`${workspaces.length} never-opened workspaces displayed their first graph without switching repository; ${realStatus ? 'real Git status remained blocked until the graph was visible' : 'partial summary responses did not cancel graph reads'}`);
  assert.equal(report.pageErrors.length, 0);
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack;
  if (page) { report.visible = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); }
  process.exitCode = 1;
} finally {
  if (existsSync(gate)) unlinkSync(gate);
  await browser?.close();
  if (ui) writeFileSync(ui.continueFile, 'continue\n'); else child.kill('SIGTERM');
  const code = await exit;
  report.hostExitCode = code;
  if (code !== 0) { report.ok = false; process.exitCode = 1; }
  if (bin) rmSync(bin, { recursive: true, force: true });
  writeFileSync(join(output, 'host.log'), logs);
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
