#!/usr/bin/env node
// Full QA APK + original local Paseo bundle + owned daemon + real installed plugins.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { adb, connectDevice } from './device-browser.mjs';
import { uiNodes } from './device-ui.mjs';

const { values } = parseArgs({ options: { serial: { type: 'string' }, output: { type: 'string' } } });
assert(values.serial, 'Usage: verify-device-extensions.mjs --serial QA_EMULATOR [--output /tmp/pocket-extensions]');
const serial = values.serial, packageName = 'dev.paseo.pocket.qa', origin = 'https://appassets.androidplatform.net';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(values.output || '/tmp/pocket-device-extensions'); await mkdir(output, { recursive: true });
const report = { kind: 'actual-Pocket-Android-client-extensions', serial, packageName, checks: [], screenshots: [], errors: [], ok: false };
let host, fixture, cdp, port, logs = '', hostExited, reversed = false;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function wait(check, label, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(150);
  }
  throw Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`);
}
async function visible(selector) {
  return cdp.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)return false;const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(node).visibility!=='hidden';})()`);
}
async function tap(selector, texts = []) {
  const point = await wait(() => cdp.evaluate(`(async()=>{const texts=${JSON.stringify(texts)};for(const node of document.querySelectorAll(${JSON.stringify(selector)})){
    const r=node.getBoundingClientRect();if(!r.width||!r.height||getComputedStyle(node).visibility==='hidden')continue;
    if(texts.length&&!texts.includes((node.textContent||'').trim())&&!texts.includes(node.getAttribute('aria-label')))continue;
    if(r.x<0||r.y<0||r.right>innerWidth||r.bottom>innerHeight){node.scrollIntoView({block:'nearest',inline:'center'});return null;}
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const next=node.getBoundingClientRect();if(Math.abs(next.x-r.x)>0.5||Math.abs(next.y-r.y)>0.5||Math.abs(next.width-r.width)>0.5||Math.abs(next.height-r.height)>0.5)return null;
    const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(hit&&(node.contains(hit)||hit.contains(node)))return{x,y};}return null;})()`), selector);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function fill(selector, text) {
  await wait(() => cdp.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)return false;input.focus();input.select();return true;})()`), 'form field ' + selector);
  await wait(() => cdp.evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`), 'focused ' + selector);
  await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
  await cdp.send('Input.insertText', { text });
  await wait(() => cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(text)}`), 'filled ' + selector);
}
async function screenshot(name) {
  const path = join(output, name + '.png');
  // WebView CDP capture can squash scroll-layer text on this provider. Capture
  // the actual Android compositor, including native insets and tool handle.
  await writeFile(path, await adb(serial, ['exec-out', 'screencap', '-p'], { encoding: 'buffer' })); report.screenshots.push(path);
}
async function attach() {
  cdp = await connectDevice(serial, { packageName });
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  cdp.events.on('Runtime.exceptionThrown', value => report.errors.push(value.exceptionDetails?.exception?.description || value.exceptionDetails?.text));
}
async function allowLocalNetwork() {
  const nodes = await uiNodes(serial);
  if (!nodes.some(node => /local network|nearby devices|附近设备|本地网络/i.test(node.text || ''))) return;
  const allow = nodes.find(node => /permissioncontroller$/.test(node.package || '') && /permission_allow(?:_foreground_only)?_button$/.test(node['resource-id'] || ''));
  if (!allow) return;
  const bounds = allow.bounds.match(/\d+/g).map(Number);
  await adb(serial, ['shell', 'input', 'tap', String((bounds[0] + bounds[2]) / 2), String((bounds[1] + bounds[3]) / 2)]);
}
const toggle = '[data-testid="workspace-explorer-toggle"]';
const workbenchTab = '[data-testid="pocket-tab-workspace-workbench-paseo-workbench"]';
const workbench = '[data-testid="pocket-panel-workspace-workbench-paseo-workbench"]';
try {
  await adb(serial, ['shell', 'pm', 'path', packageName]);
  report.version = (await adb(serial, ['shell', 'dumpsys', 'package', packageName])).match(/versionName=([^\s]+)/)?.[1];
  await adb(serial, ['shell', 'pm', 'clear', packageName]);
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); port = probe.address().port; await new Promise(r => probe.close(r));
  host = spawn(process.execPath, [join(root, 'android-app/scripts/serve-isolated-paseo.mjs')], {
    cwd: root, env: { ...process.env, POCKET_TEST_WORKBENCH: '1', POCKET_TEST_PROXY_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  hostExited = new Promise(r => host.once('exit', (code, signal) => r({ code, signal })));
  host.stderr.on('data', chunk => logs = (logs + chunk).slice(-100000));
  createInterface({ input: host.stdout }).on('line', line => {
    logs = (logs + line + '\n').slice(-100000);
    try { const value = JSON.parse(line); if (value.kind === 'actual-isolated-paseo-with-protocol-fixture') fixture = value; } catch {}
  });
  await wait(() => fixture, 'isolated host', 120000); report.fixture = fixture;
  await adb(serial, ['reverse', `tcp:${port}`, `tcp:${port}`]); reversed = true;
  await adb(serial, ['shell', 'am', 'start', '-n', `${packageName}/dev.paseo.pocket.MainActivity`]); await attach();
  await wait(() => cdp.evaluate('window.__paseoHostRuntimeStore?.isHostRegistryLoaded?.() === true'), 'local page');
  await wait(() => cdp.evaluate('(()=>{const node=[...document.querySelectorAll("[role=button],div")].find(n=>["Direct connection","直接连接"].includes((n.textContent||"").trim()));if(!node)return false;node.click();return true;})()'), 'Direct connection form');
  await fill('[data-testid="direct-host-input"]', 'localhost'); await fill('[data-testid="direct-port-input"]', String(port));
  // Setup uses the public form's click handler; touch coordinates can move while the IME animates.
  if (!(await cdp.evaluate('!!document.querySelector("[data-testid=direct-ssl-toggle-checked]")')))
    await cdp.evaluate('document.querySelector("[data-testid=direct-ssl-toggle]").click()');
  await wait(() => cdp.evaluate('!!document.querySelector("[data-testid=direct-ssl-toggle-checked]")'), 'SSL checked');
  await cdp.evaluate('document.querySelector("[data-testid=direct-host-submit]").click()');
  let permissionChecks = 0;
  const hosts = await wait(async () => {
    const rows = await cdp.evaluate('window.__paseoHostRuntimeStore.getHosts()');
    if (rows.length) return rows;
    if (permissionChecks++ < 5) await allowLocalNetwork();
    return null;
  }, 'connected host');
  assert.equal(hosts.length, 1); assert(hosts[0].connections.every(connection => connection.type === 'directTcp' && connection.endpoint === `localhost:${port}`));
  await cdp.send('Page.navigate', { url: `${origin}/h/${hosts[0].serverId}/agent/${fixture.agents[0]}` });
  await wait(() => visible(toggle), 'real conversation');
  assert.equal(await cdp.evaluate('isSecureContext && !!window.Pocket && !!window.__pocketExtensions'), true);
  const route = await cdp.evaluate('location.href');
  await tap(toggle); await wait(() => visible(workbenchTab), 'right Workbench Tab');
  assert.equal(await visible('[data-testid="workbench-graph-content"]'), false);
  await screenshot('01-sidebar-before-open');
  await tap(workbenchTab); await wait(() => visible('[data-testid="workbench-graph-content"]'), 'real Workbench repository graph', 45000);
  assert.equal(await cdp.evaluate('location.href'), route);
  report.context = await cdp.evaluate('(()=>{const owner=window.__r(3680).pluginRegistry.getSnapshot().find(p=>p.id==="workspace-workbench-paseo");return window.Pocket.connect({paseo:owner.paseo}).context.getSnapshot()})()');
  assert.equal(report.context.hostId, hosts[0].serverId); assert.equal(report.context.agentId, fixture.agents[0]);
  await screenshot('02-workbench-in-sidebar');
  report.checks.push('The actual APK injects into the original local HTTPS bundle, adds a right Tab, lazily loads real Workbench data, and retains the current conversation route and agent context.');

  await adb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
  await wait(async () => !(await visible('[data-testid="explorer-header"]')), 'native Back closes sidebar');
  assert.equal(await cdp.evaluate('location.href'), route);
  await tap(toggle); await wait(() => visible(workbench), 'remembered Workbench');
  assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(workbenchTab)}).getAttribute('aria-selected')`), 'true');
  await tap('[data-testid="explorer-tab-files"]'); await wait(() => visible('[data-testid="file-explorer-tree-scroll"]'), 'original Files Tab');
  await tap('[data-testid="explorer-close"]'); await tap(toggle);
  assert.equal(await cdp.evaluate('document.querySelector("[data-testid=explorer-tab-files]").getAttribute("aria-selected")'), 'true');
  await tap(workbenchTab); await wait(() => visible(workbench), 'Workbench reselect');
  report.selectionBeforeRestart = await cdp.evaluate('localStorage.getItem("pocket.extensions.sidebar.v1")');
  report.checks.push('System Back closes the sidebar before navigation; reopening restores Workbench, and selecting Files keeps the original file browser usable.');

  // WebView localStorage commits UI preferences asynchronously. Exercise a normal
  // background/process restart, allowing the browser's pending UI preference commit.
  await adb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_HOME']); await delay(6000);
  await cdp.close(); cdp = null; await adb(serial, ['shell', 'am', 'force-stop', packageName]);
  await adb(serial, ['shell', 'am', 'start', '-n', `${packageName}/dev.paseo.pocket.MainActivity`]); await attach();
  report.selectionAtRestartDocument = await cdp.evaluate('localStorage.getItem("pocket.extensions.sidebar.v1")');
  await wait(() => visible(toggle), 'restarted conversation'); await tap(toggle);
  report.selectionAfterRestart = await cdp.evaluate('localStorage.getItem("pocket.extensions.sidebar.v1")');
  await wait(() => visible(workbench), 'persistent sidebar choice');
  await wait(() => visible('[data-testid="workbench-graph-content"]'), 'restarted Workbench data');
  assert.equal(await cdp.evaluate('location.href'), route);
  report.checks.push('A real QA process restart restores the conversation and last selected extension Tab without another WebView or manual plugin reload.');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await delay(300); await screenshot('03-dark-workbench');
  await adb(serial, ['shell', 'wm', 'user-rotation', 'lock', '1']);
  await wait(() => cdp.evaluate('innerWidth > innerHeight'), 'actual landscape rotation');
  await delay(300); await screenshot('04-landscape-workbench');
  await adb(serial, ['shell', 'wm', 'user-rotation', 'lock', '0']);
  await wait(() => cdp.evaluate('innerHeight > innerWidth'), 'portrait restored');
  assert.deepEqual(report.errors, []); report.ok = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  if (cdp) {
    await screenshot('failure').catch(() => {}); report.body = await cdp.evaluate('document.body.innerText.slice(-5000)').catch(() => null);
    report.debug = await cdp.evaluate('({fields:[...document.querySelectorAll("input")].map(n=>({id:n.dataset.testid,value:n.value,type:n.type})),selection:localStorage.getItem("pocket.extensions.sidebar.v1"),route:location.href})').catch(() => null);
    await writeFile(join(output, 'failure-native.json'), JSON.stringify(await uiNodes(serial).catch(() => []), null, 2));
  }
  process.exitCode = 1;
} finally {
  await cdp?.close().catch(() => {});
  await adb(serial, ['shell', 'wm', 'user-rotation', 'lock', '0']).catch(() => {});
  await adb(serial, ['shell', 'am', 'force-stop', packageName]).catch(() => {});
  if (reversed) await adb(serial, ['reverse', '--remove', `tcp:${port}`]).catch(() => {});
  if (host && host.exitCode === null) { host.kill('SIGTERM'); const timer = setTimeout(() => host.kill('SIGKILL'), 10000); report.hostExit = await hostExited; clearTimeout(timer); }
  await writeFile(join(output, 'host.log'), logs); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
