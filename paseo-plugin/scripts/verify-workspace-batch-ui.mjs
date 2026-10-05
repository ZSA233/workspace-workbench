/** Real isolated Paseo + browser; only temporary fixture workspaces are changed. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { backendRequest } from '../server/backend-supervisor.ts';
const plugin = resolve(import.meta.dirname, '..');
const output = process.env.WORKBENCH_VERIFY_OUTPUT || '/tmp/workbench-batch-ui';
mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, [join(plugin, 'scripts/verify-live.mjs')], { env: { ...process.env, WORKBENCH_LIVE_UI: '1' }, stdio: ['ignore','pipe','pipe'] });
let ui, browser, page, logs = '';
const exit = new Promise(resolve => child.once('exit', resolve));
child.stderr.on('data', value => { logs += value; });
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('isolated host readiness timeout')), 90000);
  createInterface({ input: child.stdout }).on('line', line => { logs += line + '\n'; try { const value = JSON.parse(line); if (value.kind === 'ui-ready') { clearTimeout(timer); resolve(value); } } catch {} });
  void exit.then(code => { clearTimeout(timer); reject(Error(`host exited: ${code}`)); });
});
const report = { checks: [], pageErrors: [] };
try {
  ui = await ready;
  for (const name of ['batch-target-a','batch-target-b', ...Array.from({ length: 12 }, (_, i) => `batch-spare-${String(i).padStart(2,'0')}`)]) {
    const result = await backendRequest(join(ui.project, 's.sock'), 'workspace.create', { name, repositories: ['one'] }, 30000);
    assert.ok(result.ok, JSON.stringify(result));
    if (name === 'batch-target-b') writeFileSync(join(result.result.repositories[0].worktreePath, 'private-fixture.txt'), 'isolated uncommitted content\n');
  }
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(ui.url);
  await page.getByText('Add project', { exact: true }).first().click();
  await page.getByText('Search for directory', { exact: true }).click();
  await page.getByPlaceholder('Search directories or enter a path...').fill(ui.project);
  await page.getByText('Open this path', { exact: true }).click();
  await page.getByText('Workspace Workbench', { exact: true }).first().click();
  await page.getByTestId('workbench-graph-content').waitFor({ timeout: 30000 });
  const button = name => page.getByRole('button', { name, exact: true });
  const search = page.getByPlaceholder('Search workspaces…');
  const selectAll = async () => {
    const all = button('Select matching items'), clear = button('Clear selection');
    await all.or(clear).waitFor();
    if (await all.isVisible()) await all.click();
    await clear.waitFor();
  };
  const run = async (action, count) => {
    await selectAll(); await button(action).click();
    await button('Confirm operation').click(); await page.getByText(new RegExp(`^Succeeded ${count} · Failed 0`)).waitFor({ timeout: 30000 });
    await button('Close').last().click(); assert.ok(await search.isVisible()); assert.equal(await search.inputValue(), 'batch-target');
  };
  await page.getByText('Main workspace', { exact: true }).first().click();
  await search.fill('batch-target'); await button('Manage multiple').click();
  await run('Move to history', 2);
  report.checks.push('Filtered select-all moved exactly two workspaces to history and retained open list/search');
  await page.getByRole('button', { name: /^History \d+$/ }).click();
  await page.getByText('Selected 0', { exact: true }).waitFor();
  await run('Restore', 2);
  await page.getByRole('button', { name: /^All \d+$/ }).click();
  await run('Move to history', 2);
  await page.getByRole('button', { name: /^History \d+$/ }).click();
  await button('Exit selection').click();
  await button('Permanently delete').first().click();
  await button('Cancel').last().click();
  assert.ok(await search.isVisible()); assert.equal(await search.inputValue(), 'batch-target');
  report.checks.push('Single historical permanent-delete confirmation/cancel retains list and filter');
  await button('Manage multiple').click(); await selectAll(); await button('Delete permanently').click();
  await page.getByText('batch-target-b · Content-loss consent required', { exact: true }).waitFor({ timeout: 30000 });
  assert.match(await page.getByText(/^Confirmed targets/).innerText(), /\(1\): batch-target-a/);
  const lossConsent = page.getByRole('checkbox', { name: /Discard all managed/ });
  await lossConsent.waitFor();
  assert.match(await lossConsent.innerText(), /^☐ /);
  assert.ok(await page.getByText(/private-fixture\.txt/).isVisible());
  await page.screenshot({ path: join(output, 'desktop-confirm.png') });
  await button('Confirm operation').click(); await page.getByText(/^Succeeded 1 · Failed 0/).waitFor({ timeout: 30000 });
  await button('Close').last().click();
  await selectAll(); await button('Delete permanently').click();
  await page.getByText('batch-target-b · Content-loss consent required', { exact: true }).waitFor({ timeout: 30000 });
  assert.ok(await button('Confirm operation').isDisabled());
  await lossConsent.waitFor();
  assert.match(await lossConsent.innerText(), /^☐ /);
  await button('Hide impact').click();
  assert.equal(await lossConsent.count(), 0);
  await button('Inspect impact').click();
  await lossConsent.click();
  assert.match(await page.getByText(/^Confirmed targets/).innerText(), /\(1\): batch-target-b/);
  await button('Hide impact').click();
  assert.ok(await button('Confirm operation').isEnabled());
  await button('Inspect impact').click();
  assert.match(await lossConsent.innerText(), /^☑ /);
  await page.screenshot({ path: join(output, 'content-consent.png') });
  await button('Confirm operation').click(); await page.getByText(/^Succeeded 1 · Failed 0/).waitFor({ timeout: 30000 });
  await button('Close').last().click();
  report.checks.push('Content-loss impact and unchecked consent are visible by default; explicit consent adds the target and deletes it, collapsing retains consent, and new previews reset consent');
  await page.getByRole('button', { name: /^All \d+$/ }).click(); await search.fill('batch-spare');
  await button('Exit selection').click();
  const workspaceList = page.getByTestId('workbench-workspace-list');
  await workspaceList.evaluate(element => { element.scrollTop = 100; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  const beforeScroll = await workspaceList.evaluate(element => element.scrollTop);
  assert.ok(beforeScroll > 0);
  const rowId = await workspaceList.evaluate(element => {
    const box = element.getBoundingClientRect();
    return [...element.querySelectorAll('[data-testid^="workspace-option-batch-spare"]')].filter(row => { const rect = row.getBoundingClientRect(); return rect.top > box.top + 42 && rect.bottom < box.bottom; })[0]?.getAttribute('data-testid');
  });
  assert.ok(rowId);
  await page.getByTestId(rowId).getByRole('button', { name: 'Remove Workspace', exact: true }).click();
  await page.getByTestId(rowId).waitFor({ state: 'detached' });
  assert.ok(await search.isVisible());
  assert.ok(Math.abs(await workspaceList.evaluate(element => element.scrollTop) - beforeScroll) < 3);
  report.checks.push('Single removal retains the scrolled list anchor without closing it');
  // The host replaces its global plugin surface with the mobile home at 390px.
  // Constrain the real mounted plugin instead; its onLayout drives compact layout.
  const surface = page.locator('[aria-label="Workspace Workbench"]').filter({ has: workspaceList }).last();
  await surface.evaluate(element => { Object.assign(element.style, { width: '390px', maxWidth: '390px', height: '844px', maxHeight: '844px', alignSelf: 'flex-start' }); });
  await page.addStyleTag({ content: '[role="dialog"] { max-width: 390px !important; max-height: 844px !important; }' });
  assert.ok(Math.abs((await surface.boundingBox()).width - 390) < 2);
  await button('Manage multiple').click();
  await page.getByRole('button', { name: /^All \d+$/ }).click(); await search.fill('batch-spare-0');
  await selectAll(); await button('Move to history').click();
  await button('Confirm operation').click({ trial: true });
  await page.screenshot({ path: join(output, 'mobile-confirm.png'), animations: 'disabled' });
  await button('Close').last().click(); assert.ok(await search.isVisible());
  report.checks.push('390px real-host plugin container supports selection, confirmation and cancel; host mobile navigation and native devices are not covered');
  const listing = await backendRequest(join(ui.project, 's.sock'), 'workspace.list', { includeRemoved: true }, 30000);
  const names = listing.result.workspaces.map(workspace => workspace.id);
  assert.ok(!names.includes('batch-target-a') && !names.includes('batch-target-b')); assert.equal(names.filter(name => name.startsWith('batch-spare')).length, 12);
  assert.equal(report.pageErrors.length, 0); report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack; process.exitCode = 1;
  if (page) { report.visible = await page.locator('body').innerText().catch(() => ''); await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); }
} finally {
  await browser?.close();
  if (ui) writeFileSync(ui.continueFile, 'continue\n'); else child.kill('SIGTERM');
  report.hostExitCode = await exit;
  if (report.hostExitCode !== 0) { report.ok = false; process.exitCode = 1; }
  writeFileSync(join(output, 'host.log'), logs); writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
