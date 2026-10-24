#!/usr/bin/env node
// Original Paseo 0.13 UI, real installed plugins and an owned isolated host. No UI injection.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
const require = createRequire(new URL('../../paseo-plugin/package.json', import.meta.url));
const { chromium } = require('playwright');
const { values } = parseArgs({ options: { fixture: { type: 'string' }, output: { type: 'string' } } });
assert(values.fixture, 'Pass --fixture LOG from the isolated Paseo host');
const output = resolve(values.output || '/tmp/pocket-browser-sidebar'); await mkdir(output, { recursive: true });
const fixture = (await readFile(values.fixture, 'utf8')).split('\n').flatMap(row => {
  try { const value = JSON.parse(row); return value.kind === 'actual-isolated-paseo-with-protocol-fixture' ? [value] : []; } catch { return []; }
}).at(-1);
assert(fixture?.project && new URL(fixture.url).hostname === '127.0.0.1' && /\/paseo-pocket-host-[^/]+$/.test(fixture.home), 'Only an owned isolated fixture may be tested');
assert.equal(JSON.parse(await readFile(fixture.projectConfig, 'utf8')).sourceRoot, fixture.project);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
page.setDefaultTimeout(30000);
const report = { kind: 'actual-Paseo-013-official-sidebar', checks: [], errors: [], screenshots: [], ok: false };
page.on('pageerror', error => report.errors.push(error.message));
const visible = locator => locator.filter({ visible: true });
const sidebar = () => visible(page.getByTestId('workspace-explorer-sidebar'));
const shot = async name => { await page.screenshot({ path: join(output, name + '.png') }); report.screenshots.push(name + '.png'); };
async function openMenu() {
  await sidebar().getByRole('button', { name: 'New tab', exact: true }).click();
  return visible(page.getByTestId('workspace-new-tab-menu'));
}
try {
  await page.goto(fixture.url);
  await page.waitForFunction(() => window.__paseoHostRuntimeStore?.getHosts().length);
  const hostId = await page.evaluate(() => window.__paseoHostRuntimeStore.getHosts()[0].serverId);
  await page.goto(`${fixture.url}/h/${hostId}/agent/${fixture.agents[0]}`);
  await page.getByTestId('workspace-explorer-toggle').first().click();
  await sidebar().waitFor();
  assert.equal(await page.evaluate(() => !!window.Pocket || !!window.__pocketExtensions), false);
  assert.equal(await visible(page.getByTestId('workbench-graph-content')).count(), 0);
  let menu = await openMenu();
  await menu.getByRole('menuitem', { name: 'Workspace Workbench', exact: true }).click();
  await visible(page.getByTestId('workbench-graph-content')).waitFor();
  const route = page.url(); await shot('01-official-workbench');
  report.checks.push('Official + menu lazily opens the real Workbench panel, without Pocket API, module hooks or extra rendering containers.');
  await sidebar().getByRole('button', { name: 'Browse workspace files', exact: true }).click();
  await visible(page.getByTestId('file-explorer-tree-scroll')).waitFor();
  await sidebar().getByRole('button', { name: 'Workspace Workbench', exact: true }).click();
  await visible(page.getByTestId('workbench-graph-content')).waitFor();
  assert.equal(page.url(), route);
  report.checks.push('Built-in Files and Workbench use the same official tab rail and preserve the workspace route.');
  await visible(page.getByRole('tab', { name: 'Files', exact: true })).click();
  const folder = visible(page.locator('[data-file-path="one"]')); await folder.waitFor();
  if (await folder.getByTestId('geometric-icon-ChevronRight').count()) await folder.click();
  const entry = visible(page.locator('[data-file-path="one/README.md"]')); await entry.waitFor(); await entry.dblclick();
  await visible(page.getByTestId('workbench-document-panel')).getByText('Pocket extension fixture', { exact: true }).waitFor();
  await visible(page.getByRole('button', { name: /Back to files|返回文件/, exact: true })).click();
  await visible(page.locator('[data-file-path="one/README.md"]')).waitFor();
  report.checks.push('Opening the actual Markdown file uses the existing File Viewer; Back to files restores the Workbench directory.');
  const repository = join(fixture.project, 'one');
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(repository, 'README.md'), '# Pocket extension fixture\n\nOfficial sidebar comparison proof.\n');
  git('add', 'README.md'); git('commit', '-qm', 'Official sidebar comparison fixture'); const head = git('rev-parse', 'HEAD');
  await visible(page.getByRole('tab', { name: 'Git', exact: true })).click();
  await visible(page.getByRole('button', { name: /Compare repository|比较仓库/, exact: true })).first().click();
  await page.getByLabel('搜索引用或输入提交 SHA', { exact: true }).fill(base);
  await page.getByRole('button', { name: '使用此引用', exact: true }).click();
  await page.getByTestId('comparison-to').click();
  await page.getByLabel('搜索引用或输入提交 SHA', { exact: true }).fill(head);
  await page.getByRole('button', { name: '使用此引用', exact: true }).click();
  await page.getByTestId('comparison-sidebar').getByText('README.md', { exact: true }).click();
  await page.getByTestId('comparison-file-README.md').getByRole('button', { name: '单独打开 README.md', exact: true }).press('Enter');
  await visible(page.getByTestId('workbench-diff-panel')).getByTestId('diff-code-unified').first().waitFor();
  const explorerToggle = page.getByTestId('workspace-explorer-toggle').first();
  if (await explorerToggle.getAttribute('aria-expanded') !== 'true') await explorerToggle.click();
  await sidebar().waitFor();
  const closeComparison = visible(page.getByRole('button', { name: '关闭比较设置', exact: true }));
  if (await closeComparison.count()) await closeComparison.last().click();
  report.checks.push('A real committed comparison opens the existing Diff viewer and returns to the official Workbench tab.');
  menu = await openMenu();
  await menu.getByRole('menuitem', { name: 'Inspector 1', exact: true }).click();
  await visible(page.getByTestId('example-rpc-1')).getByText(/pocket-example RPC/).waitFor();
  assert((await visible(page.getByTestId('example-context-1')).innerText()).endsWith('/ workspace'));
  assert.equal(await page.evaluate(() => window.__pocketExampleProof.cacheShared), true);
  report.checks.push('A second actual plugin opens through the same official API with its own RPC and workspace context.');
  await page.reload();
  const toggle = page.getByTestId('workspace-explorer-toggle').first(); await toggle.waitFor();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await visible(page.getByTestId('example-rpc-1')).getByText(/pocket-example RPC/).waitFor();
  report.checks.push('Paseo restores the selected official plugin tab after a full document reload.');
  await page.emulateMedia({ colorScheme: 'dark' }); await shot('02-dark-sidebar');
  await page.setViewportSize({ width: 1100, height: 800 });
  await visible(page.getByTestId('example-rpc-1')).waitFor();
  await shot('03-wide-sidebar');
  report.checks.push('The same official panel survives appearance and compact-to-wide layout changes.');
  assert.deepEqual(report.errors, []); report.ok = true;
} catch (error) {
  report.failure = error.stack; report.body = (await page.locator('body').innerText()).slice(-5000);
  await shot('failure'); process.exitCode = 1;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close();
}
console.log(JSON.stringify(report, null, 2));
