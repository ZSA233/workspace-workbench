#!/usr/bin/env node
// Full Pocket QA app -> Android PhotoPicker -> IndexedDB -> real daemon -> fake Codex.
// Never installs an APK, uses the normal Pocket package, or calls a real model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { adb, connectDevice } from './device-browser.mjs';
import { uiNodes } from './device-ui.mjs';

const { values } = parseArgs({ options: {
  serial: { type: 'string' }, output: { type: 'string' }, port: { type: 'string' },
  images: { type: 'string', default: '1' }, 'chooser-delay-ms': { type: 'string', default: '0' },
  'cancel-first': { type: 'boolean', default: false }, 'keep-qa-state': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h' }, 'self-test': { type: 'boolean' },
} });
const packageName = 'dev.paseo.pocket.qa';
const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'https://appassets.androidplatform.net';
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pickerPackages = new Set(['com.google.android.photopicker', 'com.android.providers.media',
  'com.google.android.providers.media.module', 'com.android.documentsui', 'com.google.android.documentsui']);
function center(bounds) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(bounds ?? '');
  assert(match, `Invalid native bounds: ${bounds}`);
  const [left, top, right, bottom] = match.slice(1).map(Number);
  assert(right > left && bottom > top, 'Native target has no area');
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}
function photoNode(nodes) {
  return nodes.find(node => pickerPackages.has(node.package) &&
    /^Photo taken\b|^照片拍摄于|^拍摄于|^写真の撮影日時/i.test(node['content-desc'] ?? ''));
}
function doneNode(nodes) {
  return nodes.find(node => pickerPackages.has(node.package) && node.enabled !== 'false' &&
    /^(Done|Add(?:\s*\(\d+\))?|完成|添加(?:\s*\(\d+\))?)$/i.test(node.text ?? ''));
}
async function imageBytes(turn) {
  const result = [];
  for (const item of turn) {
    if (!/image/i.test(item.type ?? '')) continue;
    if (item.type === 'localImage') {
      const file = await realpath(item.path), temporary = await realpath(tmpdir());
      assert.equal(dirname(dirname(file)), temporary, 'Codex image is outside the temporary attachment store');
      assert(basename(dirname(file)).startsWith('paseo-attachments-'), 'Codex image is outside a Paseo attachment directory');
      result.push(await readFile(file));
      continue;
    }
    const urls = [item.url, item.imageUrl, item.image_url, item.data].flatMap(value =>
      typeof value === 'string' ? [value] : value && typeof value.url === 'string' ? [value.url] : []);
    result.push(...urls.filter(url => /^data:image\/[^;,]+;base64,/.test(url)).map(url =>
      Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')));
  }
  return result;
}
if (values.help) {
  console.log(`Usage: node android-app/scripts/verify-device-images.mjs --serial DEVICE [--output /tmp/pocket-images]

Uses only the already-installed debuggable ${packageName}; resets that QA package by default.
Starts its own isolated localhost TLS daemon and fake Codex, reverses a free port, and uses the
actual app's Direct connection UI and Android PhotoPicker. No APK installation or release.

  --port PORT             Isolated TLS proxy port (default: choose a free port)
  --images 1|2            Select one image, or verify native multi-selection
  --cancel-first          Cancel the first native chooser, then select successfully
  --chooser-delay-ms N    Keep the actual chooser open before selecting (e.g. 32000)
  --keep-qa-state         Preserve QA state; refuses any previously configured other host
  --self-test             Check selection and hash helpers without accessing any device

Use a dedicated QA device/emulator. The test creates only pocket-qa-<run>-*.png media and removes
those exact paths afterward. It validates the submitted fake-Codex image bytes against their hashes.`);
  process.exit(0);
}
if (values['self-test']) {
  const photo = { package: 'com.google.android.photopicker', 'content-desc': 'Photo taken on Oct 23, 2026 4:04 AM', bounds: '[0,622][159,781]' };
  assert.equal(photoNode([{ ...photo, package: 'unrelated.app' }, photo]), photo);
  assert.equal(photoNode([{ ...photo, 'content-desc': 'Selected Photo taken on Oct 23, 2026' }]), undefined);
  assert.deepEqual(center(photo.bounds), { x: 80, y: 702 });
  assert.equal(doneNode([{ package: photo.package, text: 'Done', clickable: 'false', bounds: '[356,831][405,861]' }]).text, 'Done');
  assert.throws(() => center('[0,0][0,0]'));
  assert.equal((await imageBytes([{ type: 'image', url: 'data:image/png;base64,cHJvb2Y=' }]))[0].toString(), 'proof');
  assert.equal((await imageBytes([{ type: 'text', text: 'test marker' }, { type: 'image', url: 'data:image/png;base64,cHJvb2Y=' }]))[0].toString(), 'proof');
  assert.deepEqual(await imageBytes([{ type: 'text', text: 'data:image/png;base64,cHJvb2Y=' }]), []);
  console.log('Device image QA helper checks passed; no device accessed.');
  process.exit(0);
}
assert(values.serial, 'Pass --serial for a dedicated QA device; use --help for details.');
const serial = values.serial, count = Number(values.images), chooserDelayMs = Number(values['chooser-delay-ms']);
assert([1, 2].includes(count), '--images must be 1 or 2');
assert(Number.isInteger(chooserDelayMs) && chooserDelayMs >= 0 && chooserDelayMs <= 60000, '--chooser-delay-ms must be 0..60000');
const runId = randomUUID(), output = resolve(values.output ?? `/tmp/pocket-device-images-${runId}`);
await mkdir(output, { recursive: true });
const report = { kind: 'actual-Android-Pocket-native-image-pipeline', packageName, serial, runId,
  output, checks: [], scenarios: { images: count, cancelFirst: values['cancel-first'], chooserDelayMs },
  screenshots: [], nativeTrees: [], sourceImages: [], events: [], pageErrors: [], ok: false };
let host, hostExited, fixture, cdp, reverseOwned = false, port, logs = '', phase = 'preflight';
const mediaPaths = [];
async function save() { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
async function wait(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    if (host && host.exitCode !== null) throw Error('Owned isolated host exited during verification');
    await delay(250);
  }
  throw Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function screenshot(name, native = false) {
  const path = join(output, `${name}.png`);
  const bytes = native ? await adb(serial, ['exec-out', 'screencap', '-p'], { encoding: 'buffer' })
    : Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  await writeFile(path, bytes); report.screenshots.push(path);
}
async function nativeTree(name) {
  const nodes = await readUiNodes(), path = join(output, `${name}.json`);
  await writeFile(path, JSON.stringify(nodes, null, 2)); report.nativeTrees.push(path); return nodes;
}
async function readUiNodes() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await uiNodes(serial); }
    catch (error) { if (attempt === 2) throw error; await delay(250); }
  }
}
async function nativeTap(node) {
  assert(pickerPackages.has(node.package), 'Refusing to tap outside a recognized system picker');
  const point = center(node.bounds);
  await adb(serial, ['shell', 'input', 'tap', String(point.x), String(point.y)]); await delay(300);
}
async function domTarget(selector, texts = []) {
  return cdp.evaluate(`(() => {const texts=${JSON.stringify(texts)};const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];
    for(const node of nodes){const r=node.getBoundingClientRect(),s=getComputedStyle(node);if(r.width<=0||r.height<=0||s.display==='none'||s.visibility==='hidden'||s.opacity==='0')continue;
      const text=(node.textContent||'').trim();if(texts.length&&!texts.includes(text)&&!texts.includes(node.getAttribute('aria-label')))continue;
      if(node.disabled||node.getAttribute('aria-disabled')==='true')continue;
      if(r.top<0||r.left<0||r.bottom>innerHeight||r.right>innerWidth){node.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});return null;}
      const point={x:r.x+r.width/2,y:r.y+r.height/2},hit=document.elementFromPoint(point.x,point.y);
      if(!hit||!(node.contains(hit)||hit.contains(node)))continue;return point;}return null;})()`);
}
async function webTap(selector, texts = []) {
  const point = await wait(() => domTarget(selector, texts), `visible web target ${texts.join('/') || selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function fill(selector, text) {
  await webTap(selector);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await cdp.send('Input.insertText', { text });
}
async function approveQaNetworkPrompt() {
  const nodes = await readUiNodes(), text = nodes.map(node => node.text ?? '').join(' ');
  if (!/local network|nearby devices|附近设备|本地网络/i.test(text)) return;
  const allow = nodes.find(node => /permissioncontroller$/.test(node.package ?? '') &&
    /permission_allow(?:_foreground_only)?_button$/.test(node['resource-id'] ?? '') && /^(Allow|允许)$/i.test(node.text ?? ''));
  if (allow) {
    const point = center(allow.bounds);
    await adb(serial, ['shell', 'input', 'tap', String(point.x), String(point.y)]);
    report.checks.push('Accepted the QA app local-network permission through its native dialog');
  }
}
async function openPicker() {
  await webTap('[data-testid="message-input-attach-button"]');
  await webTap('[data-testid^="message-input-attachment-menu-item-"], [role="menuitem"], div', ['Add image', '添加图片', '添加图像']);
  await wait(async () => photoNode(await readUiNodes()), 'actual native PhotoPicker photo grid', 20000);
}
async function idbImages() {
  return cdp.evaluate(`(async()=>{if(!(await indexedDB.databases()).some(d=>d.name==='paseo-attachment-bytes'))return[];
    return await new Promise((resolve,reject)=>{const request=indexedDB.open('paseo-attachment-bytes');request.onerror=()=>reject(request.error);request.onsuccess=()=>{
      const db=request.result,read=db.transaction('attachments','readonly').objectStore('attachments').getAll();read.onerror=()=>reject(read.error);
      read.onsuccess=async()=>{try{const rows=await Promise.all(read.result.map(async row=>{const bytes=new Uint8Array(await row.blob.arrayBuffer());let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return{id:row.id,fileName:row.fileName,mimeType:row.blob.type,size:row.blob.size,base64:btoa(text)}}));db.close();resolve(rows)}catch(error){db.close();reject(error)}}}})})()`);
}
try {
  // This hard guard runs before launch, clearing state, or any native tap.
  await adb(serial, ['shell', 'run-as', packageName, 'id']);
  report.androidSdk = (await adb(serial, ['shell', 'getprop', 'ro.build.version.sdk'])).trim();
  const packageInfo = await adb(serial, ['shell', 'dumpsys', 'package', packageName]);
  report.apkVersion = /versionName=([^\s]+)/.exec(packageInfo)?.[1] ?? null;
  report.apkVersionCode = /versionCode=(\d+)/.exec(packageInfo)?.[1] ?? null;
  if (!values['keep-qa-state']) await adb(serial, ['shell', 'pm', 'clear', packageName]);
  phase = 'isolated-host';
  if (values.port) port = Number(values.port);
  else { const probe = createServer(); await new Promise(resolveListen => probe.listen(0, '127.0.0.1', resolveListen)); port = probe.address().port; await new Promise(resolveClose => probe.close(resolveClose)); }
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid proxy port');
  assert(port !== 6767 && port !== 19544, 'Do not reuse the normal daemon or the separate manual QA host');
  const endpoint = `localhost:${port}`;
  host = spawn(process.execPath, [join(root, 'android-app/scripts/serve-isolated-paseo.mjs')], {
    cwd: root, env: { ...process.env, POCKET_TEST_PROXY_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  hostExited = new Promise(resolveExit => host.once('exit', (code, signal) => resolveExit({ code, signal })));
  host.stderr.on('data', chunk => { logs = (logs + chunk).slice(-100000); });
  const lines = createInterface({ input: host.stdout });
  lines.on('line', line => { logs = (logs + line + '\n').slice(-100000); try { const data = JSON.parse(line); if (data.kind === 'actual-isolated-paseo-with-protocol-fixture') fixture = data; } catch {} });
  await wait(() => fixture, 'owned isolated daemon ready', 45000);
  assert.equal(fixture.endpoint, endpoint); assert(fixture.tls && fixture.agents?.length);
  report.fixture = { endpoint, home: fixture.home, agents: fixture.agents };
  const reverseList = await adb(serial, ['reverse', '--list']);
  assert(!reverseList.split('\n').some(line => line.split(/\s+/).includes(`tcp:${port}`)), 'Selected adb reverse port already belongs to another test');
  await adb(serial, ['reverse', `tcp:${port}`, `tcp:${port}`]); reverseOwned = true;
  phase = 'connect-full-app';
  await adb(serial, ['shell', 'am', 'start', '-n', `${packageName}/dev.paseo.pocket.MainActivity`]);
  cdp = await connectDevice(serial, { packageName });
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await wait(() => cdp.evaluate('window.__paseoHostRuntimeStore?.isHostRegistryLoaded?.() === true'), 'QA full page and registry ready');
  const existing = await cdp.evaluate('window.__paseoHostRuntimeStore.getHosts()');
  assert(existing.every(host => host.connections.every(connection => connection.type === 'directTcp' && connection.endpoint === endpoint)), 'QA app contains another host; rerun without --keep-qa-state');
  if (!existing.length) {
    await webTap('[role="button"], div', ['Direct connection', '直接连接']);
    await fill('[data-testid="direct-host-input"]', 'localhost');
    await fill('[data-testid="direct-port-input"]', String(port));
    if (!(await cdp.evaluate('!!document.querySelector("[data-testid=direct-ssl-toggle-checked]")'))) await webTap('[data-testid="direct-ssl-toggle"]');
    await webTap('[data-testid="direct-host-submit"]'); await approveQaNetworkPrompt();
  }
  const hosts = await wait(async () => { const rows = await cdp.evaluate('window.__paseoHostRuntimeStore.getHosts()'); return rows.length ? rows : null; }, 'full app direct TLS connection');
  assert.equal(hosts.length, 1); assert(hosts[0].connections.every(connection => connection.type === 'directTcp' && connection.endpoint === endpoint));
  const agentId = fixture.agents[0];
  await cdp.send('Page.navigate', { url: `${origin}/h/${encodeURIComponent(hosts[0].serverId)}/agent/${encodeURIComponent(agentId)}` });
  await wait(() => cdp.evaluate('!!document.querySelector("[data-testid=message-input-attach-button]")'), 'actual fixture agent composer');
  report.page = await cdp.evaluate('({url:location.href,origin:location.origin,secure:isSecureContext,ua:navigator.userAgent,adapter:!!window.__pocketImageInput})');
  assert.equal(report.page.origin, origin); assert.equal(report.page.secure, true);
  report.checks.push('Connected the actual full QA app to only the owned isolated TLS host');
  // Observe existing production handlers. Do not replace the picker, dispatch change, or set files.
  await cdp.evaluate(`(()=>{window.__pocketImageQaEvents=[];window.__pocketImageQaErrors=[];
    window.addEventListener('change',event=>{const node=event.target;if(node?.type==='file')window.__pocketImageQaEvents.push({kind:'change',trusted:event.isTrusted,at:performance.now(),connected:node.isConnected,accept:node.accept,composerCount:document.querySelectorAll('[data-testid="message-input-root"]').length,files:[...node.files].map(file=>({name:file.name,type:file.type,size:file.size}))})},true);
    for(const kind of ['visibilitychange','focus','blur'])window.addEventListener(kind,event=>window.__pocketImageQaEvents.push({kind,trusted:event.isTrusted,at:performance.now(),visibility:document.visibilityState}));
    window.addEventListener('error',event=>window.__pocketImageQaErrors.push(String(event.message)));
    window.addEventListener('unhandledrejection',event=>window.__pocketImageQaErrors.push(String(event.reason?.message??event.reason)));return true})()`);
  phase = 'seed-owned-images';
  for (let index = 0; index < count; index++) {
    const base64 = await cdp.evaluate(`(()=>{const canvas=document.createElement('canvas');canvas.width=160;canvas.height=100;const context=canvas.getContext('2d');context.fillStyle=${JSON.stringify(index ? '#c87c38' : '#319971')};context.fillRect(0,0,160,100);context.fillStyle='#ffffff';context.font='bold 24px sans-serif';context.fillText('Pocket QA ${index + 1}',8,56);return canvas.toDataURL('image/png').split(',')[1]})()`);
    const bytes = Buffer.from(base64, 'base64'), name = `pocket-qa-${runId}-${index + 1}.png`, path = join(output, name), devicePath = `/sdcard/Pictures/${name}`;
    await writeFile(path, bytes); await adb(serial, ['push', path, devicePath]); mediaPaths.push(devicePath);
    await adb(serial, ['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${devicePath}`]);
    report.sourceImages.push({ path, devicePath, mimeType: 'image/png', bytes: bytes.length, sha256: sha256(bytes) });
  }
  await delay(1500);
  phase = 'native-picker';
  if (values['cancel-first']) {
    await openPicker(); await screenshot('01-native-cancel-first', true);
    await adb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    await wait(() => cdp.evaluate('document.visibilityState === "visible" && document.querySelectorAll("input[type=file]").length === 0'), 'cancel returned to the actual composer');
    assert.equal(await cdp.evaluate('document.querySelectorAll("[data-testid=composer-image-attachment-pill]").length'), 0);
    report.checks.push('Native cancellation returned without a pill; the next selection remained available');
  }
  await openPicker(); await nativeTree('02-photo-picker-open'); await screenshot('02-photo-picker-open', true);
  if (chooserDelayMs) { console.log(JSON.stringify({ phase: 'native-picker-delay', milliseconds: chooserDelayMs })); await delay(chooserDelayMs); }
  for (let index = 0; index < count; index++) {
    const photo = await wait(async () => photoNode(await readUiNodes()), 'newest unselected PhotoPicker photo', 15000);
    await nativeTap(photo);
  }
  const selected = await nativeTree('03-photo-picker-selected');
  assert(selected.filter(node => pickerPackages.has(node.package) && /^Selected Photo taken\b|^已选/i.test(node['content-desc'] ?? '')).length >= count, 'PhotoPicker did not confirm the requested selection');
  await screenshot('03-photo-picker-selected', true);
  const done = await wait(async () => doneNode(await readUiNodes()), 'PhotoPicker Done/Add control');
  await nativeTap(done);
  phase = 'attachment-persistence';
  await wait(() => cdp.evaluate(`document.querySelectorAll('[data-testid="composer-image-attachment-pill"]').length===${count}`), 'native selection produced actual attachment pills');
  const persisted = await idbImages();
  report.persistedImages = persisted.map(({ base64, ...row }) => ({ ...row, sha256: sha256(Buffer.from(base64, 'base64')) }));
  assert.deepEqual(report.persistedImages.map(row => row.sha256).sort(), report.sourceImages.map(row => row.sha256).sort(), 'Native selected image bytes differ from the generated source images');
  assert(report.persistedImages.every(row => row.mimeType === 'image/png'));
  await delay(500); await screenshot('04-real-composer-pills');
  report.checks.push('Real native PhotoPicker confirmation produced expected pills and byte-identical IndexedDB PNGs');
  phase = 'send-through-actual-composer';
  const marker = `MANUAL_CONTINUE Pocket native image QA ${runId}`;
  await fill('[data-testid="message-input-root"] [contenteditable="true"], [data-testid="message-input-root"] textarea', marker);
  await webTap('[data-testid="message-input-root"] [role="button"]', ['Send message', '发送消息', '发送訊息']);
  const delivered = await wait(async () => {
    for (const file of await readdir(join(fixture.home, 'codex'))) {
      if (!file.endsWith('.json')) continue;
      let thread; try { thread = JSON.parse(await readFile(join(fixture.home, 'codex', file), 'utf8')); } catch { continue; }
      const turn = thread.inputs?.find(input => input.some(item => item.type === 'text' && item.text?.includes(marker)));
      if (turn) return { threadId: thread.id, images: await imageBytes(turn) };
    }
    return null;
  }, 'fake Codex received the submitted image message');
  report.delivery = { threadId: delivered.threadId, imageHashes: delivered.images.map(sha256), imageCount: delivered.images.length };
  assert.deepEqual(report.delivery.imageHashes.sort(), report.sourceImages.map(row => row.sha256).sort(), 'Codex input image hashes differ from the actual selected PNGs');
  await screenshot('05-message-delivered'); report.checks.push('The real send path delivered each original PNG to fake Codex with matching SHA-256');
  report.ok = true;
} catch (error) {
  report.failure = { phase, message: error.message, stack: error.stack };
  if (cdp) await screenshot('failure-webview').catch(() => {});
  await screenshot('failure-native', true).catch(() => {});
  process.exitCode = 1;
} finally {
  if (cdp) {
    await cdp.evaluate('({events:window.__pocketImageQaEvents??[],errors:window.__pocketImageQaErrors??[],pills:document.querySelectorAll("[data-testid=composer-image-attachment-pill]").length,notice:document.querySelector("[data-pocket-image-status]")?.textContent??""})')
      .then(state => { report.events = state.events; report.pageErrors = state.errors; report.finalComposer = { pills: state.pills, notice: state.notice }; }).catch(() => {});
    await cdp.close().catch(() => {});
  }
  for (const path of mediaPaths) await adb(serial, ['shell', 'rm', '-f', path]).catch(() => {});
  if (reverseOwned) await adb(serial, ['reverse', '--remove', `tcp:${port}`]).catch(() => {});
  if (host) {
    host.kill('SIGTERM');
    const exited = await Promise.race([hostExited, delay(6000).then(() => null)]);
    if (!exited) { host.kill('SIGKILL'); await hostExited; }
    report.hostExit = await hostExited;
  }
  await writeFile(join(output, 'isolated-host.log'), logs); await save();
}
console.log(JSON.stringify({ ok: report.ok, report: join(output, 'report.json'), checks: report.checks, failure: report.failure }, null, 2));
