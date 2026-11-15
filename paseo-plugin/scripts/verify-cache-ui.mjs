/** Actual isolated Paseo host; all Go cache paths and Git mutations are temporary. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright';
import { backendRequest } from '../server/backend-supervisor.ts';
import { loadConfig } from '../server/backend/config.ts';
import { openGlobalWorkbench } from './ui-project-selection.mjs';

const plugin = resolve(import.meta.dirname, '..');
const output = resolve(process.env.WORKBENCH_VERIFY_OUTPUT || join(plugin, '../.local/verification/cache'));
mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, [join(plugin, 'scripts/verify-live.mjs')], {
  env: { ...process.env, WORKBENCH_LIVE_UI: '1', WORKBENCH_LIVE_CACHE: '1', WORKBENCH_VERIFY_OUTPUT: output },
  stdio: ['ignore','pipe','pipe'],
});
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
const report = { kind: 'actual-isolated-paseo-cache-ui', checks: [], pageErrors: [], screenshots: [] };
async function waitFor(read, predicate, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('verification condition timed out');
}
function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright') : join(homedir(), '.cache/ms-playwright');
  for (const name of readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse()) {
    const executable = join(cache, name, process.platform === 'darwin' ? 'chrome-headless-shell-mac-arm64/chrome-headless-shell' : 'chrome-headless-shell-linux64/chrome-headless-shell');
    if (existsSync(executable)) return executable;
  }
  throw Error('Install a Playwright browser or set PLAYWRIGHT_CHROMIUM_EXECUTABLE');
}
try {
  ui = await ready;
  const socket = join(ui.project, 's.sock');
  const call = async (method, params = {}) => {
    const response = await backendRequest(socket, method, params, 30000);
    assert.ok(response.ok, JSON.stringify(response)); return response.result;
  };
  const config = loadConfig(join(ui.project, 'project.json'));
  const root = resolve(ui.project, '..'), globalBuild = join(root, 'global-go-build'), globalModule = join(root, 'global-go-mod');
  const projectBuild = join(config.cacheRoot, 'shared/go-build/go1.26/darwin-arm64'), projectModule = join(config.cacheRoot, 'shared/go-mod');
  for (const path of [globalBuild, globalModule, projectBuild, projectModule]) {
    mkdirSync(join(path, '00'), { recursive: true }); writeFileSync(join(path, '00', 'fixture-d'), Buffer.alloc(8192));
  }
  writeFileSync(join(projectModule, 'module-proof'), 'keep until module cleanup');
  const parent = await call('workspace.create', { name: 'cache-family', repositories: ['one'] });
  const childWorkspace = await call('workspace.create', { name: 'cache-child', repositories: ['one'], baseRefs: { one: parent.repositories[0].branch } });
  const recent = await call('workspace.create', { name: 'recent-proof', repositories: ['one'] });
  const commit = (workspace, date) => execFileSync('git', ['-C', workspace.repositories[0].worktreePath, 'commit', '--allow-empty', '-qm', 'Cache UI sorting proof'], {
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: 'pipe' });
  commit(childWorkspace, '2030-01-01T00:00:00Z'); commit(recent, '2029-01-01T00:00:00Z');
  // Enough rows to exercise the selector's existing virtual list and scroll anchor.
  let lastWorkspace;
  for (let index = 0; index < 13; index++) lastWorkspace = await call('workspace.create', { name: `space-${String(index).padStart(2,'0')}`, repositories: ['one'] });
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable() });
  page = await browser.newPage({ viewport: { width: 1000, height: 950 }, locale: 'en-US', colorScheme: 'light' });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.goto(ui.url);
  // Current host versions can show direct-connect and onboarding on a fresh home.
  const direct = page.getByText(/^(Direct connection|直接连接)$/).first();
  if (await direct.isVisible().catch(() => false)) {
    await direct.click(); await page.getByPlaceholder('localhost', { exact: true }).fill('127.0.0.1');
    await page.getByPlaceholder('6767', { exact: true }).fill(new URL(ui.url).port);
    await page.getByRole('button', { name: /^(Connect|连接)$/, exact: true }).click();
  }
  const skip = page.getByRole('button', { name: /^(Skip setup|跳过设置)$/, exact: true });
  await Promise.race([skip.waitFor().catch(() => {}), page.getByRole('button', { name: 'Workspace Workbench', exact: true }).first().waitFor()]);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await openGlobalWorkbench(page, 'a');
  await page.getByTestId('workbench-workspace-selector-toggle').waitFor({ timeout: 30000 });
  const selector = page.getByTestId('workbench-workspace-selector-toggle');
  const list = page.getByTestId('workbench-workspace-list');
  const ids = () => list.locator('[data-testid^="workspace-option-"]').evaluateAll(elements => elements.map(element => element.dataset.testid.slice(17)));
  await selector.click();
  await page.getByTestId('workspace-view-list').waitFor();
  await page.getByText('Latest commit ↓', { exact: true }).waitFor();
  await waitFor(ids, value => value[0] === 'cache-child' && value[1] === 'recent-proof');
  const sorted = await ids();
  await selector.click(); await selector.click();
  assert.deepEqual((await ids()).slice(0, 4), sorted.slice(0, 4), 'opening uses the existing commit snapshot immediately');
  await page.getByTestId('workspace-view-tree').click();
  await waitFor(ids, value => value[0] === 'cache-family' && value[1] === 'cache-child');
  report.checks.push('list defaults, newest commit order, stable reopen and source tree grouping');
  await page.getByTestId('workspace-view-list').click();
  await page.getByTestId('workspace-option-recent-proof').locator('[role="button"]').first().click();
  await selector.click();
  commit(recent, '2031-01-01T00:00:00Z');
  // Close before any scan started with the new HEAD; reopen must discover it inside TTL.
  await selector.click(); await selector.click();
  await waitFor(ids, value => value[0] === 'recent-proof');
  assert.ok((await selector.innerText()).includes('recent-proof'));
  for (let index = 0; index < 3; index++) { await selector.click(); await selector.click(); }
  await waitFor(ids, value => value[0] === 'recent-proof');
  report.checks.push('new HEAD inside TTL, rapid close/reopen and selected Workspace retained');
  const scrollState = async (offset) => list.evaluate((element, offset) => {
    const scroller = [element, ...element.querySelectorAll('*')].find(node => node.scrollHeight > node.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(node).overflowY));
    if (!scroller) throw Error('selector scroll container unavailable');
    if (offset !== null) { scroller.scrollTop = offset; scroller.dispatchEvent(new Event('scroll')); }
    const viewport = scroller.getBoundingClientRect();
    const first = [...element.querySelectorAll('[data-testid^="workspace-option-"]')].find(node => node.getBoundingClientRect().bottom > viewport.top + 2);
    return { offset: scroller.scrollTop, first: first?.dataset.testid, delta: first?.getBoundingClientRect().top - viewport.top };
  }, offset ?? null);
  await scrollState(210); await page.waitForTimeout(50); const anchored = await scrollState();
  commit(lastWorkspace, '2032-01-01T00:00:00Z');
  await page.getByTestId('workbench-workspace-header').getByRole('button', { name: /^(Observation.*|Refreshing|Refresh temporarily failed)$/ }).click();
  await page.getByRole('button', { name: 'Refresh now', exact: true }).click();
  await waitFor(ids, value => value[0] === 'space-12');
  const afterSort = await scrollState(); assert.equal(afterSort.first, anchored.first); assert.ok(Math.abs(afterSort.delta - anchored.delta) <= 2);
  report.checks.push('manual commit refresh preserves the first visible Workspace and its pixel position');
  await page.getByTestId('workspace-view-tree').click(); await selector.click();
  await page.reload(); await openGlobalWorkbench(page, 'a'); await selector.click();
  await page.getByText('Latest in group ↓', { exact: true }).waitFor();
  await page.getByTestId('workspace-view-list').click();
  const screenshot = async name => { await page.screenshot({ path: join(output, name), animations: 'disabled' }); report.screenshots.push(name); };
  await screenshot('selector-list-light.png');
  await page.getByTestId('workspace-view-tree').click(); await screenshot('selector-tree-light.png'); await selector.click();
  const cacheTab = page.getByText(/^(Caches & space|缓存与空间)$/, { exact: true });
  await cacheTab.click(); await page.getByTestId('workbench-cache-panel').waitFor();
  const inventory = await waitFor(() => call('cache.list'), value => value.observedAt && !['running','queued'].includes(value.task?.state));
  assert.ok(inventory.resources.every(resource => resource.providerId === 'go'));
  assert.ok(inventory.resources.some(resource => resource.scope === 'project' && resource.references.length > 1));
  assert.ok(inventory.resources.some(resource => resource.kind === 'build' && resource.paths.includes(projectBuild)));
  await waitFor(() => page.getByTestId('workbench-cache-panel').innerText(), value => /[KM]iB/.test(value));
  await screenshot('cache-light.png');
  const target = inventory.resources.find(resource => resource.scope === 'project' && resource.kind === 'build');
  await page.getByTestId(`cache-clean-${target.id}`).click();
  await page.getByTestId('cache-confirm-cleanup').waitFor(); assert.ok((await page.locator('body').innerText()).includes(projectBuild));
  await screenshot('cache-cleanup-preview.png'); await page.getByTestId('cache-confirm-cleanup').click();
  await waitFor(() => call('cache.task'), value => value.kind === 'cleanup' && value.state === 'complete');
  assert.equal(readFileSync(join(projectModule, 'module-proof'), 'utf8'), 'keep until module cleanup');
  assert.ok(!existsSync(join(projectBuild, '00', 'fixture-d')));
  await waitFor(() => call('cache.list'), value => value.observedAt && !['running','queued'].includes(value.task?.state) && value.resources.find(resource => resource.id === target.id)?.usage.bytes < target.usage.bytes);
  report.checks.push('generic grouped cache page, shared references, async statistics, fixed-path native build cleanup keeps modules intact');
  await page.emulateMedia({ colorScheme: 'dark' });
  // The host recreates plugin surfaces when its theme changes; global routing
  // intentionally requires an explicit project choice in the new surface.
  await openGlobalWorkbench(page, 'a'); await cacheTab.click();
  await page.getByTestId('workbench-cache-panel').waitFor();
  await screenshot('cache-dark.png');
  // Resize the actual host panel, keeping its real theme and component tree.
  const surface = page.locator('[aria-label="Workspace Workbench"]').filter({ has: page.getByTestId('workbench-cache-panel') }).last();
  await surface.evaluate(element => Object.assign(element.style, { width: '390px', maxWidth: '390px', height: '844px', maxHeight: '844px', alignSelf: 'flex-start' }));
  await screenshot('cache-narrow-dark.png');
  const overflow = await page.getByTestId('workbench-cache-panel').evaluate(element => element.scrollWidth > element.clientWidth + 1);
  assert.equal(overflow, false);
  report.checks.push('remembered view, light/dark and 390px actual web-host panel; no horizontal cache-page overflow');
  await page.getByRole('button', { name: 'Open Workbench layout menu', exact: true }).click();
  await page.getByRole('button', { name: 'Switch project', exact: true }).click();
  await page.getByText('b', { exact: true }).filter({ visible: true }).last().click();
  await page.getByTestId('workbench-workspace-selector-toggle').waitFor(); await cacheTab.click();
  await waitFor(() => page.getByTestId('workbench-cache-panel').innerText(), value => value.includes('/b/'));
  assert.ok(!(await page.getByTestId('workbench-cache-panel').innerText()).includes('cache-family'));
  report.checks.push('switching projects cannot display the previous project’s cache or Workspace rows');
  assert.equal(report.pageErrors.length, 0, report.pageErrors.join('\n')); report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack; process.exitCode = 1;
  if (page) { report.visible = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); }
} finally {
  await browser?.close();
  if (ui) writeFileSync(ui.continueFile, 'continue\n'); else child.kill('SIGTERM');
  report.hostExitCode = await exit;
  if (report.hostExitCode !== 0) { report.ok = false; process.exitCode = 1; }
  writeFileSync(join(output, 'host.log'), logs); writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output }, null, 2));
}
