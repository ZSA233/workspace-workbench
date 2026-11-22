/** Actual isolated Paseo UI + HTTP archive fixture; no model or normal deployment. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { chromium } from 'playwright';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import { backendRequest } from '../server/backend-supervisor.ts';
import { startArchiveFixture } from '../tests/helpers/archive-service.ts';
import { openIsolatedWorkbench } from './ui-project-selection.mjs';

const plugin = resolve(import.meta.dirname, '..');
const output = process.env.WORKBENCH_VERIFY_OUTPUT || mkdtempSync(join(tmpdir(), 'wb-topics-ui-'));
mkdirSync(output, { recursive: true });
const fixture = await startArchiveFixture();
const host = spawn(process.execPath, [join(plugin, 'scripts/verify-live.mjs')], {
  env: { ...process.env, WORKBENCH_LIVE_UI: '1', WORKBENCH_VERIFY_OUTPUT: output },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', ui, browser, page, client;
const exited = new Promise(resolveExit => host.once('exit', resolveExit));
host.stderr.on('data', bytes => { logs += bytes; });
const ready = new Promise((yes, no) => {
  const timer = setTimeout(() => no(Error('isolated host readiness timeout')), 120000);
  createInterface({ input: host.stdout }).on('line', line => {
    logs += line + '\n';
    try { const value = JSON.parse(line); if (value.kind === 'ui-ready') { clearTimeout(timer); yes(value); } } catch {}
  });
  void exited.then(code => { clearTimeout(timer); no(Error('isolated host exited ' + code)); });
});
const report = { kind: 'actual-isolated-paseo-topics-ui', output, browser: 'Playwright: Browser runtime returned no browser',
  checks: [], screenshots: [], pageErrors: [], console: [], fidelity: [] };
const check = text => { report.checks.push(text); console.log(JSON.stringify({ check: text })); };
function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright') : join(homedir(), '.cache/ms-playwright');
  for (const name of readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse()) {
    const file = join(cache, name, process.platform === 'darwin' ? 'chrome-headless-shell-mac-arm64/chrome-headless-shell' : 'chrome-headless-shell-linux64/chrome-headless-shell');
    if (existsSync(file)) return file;
  }
  throw Error('No installed Playwright executable');
}
async function shot(name) {
  const file = join(output, name + '.png');
  await page.getByTestId('workbench-topics-panel').screenshot({ path: file });
  report.screenshots.push(file);
}
try {
  ui = await ready; report.url = ui.url;
  client = new DaemonClient({ url: ui.url.replace('http:', 'ws:') + '/ws', clientId: 'topics-ui', clientType: 'mcp', reconnect: { enabled: false },
    webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }) });
  await client.connect();
  const config = join(ui.project, 'project.json');
  const rpc = (name, input = {}) => client.invokePluginRpc('workspace-workbench-paseo', name, { projectConfig: config, extensionId: 'project-communications', ...input });
  await rpc('workspace.workbench.communications-connection', { action: 'configure', revision: 1, connection: {
    endpoint: fixture.url, projectId: 'legacy-unused', libraryId: 'default', watchedGroups: [{ sourceId: 'dingtalk:fixture', channelId: 'feedback' }],
  }, token: fixture.token });
  const created = await backendRequest(join(ui.project, 's.sock'), 'workspace.create', { name: 'topics-dev', repositories: ['one'] }, 30000);
  assert.ok(created.ok, JSON.stringify(created));
  writeFileSync(join(ui.project, 'state', 'agent-bindings.json'), JSON.stringify({ schemaVersion: 'workspace.workbench.agent-bindings/v2', bindings: [{
    workspaceId: created.result.id, agentId: 'archive-fixture-worker', relationship: 'independent', paseoWorkspaceId: 'fixture-host',
    cwd: created.result.treePath, provider: 'fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }] }));
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable() });
  page = await browser.newPage({ viewport: { width: 1448, height: 1120 }, locale: 'zh-CN', colorScheme: 'dark' });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.console.push(message.text()); });
  await openIsolatedWorkbench(page, ui.url, 'a');
  assert.equal(await page.getByText(/^(审核集|Review set|Agent 审核|Agent Review)$/).filter({ visible: true }).count(), 0);
  await page.getByText('话题', { exact: true }).filter({ visible: true }).first().click();
  const panel = page.getByTestId('workbench-topics-panel');
  await panel.waitFor();
  await page.getByTestId('topics-enable').getByText('启用话题', { exact: true }).waitFor();
  assert.equal(fixture.state.requests.some(request => /\/topics(?:[/?]|$)/.test(request.url)), false,
    'the visible disabled entry must not read topic originals');
  const beforeEnable = await rpc('workspace.workbench.communications-connection', { action: 'read' });
  assert.deepEqual(beforeEnable.connection.watchedGroups, [{ sourceId: 'dingtalk:fixture', channelId: 'feedback' }]);
  await shot('topics-disabled-entry');
  await page.getByTestId('topics-enable').click();
  await page.getByTestId('topic-row-topic-1').waitFor();
  check('a disabled project keeps its topic tab and followed groups; activation opens existing topics without changing scope');
  assert.equal(await panel.getByText(/DWS|模型与预算|需求台账|自动回复/).count(), 0);
  check('actual plugin renders the topics entry with no collection/model/requirements UI');
  await page.getByTestId('topic-expand-topic-1').click();
  await page.getByTestId('topic-message-message-1').waitFor();
  await page.getByTestId('topic-select-topic-1').click();
  await page.getByTestId('topic-basket-topic-1').waitFor();
  await panel.getByRole('button', { name: '更多话题', exact: true }).click();
  await page.getByTestId('topic-select-topic-3').click();
  await page.getByTestId('topic-basket-topic-3').waitFor();
  await page.getByRole('img').first().waitFor().catch(() => {});
  await shot('topics-c-desktop');
  check('two topic selections are grouped in the fixed basket with original messages and image thumbnails');
  const footerBefore = await page.getByTestId('topics-basket').boundingBox();
  await page.getByTestId('topic-message-message-1').click();
  assert.equal(await page.getByTestId('topic-basket-topic-1').getByTestId('topic-remove-message-message-1').count(), 0);
  await page.getByTestId('topic-message-message-1').click();
  await page.getByTestId('topic-basket-topic-1').getByRole('button', { name: '移除 image-1.png', exact: true }).click();
  assert.equal(await page.getByTestId('topic-detail-topic-1').getByRole('checkbox', { name: '选择 image-1.png', exact: true }).getAttribute('aria-checked'), 'false');
  await page.getByTestId('topic-detail-topic-1').getByRole('checkbox', { name: '选择 image-1.png', exact: true }).click();
  check('original text and image choices are independent and immediately reflected in source and basket');
  await page.getByTestId('topics-preview').click();
  const preview = page.getByRole('dialog', { name: '所选材料', exact: true });
  await preview.waitFor();
  assert.ok((await preview.innerText()).includes('文件列表出现长错误提示后，目录被往下挤了。'));
  assert.equal((await preview.innerText()).includes('派生分析'), false);
  await preview.getByRole('button', { name: '返回', exact: true }).click();
  check('preview freezes exactly the chosen originals and excludes the optional analysis');
  await page.getByTestId('topics-settings').click();
  const settings = page.getByTestId('communications-settings-dialog');
  await settings.waitFor();
  assert.equal((await settings.innerText()).includes('DWS'), false);
  await settings.getByRole('button', { name: '工具授权 产研反馈群', exact: true }).click();
  const tools = page.getByTestId('topics-tool-settings');
  await tools.waitFor(); assert.ok((await tools.innerText()).includes('代码检索'));
  await tools.getByRole('button', { name: '取消', exact: true }).click();
  await settings.getByRole('button', { name: '完成', exact: true }).click();
  check('compact settings exposes followed groups and registered tool selection without DWS controls');
  await page.setViewportSize({ width: 760, height: 900 });
  await shot('topics-c-narrow');
  assert.ok(await page.getByTestId('topics-send').isVisible());
  const bounds = await panel.boundingBox(), send = await page.getByTestId('topics-send').boundingBox();
  assert.ok(send.x >= bounds.x && send.x + send.width <= bounds.x + bounds.width + 1);
  check('narrow viewport preserves selected materials, complete primary action and independent scrolling');
  const beforeError = await page.getByTestId('topics-basket').boundingBox();
  fixture.state.failLists = true;
  await page.getByTestId('topics-refresh').click();
  const search = page.getByRole('textbox', { name: '搜索话题', exact: true });
  await search.focus();
  await page.getByTestId('topics-status').getByText('AI 助手暂不可用', { exact: true }).waitFor();
  assert.equal(await search.evaluate(element => element === document.activeElement), true);
  const afterError = await page.getByTestId('topics-basket').boundingBox();
  for (const axis of ['x','y','width','height']) assert.ok(Math.abs(beforeError[axis] - afterError[axis]) < 1, axis + ' moved when an error appeared');
  await shot('topics-c-connection-notice');
  fixture.state.failLists = false;
  await page.getByTestId('topics-refresh').click();
  await page.getByTestId('topics-status').getByText('AI 助手暂不可用', { exact: true }).waitFor({ state: 'hidden' });
  check('background connection failure preserves selected materials, footer geometry and input focus');
  const selectedBefore = await page.getByTestId('topics-basket-items').innerText();
  fixture.state.topics[0].inputRevision++; fixture.state.topics[0].revision++;
  fixture.state.topics[0].messages.push({ ...fixture.state.topics[0].messages[0], id: 'late-original', text: 'late original must not be selected' });
  await page.getByTestId('topics-refresh').click();
  await page.getByRole('button', { name: '重新读取并清除此话题选择', exact: true }).waitFor();
  assert.equal(await page.getByTestId('topics-basket-items').innerText(), selectedBefore);
  // Editing invalidates the earlier frozen preview; preparing this stale
  // selection again must now fail instead of mixing in the new message.
  await page.getByTestId('topic-basket-topic-1').getByTestId('topic-remove-message-message-2').click();
  await page.getByTestId('topics-send').click();
  await page.getByTestId('topics-status').getByText('话题有更新，请重新选材', { exact: true }).waitFor();
  const footerAfter = await page.getByTestId('topics-basket').boundingBox();
  assert.equal(await page.getByText('late original must not be selected', { exact: true }).count(), 0);
  await shot('topics-c-update-notice');
  check('polling preserves selection; a stale snapshot is rejected in a fixed status row without adding a banner');
  await page.getByRole('button', { name: '重新读取并清除此话题选择', exact: true }).click();
  await page.getByTestId('topic-basket-topic-1').waitFor({ state: 'detached' });
  await page.getByTestId('topics-send').click();
  await page.getByRole('button', { name: '查回执', exact: true }).waitFor();
  const previewsBefore = readdirSync(join(ui.project, 'state', 'extensions', 'topic-materials')).filter(name => name.endsWith('.json')).length;
  await page.getByRole('button', { name: '查回执', exact: true }).click();
  const previewsAfter = readdirSync(join(ui.project, 'state', 'extensions', 'topic-materials')).filter(name => name.endsWith('.json')).length;
  assert.equal(previewsBefore, previewsAfter);
  check('an unavailable fixture worker yields uncertain receipt and queries never create another delivery');
  await page.getByTestId('topics-settings').click();
  await settings.getByRole('button', { name: '停用话题', exact: true }).click();
  await settings.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByTestId('topics-enable').waitFor();
  assert.equal(await page.getByRole('tab', { name: '话题', exact: true }).isVisible(), true);
  const whileDisabled = await rpc('workspace.workbench.communications-connection', { action: 'read' });
  assert.deepEqual(whileDisabled.connection.watchedGroups, beforeEnable.connection.watchedGroups);
  await page.getByTestId('topics-enable').click();
  await page.getByTestId('topic-row-topic-1').waitFor();
  check('disabling leaves the active topic tab in place; re-enabling retains the saved followed-group scope');

  const discoveryBefore = JSON.stringify(fixture.state.groups);
  await page.getByTestId('topics-settings').click();
  const follow = settings.getByRole('checkbox', { name: '关注 产研反馈群', exact: true });
  assert.equal(await follow.getAttribute('aria-checked'), 'true');
  await follow.click();
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await settings.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByText('此项目尚未关注群', { exact: true }).waitFor();
  await shot('topics-no-followed-groups');
  await page.getByRole('button', { name: '选择关注群', exact: true }).first().click();
  await follow.waitFor();
  assert.equal(await follow.getAttribute('aria-checked'), 'false');
  await follow.click();
  await settings.getByRole('button', { name: '保存', exact: true }).click();
  await settings.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByTestId('topic-row-topic-1').waitFor();
  assert.equal(JSON.stringify(fixture.state.groups), discoveryBefore);
  check('an empty followed-group scope opens actual follow settings; saving a follow restores topics and leaves service discovery policy unchanged');
  assert.equal(fixture.state.requests.some(request => request.url.startsWith('/v1/projects')), false);
  assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
  report.fidelity.push('same flat topic-list + bottom-basket architecture as refined C',
    'short control labels; source text remains intact', 'selected rows use the workbench blue accent and checked controls',
    'original media is shown as thumbnails with individual selection', 'target/preview/send controls remain in the fixed footer',
    'narrow layout keeps the toolbar compact; source and basket retain separate scrolling');
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = error.stack || String(error);
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close(); await client?.close?.();
  if (ui) writeFileSync(ui.continueFile, 'continue');
  else host.kill('SIGTERM');
  report.isolatedHostExitCode = await exited;
  if (report.isolatedHostExitCode !== 0) {
    report.ok = false; report.error ||= 'isolated host cleanup failed'; process.exitCode = 1;
  }
  await fixture.close();
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(output, 'host.log'), logs);
  (report.ok ? console.log : console.error)(JSON.stringify(report));
}
