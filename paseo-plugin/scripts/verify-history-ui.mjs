/** Actual isolated host with delayed browser transport; no production registry writes. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { backendRequest } from '../server/backend-supervisor.ts';
const exec = promisify(execFile);
const plugin = resolve(import.meta.dirname, '..');
const output = process.env.WORKBENCH_VERIFY_OUTPUT || '/tmp/workbench-history-ui';
mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, [join(plugin, 'scripts/verify-live.mjs')], { env: { ...process.env, WORKBENCH_LIVE_UI: '1' }, stdio: ['ignore','pipe','pipe'] });
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
const report = { checks: [], pageErrors: [], frames: [], delayedResponses: 0 };
try {
  ui = await ready;
  const git = async (path, args) => (await exec('git', ['-C', path, ...args])).stdout.trim();
  const source = join(ui.project, 'one');
  for (let i = 0; i < 110; i++) await git(source, ['commit', '--allow-empty', '-qm', `History sample ${i}`]);
  const created = await backendRequest(join(ui.project, 's.sock'), 'workspace.create', { name: 'history-continuity', repositories: ['one'] }, 30000);
  assert.ok(created.ok, JSON.stringify(created));
  const worktree = created.result.repositories[0].worktreePath;
  for (let i = 0; i < 2; i++) {
    for (const file of ['README', 'OTHER']) writeFileSync(join(worktree, file), Array.from({ length: 200 }, (_, line) => `${file} sample ${i} line ${line}`).join('\n') + '\n');
    await git(worktree, ['add', 'README', 'OTHER']);
    await git(worktree, ['commit', '-qm', `Feature sample ${i}`]);
  }
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  let delayed = false, injectGraphFailure = false;
  let faultDelivered;
  const faultSeen = new Promise(resolve => { faultDelivered = resolve; });
  report.injectedGraphFailures = 0;
  const inject = value => {
    if (!value || typeof value !== 'object') return;
    if (value.regions?.graph?.result?.nodes?.length > 100) {
      value.regions.graph = { state: 'failed', phase: 'history-and-refs', error: { code: 'git_timeout', message: 'Injected UI recovery test failure' } };
      value.outcome = 'partial-failure'; report.injectedGraphFailures++; faultDelivered();
    }
    for (const child of Object.values(value)) inject(child);
  };
  await page.routeWebSocket('**/*', socket => {
    const server = socket.connectToServer();
    server.onMessage(message => {
      if (injectGraphFailure) {
        try { const value = JSON.parse(String(message)); inject(value); message = JSON.stringify(value); } catch {}
      }
      if (delayed && String(message).includes('plugin.rpc.invoke')) {
        report.delayedResponses++;
        setTimeout(() => { try { socket.send(message); } catch {} }, 600);
      } else socket.send(message);
    });
  });
  await page.goto(ui.url);
  await page.getByText('Add project', { exact: true }).first().click();
  await page.getByText('Search for directory', { exact: true }).click();
  await page.getByPlaceholder('Search directories or enter a path...').fill(ui.project);
  await page.getByText('Open this path', { exact: true }).click();
  await page.getByText('Workspace Workbench', { exact: true }).first().click();
  await page.getByText('Main workspace', { exact: true }).first().click();
  await page.getByText('history-continuity', { exact: true }).last().click();
  const rows = page.locator('[data-testid^="workbench-commit-"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="workbench-commit-"]').length === 3, { timeout: 30000 });
  await rows.nth(1).click();
  await page.getByText('Selected commit', { exact: true }).waitFor();
  const selectedId = await rows.nth(1).getAttribute('data-testid');
  const selectedColor = await rows.nth(1).evaluate(node => getComputedStyle(node).backgroundColor);
  assert.notEqual(selectedColor, await rows.nth(0).evaluate(node => getComputedStyle(node).backgroundColor));
  const ids = await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')));
  const startFrames = async () => page.evaluate(() => {
    window.historyFrames = []; window.historySampling = true;
    const sample = () => {
      if (!window.historySampling) return;
      const nodes = [...document.querySelectorAll('[data-testid^="workbench-commit-"]')];
      const ids = nodes.map(node => node.getAttribute('data-testid'));
      let viewport = nodes[0]?.parentElement;
      while (viewport && !['auto', 'scroll'].includes(getComputedStyle(viewport).overflowY)) viewport = viewport.parentElement;
      const top = viewport?.getBoundingClientRect().top || 0;
      const first = nodes.find(node => node.getBoundingClientRect().bottom > top);
      window.historyFrames.push({ count: ids.length, unique: new Set(ids).size, anchor: first?.getAttribute('data-testid'), delta: first ? first.getBoundingClientRect().top - top : 0, at: performance.now() });
      requestAnimationFrame(sample);
    }; sample();
  });
  const stopFrames = async () => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); return page.evaluate(() => { window.historySampling = false; return window.historyFrames; }); };
  delayed = true;
  await startFrames();
  await page.getByText('Full history', { exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="workbench-commit-"]').length === 50, { timeout: 30000 });
  const first = await stopFrames(); report.frames.push({ action: 'full-history', samples: first.length, minRows: Math.min(...first.map(f => f.count)) });
  assert.ok(first.length > 2); assert.ok(first.every(f => f.count >= 3 && f.count === f.unique));
  assert.deepEqual((await rows.evaluateAll(nodes => nodes.slice(0, 3).map(node => node.getAttribute('data-testid')))), ids);
  await page.screenshot({ path: join(output, 'full-history.png') });
  await startFrames();
  const surface = await page.getByTestId('workbench-graph-content').boundingBox();
  assert.ok(surface);
  await page.mouse.move(surface.x + 100, surface.y + 40);
  await page.mouse.wheel(0, 1800);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="workbench-commit-"]').length >= 100, { timeout: 30000 });
  const more = await stopFrames(); report.frames.push({ action: 'load-more', samples: more.length, minRows: Math.min(...more.map(f => f.count)) });
  assert.ok(more.every(f => f.count >= 50 && f.count === f.unique));
  const beforeMore = more.filter(frame => frame.count === 50).at(-1), afterMore = more.find(frame => frame.count >= 100);
  assert.ok(beforeMore && afterMore);
  assert.equal(afterMore.anchor, beforeMore.anchor);
  assert.ok(Math.abs(afterMore.delta - beforeMore.delta) <= 1, 'visible row offset changed after loading more');
  assert.equal(await page.getByTestId(selectedId).evaluate(node => getComputedStyle(node).backgroundColor), selectedColor);
  report.checks.push('history expansion kept the selected commit and the visible scroll anchor within one CSS pixel');
  assert.ok(report.delayedResponses > 0, 'must actually delay responses');
  injectGraphFailure = true;
  await startFrames();
  await page.mouse.wheel(0, 4000);
  await Promise.race([faultSeen, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('fault was not exercised')), 20000); timer.unref(); })]);
  const retry = page.getByRole('button', { name: /100 shown/ });
  await retry.waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('[role="button"]')].find(node => node.textContent.includes('100 shown'));
    return button && button.getAttribute('aria-disabled') !== 'true';
  });
  assert.equal(await rows.count(), 100);
  injectGraphFailure = false;
  await retry.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="workbench-commit-"]').length === 113, { timeout: 30000 });
  const recovered = await stopFrames();
  assert.ok(recovered.every(frame => frame.count >= 100 && frame.count === frame.unique));
  report.frames.push({ action: 'injected-failure-and-retry', samples: recovered.length, minRows: Math.min(...recovered.map(frame => frame.count)) });
  report.checks.push('simulated graph-region failure in actual host transport preserved 100 rows; explicit retry displayed all 113 without blank frames');
  delayed = false;
  report.checks.push('branch to full history and load more retained all previous rows in every animation frame under delayed actual-host responses; SHAs remained unique');
  // Narrow host navigation is covered separately by verify-ui.mjs.
  await page.screenshot({ path: join(output, 'recovered-history.png') });
  await page.getByText('README', { exact: true }).first().click();
  await page.getByText('README sample 0 line 0', { exact: true }).first().waitFor();
  await page.evaluate(() => {
    window.diffScroller = () => {
      const root = document.querySelector('[data-testid="workbench-diff-lines"]');
      return root && [root, ...root.querySelectorAll('*')].find(node => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight);
    };
  });
  const diffBox = await page.getByTestId('workbench-diff-lines').boundingBox();
  assert.ok(diffBox);
  await page.mouse.move(diffBox.x + 100, diffBox.y + 80);
  await page.mouse.wheel(0, 800);
  await page.waitForFunction(() => window.diffScroller()?.scrollTop > 400);
  const savedOffset = await page.evaluate(() => window.diffScroller().scrollTop);
  await page.getByText('Workspace Workbench', { exact: true }).first().click();
  await page.getByText('OTHER', { exact: true }).first().click();
  await page.getByText(/^OTHER sample [01] line 0$/).first().waitFor();
  assert.equal(await page.evaluate(() => window.diffScroller().scrollTop), 0);
  await page.getByRole('tab', { name: /README/ }).click();
  await page.waitForFunction(saved => Math.abs((window.diffScroller()?.scrollTop ?? -10000) - saved) <= 1, savedOffset);
  report.diffScroll = { savedOffset, restoredOffset: await page.evaluate(() => window.diffScroller().scrollTop) };
  report.checks.push('two real Diff tabs kept independent scroll positions; returning to cached README restored its previous offset');
  await page.screenshot({ path: join(output, 'restored-diff.png') });
  assert.equal(report.pageErrors.length, 0);
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack;
  if (page) { report.visible = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); }
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (ui) writeFileSync(ui.continueFile, 'continue\n'); else child.kill('SIGTERM');
  const code = await exit;
  report.hostExitCode = code;
  if (code !== 0) { report.ok = false; process.exitCode = 1; }
  writeFileSync(join(output, 'host.log'), logs);
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
