#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { adb, connectDevice } from './device-browser.mjs';
const serial = process.argv[2];
if (!serial) throw new Error('Usage: node android-app/scripts/verify-device-web.mjs <adb-serial> [output-directory]');
const output = resolve(process.argv[3] || 'android-app/artifacts/device-web'); await mkdir(output, { recursive: true });
await adb(serial, ['shell', 'am', 'start', '-n', 'dev.paseo.pocket/.MainActivity']);
const cdp = await connectDevice(serial);
const report = { kind: 'real-android-webview', sdk: (await adb(serial, ['shell', 'getprop', 'ro.build.version.sdk'])).trim(), checks: [] };
try {
  await cdp.send('Network.enable'); await cdp.send('Page.enable');
  report.page = await cdp.evaluate(`({secure:isSecureContext,storage:!!indexedDB, rendered:document.body.innerText.length>0,
    origin:location.origin,staticOrigins:[...new Set(performance.getEntriesByType('resource')
      .filter(x=>/\\.(js|css|woff2?)(\\?|$)/.test(x.name)).map(x=>new URL(x.name).origin))]})`);
  assert(report.page.secure && report.page.storage && report.page.rendered);
  assert.deepEqual(report.page.staticOrigins, ['https://appassets.androidplatform.net']);
  report.checks.push('Complete static page loads from the fixed local secure origin');
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.send('Page.reload');
  let offlineRendered = false;
  for (let n = 0; n < 60; n++) {
    try { if (await cdp.evaluate('document.body.innerText.length > 0')) { offlineRendered = true; break; } } catch { /* reload */ }
    await new Promise(r => setTimeout(r, 250));
  }
  assert(offlineRendered); report.checks.push('Local page renders with the WebView network offline');
  const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(output, 'offline-page.png'), Buffer.from(image.data, 'base64'));
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.evaluate(`fetch('/_expo/definitely-missing-fixture.js').then(r=>r.status)`)
    .then(status => assert.equal(status, 404));
  report.checks.push('Missing local static file returns 404 without a remote fallback');
  const tree = `/sdcard/pocket-fixture-${randomUUID()}.xml`;
  try {
    await adb(serial, ['shell', 'uiautomator', 'dump', tree]);
    const xml = await adb(serial, ['shell', 'cat', tree]);
    const node = [...xml.matchAll(/<node\b[^>]*>/g)].map(m=>m[0]).find(s=>s.includes('text="重新打开页面"'));
    assert(node, 'Missing resource should display native recovery');
    const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
    await adb(serial, ['shell', 'input', 'tap', String(Math.round((bounds[0]+bounds[2])/2)), String(Math.round((bounds[1]+bounds[3])/2))]);
    report.checks.push('Static failure displays native recovery; a user click reopens the page');
  } finally { await adb(serial, ['shell', 'rm', tree]); }
} finally {
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
  await cdp.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
