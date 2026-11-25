/** Actual isolated Paseo UI + HTTP archive fixture; no model or normal deployment. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { chromium } from 'playwright';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { backendRequest } from '../server/backend-supervisor.ts';
import { startArchiveFixture } from '../tests/helpers/archive-service.ts';
import { openIsolatedWorkbench, selectGlobalWorkbenchProject } from './ui-project-selection.mjs';

const plugin = resolve(import.meta.dirname, '..');
const output = process.env.WORKBENCH_VERIFY_OUTPUT || mkdtempSync(join(tmpdir(), 'wb-topics-ui-'));
mkdirSync(output, { recursive: true });
const fixture = await startArchiveFixture();
fixture.state.topics[0].question = fixture.state.topics[0].title;
fixture.state.topics[0].title = '[图片消息](mediaId=$truncated';
fixture.state.topics[0].updatedAt = new Date(2026, 10, 19, 16, 20).getTime();
fixture.state.topics[0].messages[0].displayText = fixture.state.topics[0].messages[0].text;
fixture.state.topics[0].messages[0].text = '[图片消息](mediaId=$image-1)' + fixture.state.topics[0].messages[0].text;
fixture.state.topics[0].messages[0].createdAt = fixture.state.topics[0].updatedAt;
fixture.state.context.displayText = fixture.state.context.text;
fixture.state.context.text = '[图片消息](mediaId=$context-image)' + fixture.state.context.text;
fixture.state.context.assets = [{ id: 'context-image', kind: 'image', mimeType: 'image/png', state: 'ready', name: 'context.png' }];
fixture.state.issues[0].title = '【后台-附件管理】下载报告后，保存弹窗的文件名显示为空，无法区分不同版本';
fixture.state.issues[1].status = '已解决';
fixture.state.topics[1].status = 'closed';
const videoTopic=fixture.state.topics[3],videoMessage=videoTopic.messages[0];
videoTopic.title='视频播放与镜像反馈';
videoMessage.text='fileName=mmexport123.mp4\nurl: @opaque-native-video';
videoMessage.assets=[{id:'video-original',name:'attachment',mimeType:'video',state:'pending'}];
for(let index=1;index<=8;index++)videoTopic.messages.push({...videoMessage,id:'video-followup-'+index,version:'video-followup-version-'+index,createdAt:videoMessage.createdAt+index*60000,text:'后续讨论 '+index,assets:[]});
videoTopic.messageCount=videoTopic.messages.length;
const host = spawn(process.execPath, [join(plugin, 'scripts/verify-live.mjs')], {
  env: { ...process.env, WORKBENCH_LIVE_UI: '1', WORKBENCH_LIVE_TOPICS: '1', WORKBENCH_VERIFY_OUTPUT: output },
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
const report = { kind: 'actual-isolated-paseo-topics-ui', output, browser: 'Playwright: Browser plugin not available',
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
const renderedText = locator => locator.evaluate(element => {
  const style = getComputedStyle(element);
  return { size: parseFloat(style.fontSize), weight: Number(style.fontWeight), color: style.color, x: element.getBoundingClientRect().left };
});
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
  const fixtureBindings = { schemaVersion: 'workspace.workbench.agent-bindings/v2', bindings: [{
    workspaceId: created.result.id, agentId: 'archive-fixture-worker', relationship: 'independent', paseoWorkspaceId: 'fixture-host',
    cwd: created.result.treePath, provider: 'fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }] };
  browser = await chromium.launch({ headless: true, executablePath: browserExecutable() });
  page = await browser.newPage({ viewport: { width: 1448, height: 1120 }, locale: 'zh-CN', colorScheme: 'dark' });
  let loseNextTopicSend = false, lostTopicResponses = 0;
  await page.routeWebSocket(/\/ws(?:\?|$)/, socket => {
    const server = socket.connectToServer(), pending = new Set();
    socket.onMessage(message => {
      try {
        const envelope = JSON.parse(String(message)), value = envelope.type === 'session' ? envelope.message : envelope;
        if (loseNextTopicSend && value.type === 'plugin.rpc.invoke.request' && value.method === 'workspace.workbench.archive-topics-delivery' && value.input?.request?.action === 'send') {
          pending.add(value.requestId); loseNextTopicSend = false;
        }
      } catch {}
      server.send(message);
    });
    server.onMessage(message => {
      try {
        const envelope = JSON.parse(String(message)), value = envelope.type === 'session' ? envelope.message : envelope;
        if (value.type === 'plugin.rpc.invoke.response' && pending.delete(value.payload.requestId)) {
          lostTopicResponses++;
          const response = {type:'rpc_error',payload:{requestId:value.payload.requestId,requestType:'plugin.rpc.invoke.request',code:'handler_error',error:'fixture_acknowledgement_lost_after_dispatch'}};
          socket.send(JSON.stringify(envelope.type === 'session' ? {...envelope,message:response} : response));
          return;
        }
      } catch {}
      socket.send(message);
    });
  });
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
  const chatTab = panel.getByRole('tab', { name: '钉钉话题', exact: true });
  const tapdTab = panel.getByRole('tab', { name: 'TAPD 缺陷', exact: true });
  assert.equal(await chatTab.getAttribute('aria-selected'), 'true');
  assert.equal(fixture.state.requests.some(request => request.url.includes('/sources/tapd')), false);
  fixture.state.issueMachineRead = false;
  await tapdTab.click();
  await panel.getByText('档案服务尚未开放 TAPD 读取', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '配置档案服务公网地址', exact: true }).click();
  const archiveSettings = page.getByTestId('communications-settings-dialog');
  const publicUrl = 'https://access.example.test/communications/';
  await archiveSettings.getByTestId('communications-public-url').fill(publicUrl);
  await archiveSettings.getByRole('button', { name: '保存', exact: true }).click();
  await archiveSettings.getByRole('button', { name: '完成', exact: true }).click();
  const connection = await rpc('workspace.workbench.communications-connection', { action: 'read' });
  assert.equal(connection.connection.publicUrl, publicUrl);
  assert.equal(connection.connection.endpoint, fixture.url);
  await tapdTab.click();
  const target = publicUrl + '?view=plugin&provider=tapd&page=issues&library=default';
  await page.context().route('https://access.example.test/**', route => route.fulfill({ body: 'Archive browser fixture' }));
  const browserPage = page.context().waitForEvent('page');
  await panel.getByRole('button', { name: '打开档案服务', exact: true }).click();
  const opened = await browserPage;
  await opened.waitForURL(target);
  await opened.close();
  check('TAPD opens the HTTPS archive gateway with its path prefix from the actual plugin');
  await chatTab.click();
  await page.getByTestId('topic-select-topic-2').click();
  await page.getByTestId('topic-basket-topic-2').waitFor();
  fixture.state.issueMachineRead = true;
  await tapdTab.click();
  await page.getByTestId('tapd-refresh').click();
  const [issue, secondIssue] = fixture.state.issues;
  const issueRow = page.getByTestId('tapd-issue-' + issue.id);
  const secondRow = page.getByTestId('tapd-issue-' + secondIssue.id);
  await issueRow.getByText('处理中', { exact: true }).waitFor();
  await issueRow.getByText(/^更新于 /).waitFor();
  assert.equal(await tapdTab.getAttribute('aria-selected'), 'true');
  await panel.getByRole('button', { name: '更多缺陷', exact: true }).click();
  await secondRow.getByText('已解决', { exact: true }).waitFor();
  const tapdTitle = await renderedText(issueRow.getByText(issue.title, { exact: true }));
  const secondTitle = secondRow.getByText(secondIssue.title, { exact: true });
  const settledTitle = await renderedText(secondTitle);
  const activeStatus = await renderedText(issueRow.getByText('处理中', { exact: true }));
  assert.notEqual(settledTitle.color, tapdTitle.color);
  assert.ok(settledTitle.weight < tapdTitle.weight);
  assert.equal((await renderedText(secondRow.getByText('已解决', { exact: true }))).color, settledTitle.color);
  for (const label of ['已关闭', '已完成']) {
    secondIssue.status = label;
    await page.getByTestId('tapd-refresh').click();
    await secondRow.getByText(label, { exact: true }).waitFor();
    assert.equal((await renderedText(secondTitle)).color, settledTitle.color);
    assert.equal((await renderedText(secondTitle)).weight, settledTitle.weight);
    assert.equal((await renderedText(secondRow.getByText(label, { exact: true }))).color, settledTitle.color);
  }
  for (const label of ['新建', '重新打开']) {
    secondIssue.status = label;
    await page.getByTestId('tapd-refresh').click();
    await secondRow.getByText(label, { exact: true }).waitFor();
    assert.equal((await renderedText(secondTitle)).color, tapdTitle.color);
    assert.equal((await renderedText(secondTitle)).weight, tapdTitle.weight);
    assert.equal((await renderedText(secondRow.getByText(label, { exact: true }))).color, activeStatus.color);
  }
  secondIssue.status = '已关闭';
  await page.getByTestId('tapd-refresh').click();
  await secondRow.getByText('已关闭', { exact: true }).waitFor();
  assert.notEqual((await renderedText(secondTitle)).color, tapdTitle.color);
  await page.getByTestId('tapd-expand-' + issue.id).click();
  const issueDetail = page.getByTestId('tapd-detail-' + issue.id);
  const description = issueDetail.getByText(issue.body, { exact: true });
  await description.waitFor();
  const descriptionStyle = await renderedText(description);
  const detailLabel = await renderedText(issueDetail.getByText('缺陷描述', { exact: true }));
  const detailFrame = await issueDetail.getByTestId('topic-detail-content').evaluate(element => {
    const css = getComputedStyle(element); return { border: css.borderLeftWidth, padding: css.paddingLeft };
  });
  assert.ok(tapdTitle.size > descriptionStyle.size && descriptionStyle.size > detailLabel.size);
  assert.ok(detailLabel.x > tapdTitle.x && detailLabel.color !== tapdTitle.color);
  await shot('tapd-issue-hierarchy-desktop');
  const issueSearch = panel.getByRole('textbox', { name: '搜索缺陷标题或编号', exact: true });
  await issueSearch.fill(secondIssue.number);
  await issueRow.waitFor({ state: 'hidden' });
  await secondRow.waitFor();
  await issueSearch.fill(issue.number);
  await secondRow.waitFor({ state: 'hidden' });
  await page.getByTestId('tapd-select-' + issue.id).click();
  await issueRow.getByText(issue.body, { exact: true }).waitFor();
  await issueRow.getByRole('checkbox', { name: '选择缺陷描述', exact: true, checked: true }).waitFor();
  assert.equal(await issueRow.getByRole('checkbox', { name: /选择评论/ }).getAttribute('aria-checked'), 'false');
  await issueRow.getByRole('checkbox', { name: '选择 复现报告.pdf', exact: true }).click();
  await issueRow.getByRole('button', { name: '查看 复现截图.png', exact: true }).click();
  const issueImage = page.getByRole('dialog', { name: '复现截图.png', exact: true });
  await issueImage.getByRole('img', { name: '复现截图.png', exact: true }).waitFor();
  await issueImage.getByRole('button', { name: '关闭', exact: true }).click();
  await shot('tapd-topics-desktop');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForFunction(() => {
    const bounds = id => document.querySelector('[data-testid="' + id + '"]')?.getBoundingClientRect();
    const panel = bounds('workbench-topics-panel'), tab = bounds('topics-source-tapd'), send = bounds('topics-send');
    return panel && tab && send && panel.left >= -1 && panel.right <= innerWidth + 1 &&
      tab.right <= panel.right + 1 && send.right <= panel.right + 1;
  });
  await shot('tapd-topics-phone');
  await page.getByTestId('topics-send').click();
  const mixed = page.getByTestId('topics-send-dialog');
  await mixed.getByTestId('tapd-material-' + issue.id).waitFor();
  const mixedText = await mixed.innerText();
  assert.ok(mixedText.includes(issue.body) && mixedText.includes(fixture.state.topics[1].messages[0].text));
  assert.equal(mixedText.includes(issue.comments[0].text) || mixedText.includes(issue.attachments[1].name), false);
  const mixedScreenshot = join(output, 'tapd-topics-mixed-confirmation.png');
  await mixed.screenshot({ path: mixedScreenshot });
  report.screenshots.push(mixedScreenshot);
  await mixed.getByRole('button', { name: '返回', exact: true }).click();
  await page.setViewportSize({ width: 1448, height: 1120 });
  issue.version = 'revision-2';
  await page.getByTestId('tapd-refresh').click();
  await issueRow.getByText('缺陷有更新，请重新选材', { exact: true }).waitFor();
  await chatTab.click();
  await page.getByTestId('tapd-basket-' + issue.id).waitFor();
  await panel.getByRole('button', { name: '清空材料', exact: true }).click();
  check('underlined source tabs support TAPD authorization status, versioned originals and mixed materials on desktop and phone');
  await page.getByTestId('topic-expand-topic-1').click();
  await page.getByTestId('topic-message-message-1').waitFor();
  await page.getByTestId('topic-original-message-message-1').getByRole('img',{name:'image-1.png',exact:true}).waitFor();
  await page.getByTestId('topic-original-message-message-2').getByRole('img',{name:'image-2.png',exact:true}).waitFor();
  check('each original message renders its own media below the text, before the next speaker');
  const chatRow = page.getByTestId('topic-row-topic-1');
  const chatTitle = chatRow.getByText('文件列表错误提示挤压布局', { exact: true });
  const chatBody = chatRow.getByText(fixture.state.topics[0].messages[0].displayText, { exact: true });
  assert.equal((await renderedText(chatTitle)).size, tapdTitle.size);
  assert.equal((await renderedText(chatBody)).size, descriptionStyle.size);
  assert.deepEqual(await chatRow.getByTestId('topic-detail-content').evaluate(element => {
    const css = getComputedStyle(element); return { border: css.borderLeftWidth, padding: css.paddingLeft };
  }), detailFrame);
  await chatRow.getByText('跟进中', { exact: true }).waitFor();
  const finishedTopic = fixture.state.topics[1], finishedRow = page.getByTestId('topic-row-topic-2');
  const finishedTitle = finishedRow.getByText(finishedTopic.title, { exact: true });
  for (const [status, label] of [['closed', '已关闭'], ['resolved', '已解决'], ['completed', '已完成']]) {
    finishedTopic.status = status;
    await page.getByTestId('topics-refresh').click();
    await finishedRow.getByText(label, { exact: true }).waitFor();
    assert.equal((await renderedText(finishedTitle)).color, settledTitle.color);
    assert.equal((await renderedText(finishedTitle)).weight, settledTitle.weight);
    assert.equal((await renderedText(finishedRow.getByText(label, { exact: true }))).color, settledTitle.color);
  }
  finishedTopic.status = 'open';
  await page.getByTestId('topics-refresh').click();
  await finishedRow.getByText('跟进中', { exact: true }).waitFor();
  assert.equal((await renderedText(finishedTitle)).color, tapdTitle.color);
  assert.equal((await renderedText(finishedTitle)).weight, tapdTitle.weight);
  finishedTopic.status = 'closed';
  await page.getByTestId('topics-refresh').click();
  await finishedRow.getByText('已关闭', { exact: true }).waitFor();
  await shot('dingtalk-topic-hierarchy-desktop');
  check('DingTalk and TAPD share hierarchy and attention: resolved, closed and completed work is muted and lighter; new and reopened work regains attention without changing original status labels');
  assert.equal((await panel.innerText()).includes('mediaId='), false);
  assert.ok((await page.getByTestId('topic-row-topic-1').innerText()).includes('11-19 16:20'));
  await page.getByTestId('topic-message-message-1').click();
  await page.getByTestId('topic-basket-topic-1').getByRole('img', { name: 'image-1.png', exact: true }).waitFor();
  assert.equal(await page.getByTestId('topics-preview').count(), 0, 'the redundant eye action is removed');
  await page.getByTestId('topics-send').click();
  const initialPreview = page.getByTestId('topics-send-dialog');
  await initialPreview.getByRole('img', { name: 'image-1.png', exact: true }).waitFor();
  assert.equal((await initialPreview.innerText()).includes('mediaId='), false);
  await page.getByTestId('topics-edit-message-1').click();
  const firstSource=fixture.state.topics[0].messages[0].text;
  await page.getByTestId('topics-edit-text-message-1').fill('我补充了一段说明，原始归档不应变化。');
  assert.equal(fixture.state.topics[0].messages[0].text,firstSource);
  await initialPreview.getByRole('button',{name:'返回',exact:true}).click();
  await page.getByTestId('topics-send').click();
  assert.ok((await initialPreview.innerText()).includes('我补充了一段说明'));
  await page.getByTestId('topics-reset-message-1').click();
  assert.ok((await initialPreview.innerText()).includes('文件列表出现长错误提示后'));
  check('per-message edits survive closing confirmation, can be restored, and never change the archive original');
  await page.getByTestId('topics-send-note').fill('本次先定位问题，不修改代码。');
  await initialPreview.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByTestId('topics-send').click();
  assert.equal(await page.getByTestId('topics-send-note').inputValue(), '本次先定位问题，不修改代码。');
  const frozenRoot = join(ui.project, 'state', 'extensions', 'topic-materials');
  assert.equal(existsSync(frozenRoot) && readdirSync(frozenRoot).some(name => name.endsWith('.json')), false,
    'opening and closing confirmation must not freeze or dispatch anything');
  await initialPreview.getByRole('button', { name: '返回', exact: true }).click();
  check('send opens a material confirmation with an optional per-send note; closing keeps the draft and creates no conversation or delivery');
  await page.getByTestId('topic-detail-topic-1').getByRole('button', { name: '查看上下文', exact: true }).first().click();
  const context = page.getByRole('dialog', { name: '上下文', exact: true });
  await context.getByText('这是原消息前的一条补充，只有主动选择后才交接。', { exact: true }).waitFor();
  assert.equal((await context.innerText()).includes('mediaId='), false);
  await context.getByRole('button', { name: '完成', exact: true }).click();
  check('archive titles, caption-only originals and context display cleanly; older dates are explicit and a checked message previews its image before a target is chosen');
  const nativeSession = await createPaseoApi(client).agents.create({ cwd: ui.project, config: { provider: 'codex/recovery-fixture' }, title: '档案材料验收会话' });
  await page.getByTestId('topics-send').click();
  await page.getByTestId('topics-target').click();
  const targetPicker = page.getByRole('dialog', { name: '目标会话', exact: true });
  await targetPicker.getByRole('button', { name: '档案材料验收会话', exact: true }).click();
  assert.ok((await initialPreview.innerText()).includes('codex · recovery-fixture'));
  await initialPreview.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '清空材料', exact: true }).click();
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
  await page.getByTestId('topics-send').click();
  const preview = page.getByTestId('topics-send-dialog');
  await preview.waitFor();
  assert.ok((await preview.innerText()).includes('文件列表出现长错误提示后，目录被往下挤了。'));
  assert.equal((await preview.innerText()).includes('派生分析'), false);
  assert.equal(await page.getByTestId('topics-send-note').inputValue(), '', 'clearing a material batch clears its note');
  await page.getByTestId('topics-send-note').fill('先核对原始图片，再给出排查步骤。');
  await preview.screenshot({ path: join(output, 'topics-send-confirmation.png') });
  await preview.getByRole('button', { name: '返回', exact: true }).click();
  check('preview shows exactly the chosen originals and image thumbnails, excluding optional analysis');
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
  await page.getByTestId('topics-send').click();
  await page.getByTestId('topics-send-note').fill('窄屏的本次说明仍然可以编辑。');
  await preview.screenshot({ path: join(output, 'topics-send-confirmation-narrow.png') });
  await preview.getByRole('button', { name: '返回', exact: true }).click();
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
  await page.getByTestId('topics-confirm').click();
  await page.getByTestId('topics-send-status').getByText('话题有更新，请重新选材', { exact: true }).waitFor();
  await preview.getByRole('button', { name: '返回', exact: true }).click();
  const footerAfter = await page.getByTestId('topics-basket').boundingBox();
  assert.equal(await page.getByText('late original must not be selected', { exact: true }).count(), 0);
  await shot('topics-c-update-notice');
  check('polling preserves selection; a stale snapshot is rejected in a fixed status row without adding a banner');
  await page.getByRole('button', { name: '重新读取并清除此话题选择', exact: true }).click();
  await page.getByTestId('topic-basket-topic-1').waitFor({ state: 'detached' });
  writeFileSync(join(ui.project, 'state', 'agent-bindings.json'), JSON.stringify(fixtureBindings));
  await page.getByTestId('topics-send').click();
  await page.getByTestId('topics-target').click();
  await targetPicker.getByRole('button', { name: 'topics-dev', exact: true }).click();
  await page.getByTestId('topics-confirm').click();
  await page.getByTestId('topics-confirm').getByText('查回执', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('topics-send-note').isEditable(), false);
  const previewsBefore = readdirSync(join(ui.project, 'state', 'extensions', 'topic-materials')).filter(name => name.endsWith('.json')).length;
  await page.getByTestId('topics-confirm').click();
  const previewsAfter = readdirSync(join(ui.project, 'state', 'extensions', 'topic-materials')).filter(name => name.endsWith('.json')).length;
  assert.equal(previewsBefore, previewsAfter);
  await preview.getByRole('button', { name: '返回', exact: true }).click();
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
  await page.getByTestId('topic-expand-topic-1').click();
  await page.getByTestId('topic-message-message-1').click();
  await page.getByTestId('topics-send').click();
  await page.getByTestId('topics-target').click();
  await targetPicker.getByRole('button', { name: '档案材料验收会话', exact: true }).click();
  const existingNote = '请先检查截图中的布局问题，只给出排查建议。';
  await page.getByTestId('topics-send-note').fill(existingNote);
  loseNextTopicSend = true;
  await page.getByTestId('topics-confirm').click();
  await page.getByTestId('topics-confirm').getByText('查回执',{exact:true}).waitFor();
  assert.equal(lostTopicResponses,1);
  assert.equal(await page.getByTestId('topics-send-note').isEditable(),false);
  const frozenBeforeReceipt = readdirSync(frozenRoot).filter(name=>name.endsWith('.json')).length;
  await page.getByTestId('topics-confirm').click();
  await page.getByTestId('topics-send').getByText('打开会话', { exact: true }).waitFor();
  assert.equal(readdirSync(frozenRoot).filter(name=>name.endsWith('.json')).length,frozenBeforeReceipt);
  check('a lost frontend acknowledgement keeps the note and target locked; querying the saved receipt reconciles the accepted send without a second snapshot or dispatch');
  let deliveredImage = false, deliveredNote = false;
  for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
    const records = existsSync(ui.topicsFixtureRoot) ? readdirSync(ui.topicsFixtureRoot).filter(name => name.endsWith('.json')) : [];
    for (const name of records) {
      const record = JSON.parse(readFileSync(join(ui.topicsFixtureRoot, name), 'utf8'));
      for (const item of (record.inputs || []).flat()) {
        if (item.type === 'text' && item.text.includes(existingNote)) deliveredNote = true;
        const bytes = item.type === 'localImage' && item.path ? readFileSync(item.path)
          : item.type === 'image' && typeof item.url === 'string' && item.url.startsWith('data:') ? Buffer.from(item.url.split(',')[1], 'base64') : undefined;
        if (bytes && createHash('sha256').update(bytes).digest('hex') === fixture.imageHash) deliveredImage = true;
      }
    }
    if (deliveredImage && deliveredNote) break;
    await page.waitForTimeout(100);
  }
  assert.equal(deliveredImage, true, 'the actual isolated Paseo host must deliver original image bytes to its local protocol fixture');
  assert.equal(deliveredNote, true, 'the host must deliver the users instructions together with the selected originals');
  await shot('topics-native-send-accepted');
  await page.getByTestId('topics-send').click();
  await page.getByText('RECOVERY_FIXTURE_COMPLETED', { exact: true }).filter({visible:true}).last().waitFor();
  assert.equal(await page.getByTestId('workbench-topics-panel').count(), 0);
  const chatImages=page.getByTestId('topic-chat-images').filter({visible:true}).last();
  await chatImages.getByRole('img').first().waitFor();
  await chatImages.getByRole('button',{name:'查看所选图片 1',exact:true}).click();
  await page.getByRole('dialog',{name:'图片',exact:true}).getByRole('img',{name:'所选原图',exact:true}).waitFor();
  await page.getByRole('dialog',{name:'图片',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
  await page.screenshot({path:join(output,'existing-conversation-with-original-image.png')});
  check('the receiving conversation visibly renders the original photo, with a full-size image viewer');
  check('actual isolated Paseo sends original image bytes into an existing native session and opens that conversation; the local provider is a protocol fixture, not a model');
  await openIsolatedWorkbench(page, ui.url, 'a');
  await page.getByText('话题', { exact: true }).filter({ visible: true }).first().click();
  await page.getByTestId('topic-select-topic-1').click();
  await page.getByTestId('topics-send').click();
  await page.getByTestId('topics-send-dialog').getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByTestId('topics-model').getByText(/ · /).waitFor();
  await page.getByTestId('topics-permission').getByText('权限 · Full Access',{exact:true}).waitFor();
  await page.getByTestId('topics-model').click();
  const modelPicker=page.getByTestId('topics-session-picker');
  await modelPicker.getByRole('button',{name:'Codex',exact:true}).waitFor();
  assert.equal(await modelPicker.getByRole('button',{name:'Topic analysis fixture',exact:true}).count(),0);
  await modelPicker.getByRole('button',{name:'Codex',exact:true}).click();
  await modelPicker.getByRole('button',{name:'Topic analysis fixture',exact:true}).waitFor();
  await modelPicker.screenshot({path:join(output,'topics-provider-models.png')});
  await modelPicker.getByRole('button',{name:'返回 Provider',exact:true}).click();
  await modelPicker.getByRole('button',{name:'Codex',exact:true}).click();
  await modelPicker.getByRole('button',{name:'Topic analysis fixture',exact:true}).click();
  await page.getByTestId('topics-effort').click();
  await page.getByTestId('topics-effort-high').click();
  await page.getByTestId('topics-permission').click();
  await page.getByTestId('topics-permission-auto').click();
  await page.getByTestId('topics-permission').click();
  await page.getByTestId('topics-permission-full-access').click();
  for(const deadline=Date.now()+5000;;){
    const remembered=await rpc('workspace.workbench.archive-topics',{connectionRevision:(await rpc('workspace.workbench.communications-connection',{action:'read'})).revision,request:{action:'preferences'}});
    if(remembered.newSession?.model==='topic-alternate'&&remembered.newSession?.thinkingOptionId==='high'&&remembered.newSession?.modeId==='full-access')break;
    if(Date.now()>deadline)throw Error('last_session_choice_not_persisted');
    await page.waitForTimeout(50);
  }
  await page.reload();
  await selectGlobalWorkbenchProject(page,'a');
  await page.getByText('话题',{exact:true}).filter({visible:true}).first().click();
  await page.getByTestId('topic-select-topic-1').click();
  await page.getByTestId('topics-send').click();
  await page.getByTestId('topics-model').getByText('Codex · Topic analysis fixture',{exact:true}).waitFor();
  await page.getByTestId('topics-effort').getByText('推理强度 · High',{exact:true}).waitFor();
  await page.getByTestId('topics-permission').getByText('权限 · Full Access',{exact:true}).waitFor();
  check('provider-first model selection, per-model effort and Full Access choices survive a full page reload');
  const freshNote = '用新会话分析这组材料，先解释图片中的问题。';
  assert.equal(await page.getByTestId('topics-send-note').inputValue(), '');
  await page.getByTestId('topics-send-note').fill(freshNote);
  const editedMarker='已人工核实：仅检查页面布局。';
  await page.getByTestId('topics-edit-message-1').click();
  await page.getByTestId('topics-edit-text-message-1').fill(editedMarker+' @阿宁 请确认。');
  await page.getByTestId('topics-edit-message-1').click();
  await page.getByTestId('topics-identity-name').click();
  assert.ok((await page.getByTestId('topics-send-dialog').innerText()).includes('@阿宁 请确认。'));
  await page.getByTestId('topics-identity-alias').click();
  await page.getByTestId('topics-material-menu').click();
  const materialMenu=page.getByRole('dialog',{name:'材料处理',exact:true});
  await materialMenu.getByRole('button',{name:'查看对应',exact:true}).click();
  const people=page.getByRole('dialog',{name:'参与者对应',exact:true});
  assert.ok((await people.innerText()).includes('小林'));assert.ok((await people.innerText()).includes('阿宁'));
  await people.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByTestId('topics-template-new').click();
  await page.getByTestId('topics-template-name').fill('我的排查说明');
  const presetInstruction='请先定位问题，不要修改代码。';
  await page.getByTestId('topics-template-body').fill(presetInstruction+'\n{{note}}\n\n{{materials}}');
  await page.getByTestId('topics-template-editor').screenshot({path:join(output,'topics-instruction-template-editor.png')});
  await page.getByTestId('topics-template-save').click();
  await materialMenu.getByRole('button',{name:'我的排查说明',exact:true}).waitFor();
  await page.getByTestId('topics-content-preview').click();
  const finalContent=page.getByTestId('topics-final-content');
  const finalText=await finalContent.innerText();
  assert.ok(finalText.includes(presetInstruction));assert.ok(finalText.includes(freshNote));assert.ok(finalText.includes(editedMarker));
  assert.ok(finalText.includes('XL'));assert.ok(finalText.includes('AN'));assert.ok(finalText.includes('2026-11-19 16:20'));
  assert.equal(finalText.includes('阿宁'),false);assert.equal(finalText.includes('小林'),false);assert.equal(finalText.includes('mediaId='),false);
  await finalContent.screenshot({path:join(output,'topics-edited-conversation-preview.png')});
  await finalContent.getByRole('button',{name:'关闭',exact:true}).click();
  await materialMenu.getByRole('button',{name:'关闭',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>{const node=document.querySelector('[data-testid="topics-send-dialog"]');if(!node)return false;const rect=node.getBoundingClientRect();return rect.x>=0&&rect.right<=window.innerWidth;});
  const editedDialog=page.getByTestId('topics-send-dialog'),editedBounds=await editedDialog.boundingBox();
  assert.ok(editedBounds.x>=0&&editedBounds.x+editedBounds.width<=390);
  const editedSendBounds=await page.getByTestId('topics-confirm').boundingBox();
  assert.ok(editedSendBounds.x>=editedBounds.x&&editedSendBounds.x+editedSendBounds.width<=editedBounds.x+editedBounds.width);
  await editedDialog.screenshot({path:join(output,'topics-editable-material-phone.png')});
  await page.setViewportSize({width:1448,height:1120});
  await page.waitForFunction(()=>{const node=document.querySelector('[data-testid="topics-send-dialog"]');return node&&node.getBoundingClientRect().width>390;});
  check('editable multi-speaker material keeps dated chronology, pinyin name initials and mention relationships, with a reusable custom instruction template');
  const topicSessionCount = async () => (await createPaseoApi(client).agents.list({filter:{labels:{'workspace-workbench.role':'topic-session'}},page:{limit:100}})).entries.length;
  assert.equal(await topicSessionCount(), 0, 'selecting a model must not create an empty conversation');
  await page.getByTestId('topics-send-dialog').screenshot({ path: join(output, 'topics-new-session-confirmation.png') });
  await page.getByTestId('topics-confirm').click();
  await page.getByTestId('topics-send').getByText('打开会话', { exact: true }).waitFor();
  assert.equal(await topicSessionCount(), 1);
  let freshDelivery = false;
  for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
    for (const name of readdirSync(ui.topicsFixtureRoot).filter(name => name.endsWith('.json'))) {
      const record = JSON.parse(readFileSync(join(ui.topicsFixtureRoot, name), 'utf8'));
      if (record.requestedModel !== 'topic-alternate') continue;
      assert.equal(record.creationOptions?.approvalPolicy,'never');
      assert.equal(record.creationOptions?.sandbox,'danger-full-access');
      const inputs = (record.inputs || []).flat();
      const hasNote = inputs.some(item => item.type === 'text' && item.text.includes(freshNote)&&item.text.includes(editedMarker)&&item.text.includes(presetInstruction)&&!item.text.includes('阿宁'));
      const hasImage = inputs.some(item => {
        const bytes = item.type === 'localImage' && item.path ? readFileSync(item.path)
          : item.type === 'image' && item.url?.startsWith('data:') ? Buffer.from(item.url.split(',')[1], 'base64') : undefined;
        return bytes && createHash('sha256').update(bytes).digest('hex') === fixture.imageHash;
      });
      if (hasNote && hasImage && record.turnOptions?.some(option=>option.effort==='high'&&option.approvalPolicy==='never'&&option.sandboxPolicy?.type==='dangerFullAccess')) freshDelivery = true;
    }
    if (freshDelivery) break;
    await page.waitForTimeout(100);
  }
  assert.equal(freshDelivery, true, 'the provider must receive the selected model, high effort, Full Access, note and original images');
  await page.getByTestId('topics-send').click();
  await page.getByText('RECOVERY_FIXTURE_COMPLETED', { exact: true }).filter({visible:true}).last().waitFor();
  assert.equal(await page.getByTestId('workbench-topics-panel').count(), 0);
  await page.getByTestId('topic-chat-images').filter({visible:true}).last().getByRole('img').first().waitFor();
  await page.reload();
  await page.getByTestId('topic-chat-images').filter({visible:true}).last().getByRole('img').first().waitFor();
  await page.screenshot({path:join(output,'new-conversation-images-after-reload.png')});
  check('a new native conversation keeps visible photo attachments after a full page reload');
  check('confirmation creates one new native session with the explicitly selected host model, original image bytes and per-send instructions, then opens it');
  const pdfTopic = fixture.state.topics[2], pdfMessage = pdfTopic.messages[0];
  pdfMessage.assets.push({ id: 'pdf-original', name: 'feedback.pdf', kind: 'file', mimeType: 'application/pdf', state: 'ready' });
  const currentConnection = await rpc('workspace.workbench.communications-connection', { action: 'read' });
  const deliver = request => rpc('workspace.workbench.archive-topics-delivery', { connectionRevision: currentConnection.revision, request });
  const [issueImageAsset] = issue.attachments;
  const mixedPreview = await deliver({ action: 'preview', targetId: 'session:' + nativeSession.id, selections: [{
    topicId: pdfTopic.id, revision: pdfTopic.revision, inputRevision: pdfTopic.inputRevision,
    messages: [{ id: pdfMessage.id, version: pdfMessage.version }], includeAnalysis: false,
    assets: [{ id: 'pdf-original', messageId: pdfMessage.id, messageVersion: pdfMessage.version }],
  }], issueSelections: [{ issueId: issue.id, version: issue.version, body: true,
    comments: issue.comments.map(({ id, version }) => ({ id, version })), attachments: [{ id: issueImageAsset.id, version: issueImageAsset.version }],
  }] });
  const expectedText = [pdfMessage.text, issue.body, issue.comments[0].text];
  assert.ok(expectedText.every(original => mixedPreview.text.includes(original)), 'the frozen preview includes both sources');
  assert.equal((await deliver({ action: 'send', id: mixedPreview.id })).state, 'accepted');
  let deliveredMixed = false;
  for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
    for (const name of readdirSync(ui.topicsFixtureRoot).filter(name => name.endsWith('.json'))) {
      const record = JSON.parse(readFileSync(join(ui.topicsFixtureRoot, name), 'utf8'));
      for (const input of record.inputs || []) {
        const texts = input.filter(item => item.type === 'text').map(item => item.text);
        const text = texts.join('\n');
        if (!expectedText.every(original => text.includes(original))) continue;
        const file = texts.find(item => item.includes('Uploaded file: feedback.pdf'));
        const path = file && /Path: ([^\n]+)/.exec(file)?.[1];
        const hasImage = input.some(item => item.type === 'localImage' && item.path && readFileSync(item.path).equals(fixture.image) ||
          item.type === 'image' && item.url?.startsWith('data:') && Buffer.from(item.url.split(',')[1], 'base64').equals(fixture.image));
        if (path && readFileSync(path).equals(fixture.pdf) && hasImage) deliveredMixed = true;
      }
    }
    if (deliveredMixed) break;
    await page.waitForTimeout(100);
  }
  assert.equal(deliveredMixed, true, 'one native send must deliver the selected chat and TAPD originals, including the PDF and image bytes');
  check('one native send delivers the selected chat text, TAPD description and comment, PDF file and image bytes');
  await openIsolatedWorkbench(page,ui.url,'a');
  await page.getByText('话题',{exact:true}).filter({visible:true}).first().click();
  await page.getByTestId('topic-row-topic-1').waitFor();
  await panel.getByPlaceholder('搜索话题').fill('视频播放');
  await page.getByTestId('topic-row-topic-4').waitFor();
  await page.getByTestId('topic-expand-topic-4').click();
  const videoSource=page.getByTestId('topic-original-message-'+videoMessage.id);
  const videoTile=videoSource.getByRole('button',{name:'查看 视频.mp4',exact:true});
  await videoTile.getByRole('img',{name:'视频.mp4',exact:true}).waitFor();
  const sourceBounds=await videoSource.boundingBox(),tileBounds=await videoTile.boundingBox(),nextBounds=await page.getByTestId('topic-original-message-video-followup-1').boundingBox();
  assert.ok(tileBounds.y>=sourceBounds.y&&tileBounds.y+tileBounds.height<=sourceBounds.y+sourceBounds.height);
  assert.ok(tileBounds.y+tileBounds.height<=nextBounds.y,'the video must precede later discussion messages');
  await panel.screenshot({path:join(output,'topics-inline-video-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.querySelector('[data-testid="workbench-topics-panel"]')?.getBoundingClientRect().width<=390);
  const directPreview=await videoTile.evaluate(element=>new Promise(resolve=>{const observer=new IntersectionObserver(entries=>{observer.disconnect();resolve(entries[0].intersectionRatio);});observer.observe(element);}));
  assert.equal(directPreview,1,'the phone topic tab must show the video without scrolling to the end or opening context');
  await panel.screenshot({path:join(output,'topics-inline-video-phone.png')});
  check('a long discussion shows the video in its own message on a phone viewport before any context or end-of-discussion scrolling');
  assert.equal((await panel.innerText()).includes('fileName='),false);
  assert.equal((await panel.innerText()).includes('@opaque-native-video'),false);
  await videoTile.click();
  const videoDialog=page.getByTestId('topics-asset-preview');
  await videoDialog.getByTestId('topic-video-frames').getByRole('img').nth(3).waitFor();
  await page.waitForFunction(()=>{const video=document.querySelector('[data-testid="topics-asset-preview"] video');return video&&video.readyState>=2&&video.duration===2;});
  await videoDialog.getByTestId('topic-video-player').evaluate(video=>video.play());
  await page.waitForFunction(()=>document.querySelector('[data-testid="topics-asset-preview"] video')?.currentTime>0);
  await videoDialog.getByTestId('topic-video-player').evaluate(video=>video.pause());
  await videoDialog.screenshot({path:join(output,'topics-video-original-and-frames.png')});
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>{const video=document.querySelector('[data-testid="topic-video-player"]');if(!video)return false;const rect=video.getBoundingClientRect();return rect.x>=0&&rect.right<=window.innerWidth;});
  await videoDialog.screenshot({path:join(output,'topics-video-phone.png')});
  await page.setViewportSize({width:1448,height:1120});
  await videoDialog.getByRole('button',{name:'关闭',exact:true}).click();
  check('a saved video advertised upstream as pending/video renders a real thumbnail and plays in the actual browser, with dated frame previews and a phone layout');
  await page.getByTestId('topic-message-'+videoMessage.id).click();
  await page.getByTestId('topics-send').click();
  await page.getByTestId('topics-identity-name').click();
  const videoNote='检查所选视频里的镜像展示，仅依据已附材料。';
  await page.getByTestId('topics-send-note').fill(videoNote);
  const expectedFrames=await deliver({action:'asset',part:'video-preview',topicId:videoTopic.id,messageId:videoMessage.id,assetId:'video-original'});
  await page.getByTestId('topics-send-dialog').screenshot({path:join(output,'topics-video-send-name-choice.png')});
  await page.getByTestId('topics-confirm').click();
  await page.getByTestId('topics-send').getByText('打开会话',{exact:true}).waitFor();
  let videoReceived=false;
  const expectedHashes=expectedFrames.frames.map(frame=>createHash('sha256').update(Buffer.from(frame.base64,'base64')).digest('hex'));
  for(const deadline=Date.now()+20000;Date.now()<deadline;){
    for(const name of readdirSync(ui.topicsFixtureRoot).filter(name=>name.endsWith('.json'))){
      const record=JSON.parse(readFileSync(join(ui.topicsFixtureRoot,name),'utf8'));
      for(const input of record.inputs||[]){
        if(!input.some(item=>item.type==='text'&&item.text.includes(videoNote)))continue;
        const hashes=input.flatMap(item=>{
          const bytes=item.type==='localImage'&&item.path?readFileSync(item.path):item.type==='image'&&item.url?.startsWith('data:')?Buffer.from(item.url.split(',')[1],'base64'):undefined;
          return bytes?[createHash('sha256').update(bytes).digest('hex')]:[];
        });
        const file=input.find(item=>item.type==='text'&&item.text.includes('Uploaded file: 视频.mp4'));
        const path=file&&/Path: ([^\n]+)/.exec(file.text)?.[1];
        if(path&&readFileSync(path).equals(fixture.video)&&JSON.stringify(hashes)===JSON.stringify(expectedHashes))videoReceived=true;
      }
    }
    if(videoReceived)break;
    await page.waitForTimeout(100);
  }
  assert.equal(videoReceived,true,'the actual provider protocol must receive the original MP4 file and all four native image parts');
  await page.getByTestId('topics-send').click();
  await page.getByTestId('topic-chat-video').filter({visible:true}).last().waitFor();
  await page.reload();
  const chatVideo=page.getByTestId('topic-chat-video').filter({visible:true}).last();
  await chatVideo.getByRole('img',{name:'所选视频 1',exact:true}).waitFor();
  await chatVideo.click();
  const chatVideoDialog=page.getByRole('dialog',{name:'视频',exact:true});
  await chatVideoDialog.getByTestId('topic-video-frames').getByRole('img').nth(3).waitFor();
  await page.waitForFunction(()=>{const video=document.querySelector('[data-testid="topic-video-player"]');return video&&video.readyState>=2&&video.duration===2;});
  await chatVideoDialog.screenshot({path:join(output,'conversation-video-after-reload.png')});
  await chatVideoDialog.getByRole('button',{name:'关闭',exact:true}).click();
  assert.equal((await deliver({action:'preferences'})).material.identity,'name');
  check('the actual local provider receives video bytes plus four native frame images; the conversation video still plays after reload and the visible identity choice is remembered');
  const largeVideo = Buffer.alloc(21 * 1024 * 1024, 9);
  const largeId = createHash('sha256').update('unified-large-movie').digest('hex');
  const recording = { id: largeId, name: '屏幕录制.mov', mimeType: 'video/quicktime', kind: 'video', state: 'ready', size: largeVideo.length, version: 'recording-1' };
  fixture.state.assetBytes.set(largeId, { bytes: largeVideo, mimeType: recording.mimeType });
  videoMessage.assets = [recording];
  issue.attachments = [recording]; issue.version = 'revision-3';
  await openIsolatedWorkbench(page, ui.url, 'a');
  await page.getByText('话题', { exact: true }).filter({ visible: true }).first().click();
  await page.getByTestId('topic-row-topic-1').waitFor();
  await panel.getByPlaceholder('搜索话题').fill('视频播放');
  await page.getByTestId('topic-expand-topic-4').click();
  await videoSource.getByRole('button', { name: '查看 屏幕录制.mov', exact: true }).getByText('可选择并发送原视频', { exact: true }).waitFor();
  await videoSource.getByRole('button', { name: '查看 屏幕录制.mov', exact: true }).click();
  const recordingDialog = page.getByRole('dialog', { name: '屏幕录制.mov', exact: true });
  await recordingDialog.getByTestId('topic-video-file').getByText('21.0 MiB', { exact: true }).waitFor();
  await recordingDialog.getByRole('button', { name: '选择原视频', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 900 });
  await shot('dingtalk-shared-video-fallback-phone');
  await tapdTab.click();
  await page.getByTestId('tapd-expand-' + issue.id).click();
  const issueRecording = page.getByTestId('tapd-detail-' + issue.id);
  await issueRecording.getByRole('button', { name: '查看 屏幕录制.mov', exact: true }).getByText('可选择并发送原视频', { exact: true }).waitFor();
  await issueRecording.getByRole('button', { name: '查看 屏幕录制.mov', exact: true }).click();
  await recordingDialog.getByTestId('topic-video-file').getByText('21.0 MiB', { exact: true }).waitFor();
  await recordingDialog.getByRole('button', { name: '选择原视频', exact: true }).click();
  await shot('tapd-shared-video-fallback-phone');
  await page.getByTestId('topics-send').click();
  await page.getByTestId('topics-send-dialog').getByRole('button', { name: '已有会话', exact: true }).click();
  await page.getByTestId('topics-target').click();
  await page.getByRole('dialog', { name: '目标会话', exact: true }).getByRole('button', { name: '档案材料验收会话', exact: true }).click();
  const fallbackNote = '核对这两条材料所附的屏幕录制。';
  await page.getByTestId('topics-send-note').fill(fallbackNote);
  await page.getByTestId('topics-confirm').click();
  await page.getByTestId('topics-send').getByText('打开会话', { exact: true }).waitFor();
  let largeOriginalReceived = false;
  for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
    for (const file of readdirSync(ui.topicsFixtureRoot).filter(name => name.endsWith('.json'))) {
      const record = JSON.parse(readFileSync(join(ui.topicsFixtureRoot, file), 'utf8'));
      for (const input of record.inputs || []) {
        if (!input.some(part => part.type === 'text' && part.text.includes(fallbackNote))) continue;
        const attached = input.find(part => part.type === 'text' && part.text.includes('Uploaded file: 屏幕录制.mov'));
        const path = attached && /Path: ([^\n]+)/.exec(attached.text)?.[1];
        if (path && readFileSync(path).equals(largeVideo)) largeOriginalReceived = true;
      }
    }
    if (largeOriginalReceived) break;
    await page.waitForTimeout(100);
  }
  assert.equal(largeOriginalReceived, true);
  await page.getByTestId('topics-send').click();
  await page.getByTestId('topic-chat-video').filter({ visible: true }).last().getByText('屏幕录制.mov', { exact: true }).waitFor();
  check('DingTalk and TAPD share video fallback cards and one actual native send delivers the larger MOV original when decoding is unavailable');

  const inlineBodyBefore = '🚀 正文截图前。', inlineBodyAfter = '正文截图后，继续检查文件名。';
  const inlineCommentBefore = '评论截图前。', inlineCommentAfter = '评论截图后，再核对移动端。';
  const inlineBodyId = createHash('sha256').update('tapd-inline-body').digest('hex');
  const inlineCommentId = createHash('sha256').update('tapd-inline-comment').digest('hex');
  issue.version = 'inline-revision-1'; issue.attachments = []; issue.attachmentsState = 'empty';
  issue.body = inlineBodyBefore + inlineBodyAfter;
  issue.comments[0].version = 'inline-comment-1';
  issue.comments[0].text = inlineCommentBefore + inlineCommentAfter;
  issue.inlineImages = [
    { id: inlineBodyId, name: '正文截图.png', state: 'ready', offset: Array.from(inlineBodyBefore).length },
    { id: inlineCommentId, name: '评论截图.png', state: 'ready', offset: Array.from(inlineCommentBefore).length, commentId: issue.comments[0].id },
  ];
  await page.setViewportSize({ width: 1448, height: 1120 });
  await openIsolatedWorkbench(page, ui.url, 'a');
  await page.getByText('话题', { exact: true }).filter({ visible: true }).first().click();
  await page.getByTestId('topic-row-topic-1').waitFor();
  await tapdTab.click();
  await page.getByTestId('tapd-expand-' + issue.id).click();
  const inlineDetail = page.getByTestId('tapd-detail-' + issue.id);
  const inlineBody = page.getByTestId('tapd-body-content-' + issue.id);
  const inlineComment = page.getByTestId('tapd-comment-content-' + issue.comments[0].id);
  await inlineBody.getByRole('img', { name: '正文截图.png', exact: true }).waitFor();
  await inlineComment.getByRole('img', { name: '评论截图.png', exact: true }).waitFor();
  const beforeImage = await inlineBody.getByText(inlineBodyBefore, { exact: true }).boundingBox();
  const placedImage = await inlineBody.getByRole('img', { name: '正文截图.png', exact: true }).boundingBox();
  const afterImage = await inlineBody.getByText(inlineBodyAfter, { exact: true }).boundingBox();
  assert.ok(beforeImage.y < placedImage.y && placedImage.y < afterImage.y);
  await inlineDetail.getByRole('checkbox', { name: '选择缺陷描述', exact: true }).click();
  await inlineBody.getByRole('checkbox', { name: '选择 正文截图.png', exact: true, checked: true }).waitFor();
  await inlineComment.getByRole('checkbox', { name: '选择 评论截图.png', exact: true, checked: false }).waitFor();
  await inlineDetail.getByRole('checkbox', { name: /^选择评论 / }).click();
  await inlineComment.getByRole('checkbox', { name: '选择 评论截图.png', exact: true, checked: true }).waitFor();
  await inlineBody.getByRole('checkbox', { name: '选择 正文截图.png', exact: true }).click();
  assert.equal(await inlineDetail.getByRole('checkbox', { name: '选择缺陷描述', exact: true }).getAttribute('aria-checked'), 'true');
  await inlineBody.getByRole('button', { name: '查看 正文截图.png', exact: true }).click();
  const inlineImageDialog = page.getByRole('dialog', { name: '正文截图.png', exact: true });
  await inlineImageDialog.getByRole('img', { name: '正文截图.png', exact: true }).waitFor();
  await inlineImageDialog.getByRole('button', { name: '选择附件', exact: true }).click();
  await shot('tapd-inline-images-desktop');
  await page.setViewportSize({ width: 390, height: 900 });
  await shot('tapd-inline-images-phone');
  await page.getByTestId('topics-send').click();
  const inlinePreview = page.getByTestId('topics-send-dialog');
  await inlinePreview.getByRole('img', { name: '正文截图.png', exact: true }).waitFor();
  await inlinePreview.getByRole('img', { name: '评论截图.png', exact: true }).waitFor();
  await inlinePreview.getByRole('button', { name: '已有会话', exact: true }).click();
  await page.getByTestId('topics-target').click();
  await page.getByRole('dialog', { name: '目标会话', exact: true }).getByRole('button', { name: '档案材料验收会话', exact: true }).click();
  const inlineNote = '核对 TAPD 正文和评论中的图片。';
  await page.getByTestId('topics-send-note').fill(inlineNote);
  await page.getByTestId('topics-confirm').click();
  await page.getByTestId('topics-send').getByText('打开会话', { exact: true }).waitFor();
  let inlineReceived = false;
  for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
    for (const file of readdirSync(ui.topicsFixtureRoot).filter(name => name.endsWith('.json'))) {
      const record = JSON.parse(readFileSync(join(ui.topicsFixtureRoot, file), 'utf8'));
      for (const input of record.inputs || []) {
        if (!input.some(part => part.type === 'text' && part.text.includes(inlineNote) && part.text.includes(issue.body) && part.text.includes(issue.comments[0].text))) continue;
        const images = input.flatMap(part => part.type === 'localImage' && part.path ? [readFileSync(part.path)]
          : part.type === 'image' && part.url?.startsWith('data:') ? [Buffer.from(part.url.split(',')[1], 'base64')] : []);
        if (images.length === 1 && images[0].equals(fixture.image)) inlineReceived = true;
      }
    }
    if (inlineReceived) break;
    await page.waitForTimeout(100);
  }
  assert.equal(inlineReceived, true, 'selected inline originals must reach the native session with their body and comment text, deduplicated by bytes');
  await page.getByTestId('topics-send').click();
  await page.getByTestId('topic-chat-images').filter({ visible: true }).last().getByRole('img').first().waitFor();
  check('TAPD body and comment images retain Unicode placement on desktop and phone, share original-image selection and previews, and reach an actual native session with exact bytes');
  assert.equal(fixture.state.requests.some(request => request.url.startsWith('/v1/projects')), false);
  assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors));
  report.fidelity.push('same flat topic-list + bottom-basket architecture as refined C',
    'short control labels; source text remains intact', 'selected rows use the workbench blue accent and checked controls',
    'original media is shown as thumbnails with individual selection', 'one footer action opens material confirmation, per-send notes and existing/new session choices',
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
