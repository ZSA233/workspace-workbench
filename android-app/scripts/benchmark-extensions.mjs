#!/usr/bin/env node
// Interleaved, same-emulator comparison against the preceding APK. QA packages only.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { adb, connectDevice } from './device-browser.mjs';
import { uiNodes } from './device-ui.mjs';

const { values } = parseArgs({ options: { serial: { type: 'string' }, fixture: { type: 'string' },
  output: { type: 'string' }, trials: { type: 'string', default: '20' } } });
assert(values.serial && values.fixture, 'Pass --serial EMULATOR --fixture isolated-host.log');
const serial = values.serial, trials = Number(values.trials);
assert(Number.isInteger(trials) && trials >= 20 && trials <= 100);
const fixture = (await readFile(values.fixture, 'utf8')).split('\n').flatMap(row => {
  try { const value = JSON.parse(row); return value.kind === 'actual-isolated-paseo-with-protocol-fixture' ? [value] : []; } catch { return []; }
}).at(-1);
assert(fixture?.tls && /\/paseo-pocket-host-[^/]+$/.test(fixture.home) && /^localhost:\d+$/.test(fixture.endpoint));
const output = resolve(values.output || '/tmp/pocket-extensions-performance'); await mkdir(output, { recursive: true });
const apps = { before: 'dev.paseo.pocket.qa.baseline', after: 'dev.paseo.pocket.qa' };
const port = fixture.endpoint.split(':')[1], origin = 'https://appassets.androidplatform.net';
const delay = ms => new Promise(r => setTimeout(r, ms));
const report = { kind: 'same-Android-emulator-interleaved-APK-comparison', serial, trials, versions: {}, rows: [], ok: false,
  method: 'Native readiness diagnostics; public DOM click handlers through stable animation frames; actual conversation scroll container; no simulated timing or replacement backend.' };
let cdp, ownsReverse = false;
async function wait(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`);
}
async function launch(app) {
  await adb(serial, ['shell', 'am', 'start', '-n', `${app}/dev.paseo.pocket.MainActivity`]);
  cdp = await connectDevice(serial, { packageName: app }); await cdp.send('Page.enable');
}
async function ready() {
  await wait(() => cdp.evaluate('!!document.querySelector("[data-testid=message-input-attach-button]") && window.__paseoHostRuntimeStore?.getSnapshot(window.__paseoHostRuntimeStore.getHosts()[0]?.serverId)?.agentDirectoryStatus === "ready"'), 'conversation ready', 45000);
}
async function fill(selector, text) {
  await cdp.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.focus();input.select()})()`);
  await cdp.send('Input.insertText', { text });
  assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), text);
}
async function setup(app) {
  await adb(serial, ['shell', 'pm', 'clear', app]); await launch(app);
  await wait(() => cdp.evaluate('window.__paseoHostRuntimeStore?.isHostRegistryLoaded?.() === true'), 'local page');
  await wait(() => cdp.evaluate('(()=>{const node=[...document.querySelectorAll("[role=button],div")].find(n=>["Direct connection","直接连接"].includes((n.textContent||"").trim()));if(!node)return false;node.click();return true;})()'), 'Direct connection');
  await wait(() => cdp.evaluate('!!document.querySelector("[data-testid=direct-host-input]")'), 'connection form');
  await fill('[data-testid=direct-host-input]', 'localhost'); await fill('[data-testid=direct-port-input]', port);
  if (!(await cdp.evaluate('!!document.querySelector("[data-testid=direct-ssl-toggle-checked]")')))
    await cdp.evaluate('document.querySelector("[data-testid=direct-ssl-toggle]").click()');
  await wait(() => cdp.evaluate('!!document.querySelector("[data-testid=direct-ssl-toggle-checked]")'), 'SSL checked');
  await cdp.evaluate('document.querySelector("[data-testid=direct-host-submit]").click()');
  let permissions = 0;
  const hosts = await wait(async () => {
    const rows = await cdp.evaluate('window.__paseoHostRuntimeStore.getHosts()'); if (rows.length) return rows;
    if (permissions++ < 5) {
      const nodes = await uiNodes(serial);
      if (nodes.some(node => /local network|nearby devices|本地网络|附近设备/i.test(node.text || ''))) {
        const allow = nodes.find(node => /permissioncontroller$/.test(node.package || '') && /permission_allow(?:_foreground_only)?_button$/.test(node['resource-id'] || ''));
        if (allow) { const b = allow.bounds.match(/\d+/g).map(Number); await adb(serial, ['shell', 'input', 'tap', String((b[0] + b[2]) / 2), String((b[1] + b[3]) / 2)]); }
      }
    }
    return null;
  }, 'paired fixture');
  assert.equal(hosts.length, 1); assert(hosts[0].connections.every(row => row.endpoint === fixture.endpoint));
  await cdp.send('Page.navigate', { url: `${origin}/h/${hosts[0].serverId}/agent/${fixture.agents[0]}` }); await ready();
  await adb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_HOME']); await delay(6000);
  await cdp.close(); cdp = null; await adb(serial, ['shell', 'am', 'force-stop', app]);
}
async function interaction(selector, visibleSelector, shouldShow = true) {
  return cdp.evaluate(`(async()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing interaction target');
    const started=performance.now();node.click();let previous=null,stable=0;
    for(let n=0;n<300;n++){await new Promise(requestAnimationFrame);const target=document.querySelector(${JSON.stringify(visibleSelector)}),r=target?.getBoundingClientRect();
      const visible=!!r&&r.width>0&&r.height>0&&r.x<innerWidth&&r.right>0&&r.y<innerHeight&&r.bottom>0;
      if(visible!==${shouldShow}){stable=0;continue;}const signature=r?[r.x,r.y,r.width,r.height].join(','):'hidden';
      stable=signature===previous?stable+1:0;previous=signature;if(stable>=2)return performance.now()-started;}
    throw Error('Interaction did not settle');})()`);
}
async function diagnostics(app) {
  return (await adb(serial, ['shell', 'run-as', app, 'cat', 'files/diagnostics.txt'])).trim().split('\n').map(row => {
    const [at, code, ...fields] = row.split(' '); return { at: Number(at), code,
      ...Object.fromEntries(fields.map(field => { const [key, value] = field.split('='); return [key, Number(value)]; })) };
  });
}
async function sample(label, trial) {
  const app = apps[label], since = (await diagnostics(app)).at(-1)?.at || 0;
  await launch(app); await ready();
  // A freshly launched WebView does not have DOM focus until the first real
  // gesture. Match normal use before timing clicks (Workbench correctly pauses
  // its idle queries while the document is unfocused).
  const point = await cdp.evaluate('({x:innerWidth/2,y:innerHeight/2})');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await cdp.evaluate('document.hasFocus()'), true);
  const events = await wait(async () => {
    const rows = (await diagnostics(app)).filter(row => row.at > since); return rows.some(row => row.code === 'host_ready') ? rows : null;
  }, 'native readiness');
  const readyEvent = events.find(row => row.code === 'host_ready'), pageEvent = events.find(row => row.code === 'page_loaded');
  const row = { label, trial, readyMs: readyEvent.total_ready_ms, pageMs: pageEvent?.duration_ms };
  row.sidebarMs = await interaction('[data-testid=workspace-explorer-toggle]', '[data-testid=explorer-header]');
  await interaction('[data-testid=explorer-tab-changes]', '[data-testid=explorer-tab-changes]');
  row.tabMs = await interaction('[data-testid=explorer-tab-files]', '[data-testid=file-explorer-tree-scroll]');
  await interaction('[data-testid=explorer-close]', '[data-testid=explorer-header]', false);
  row.scroll = await cdp.evaluate(`(async()=>{const nodes=[...document.querySelectorAll('div')].filter(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return r.height>150&&r.width>150&&n.scrollHeight>n.clientHeight+500&&/(auto|scroll)/.test(s.overflowY)});
    const node=nodes.sort((a,b)=>b.clientWidth*b.clientHeight-a.clientWidth*a.clientHeight)[0];if(!node)throw Error('No real conversation scroll container');
    const tasks=[],observer=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(e=>e.duration)));observer.observe({type:'longtask'});
    const started=performance.now(),initial=node.scrollTop;node.scrollTop=0;for(let i=0;i<24;i++){node.scrollTop+=70;await new Promise(requestAnimationFrame);}
    node.scrollTop=initial;await new Promise(requestAnimationFrame);observer.disconnect();return{durationMs:performance.now()-started,longTasks:tasks.length,maxTaskMs:Math.max(0,...tasks)};})()`);
  await cdp.send('Performance.enable');
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  row.heapBytes = metrics.JSHeapUsedSize; row.domNodes = (await cdp.send('Memory.getDOMCounters')).nodes;
  if (label === 'after') {
    await interaction('[data-testid=workspace-explorer-toggle]', '[data-testid=explorer-header]');
    await wait(() => cdp.evaluate('!!document.querySelector("[data-testid=pocket-tab-workspace-workbench-paseo-workbench]")'), 'registered Workbench Tab');
    await cdp.evaluate('(()=>{window.__pocketBenchmarkOpen = performance.now();document.querySelector("[data-testid=pocket-tab-workspace-workbench-paseo-workbench]").click()})()');
    await wait(() => cdp.evaluate('(()=>{const node=document.querySelector("[data-testid=workbench-graph-content]");return !!node?.getBoundingClientRect().height})()'), 'first Workbench data', 45000);
    row.workbenchMs = await cdp.evaluate('performance.now()-window.__pocketBenchmarkOpen');
    await interaction('[data-testid=explorer-tab-files]', '[data-testid=file-explorer-tree-scroll]');
    await interaction('[data-testid=explorer-close]', '[data-testid=explorer-header]', false);
  }
  report.rows.push(row); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(row));
  await cdp.close(); cdp = null; await adb(serial, ['shell', 'am', 'force-stop', app]);
}
const percentile = (rows, key, p) => { const values = rows.map(row => key.split('.').reduce((value, field) => value?.[field], row)).filter(Number.isFinite).sort((a, b) => a - b); return values[Math.ceil(values.length * p) - 1]; };
try {
  const reverse = await adb(serial, ['reverse', '--list']);
  if (!reverse.split('\n').some(row => row.split(/\s+/).includes(`tcp:${port}`))) { await adb(serial, ['reverse', `tcp:${port}`, `tcp:${port}`]); ownsReverse = true; }
  for (const [label, app] of Object.entries(apps)) {
    const info = await adb(serial, ['shell', 'dumpsys', 'package', app]); report.versions[label] = info.match(/versionName=([^\s]+)/)?.[1];
    assert(report.versions[label], `Missing isolated APK ${app}`); await setup(app);
  }
  for (let trial = 0; trial < trials; trial++) for (const label of trial % 2 ? ['after', 'before'] : ['before', 'after']) await sample(label, trial + 1);
  report.summary = Object.fromEntries(Object.keys(apps).map(label => [label, Object.fromEntries(['readyMs', 'pageMs', 'sidebarMs', 'tabMs', 'scroll.durationMs', 'scroll.maxTaskMs', 'heapBytes', 'domNodes', ...(label === 'after' ? ['workbenchMs'] : [])].map(key => [key,
    { median: percentile(report.rows.filter(row => row.label === label), key, .5), p95: percentile(report.rows.filter(row => row.label === label), key, .95) }]))]));
  report.regressions = ['readyMs', 'pageMs', 'sidebarMs', 'tabMs', 'scroll.durationMs'].filter(key => {
    const before = report.summary.before[key].p95, after = report.summary.after[key].p95; return after - before > 20 && after > before * 1.1;
  });
  report.ok = report.regressions.length === 0;
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report.failure = error.stack;
  if (cdp) report.debug = await cdp.evaluate('({body:document.body.innerText.slice(-2500),fields:[...document.querySelectorAll("input")].map(n=>({id:n.dataset.testid,value:n.value})),ssl:!!document.querySelector("[data-testid=direct-ssl-toggle-checked]")})').catch(() => null);
  process.exitCode = 1;
}
finally {
  await cdp?.close().catch(() => {});
  for (const app of Object.values(apps)) await adb(serial, ['shell', 'am', 'force-stop', app]).catch(() => {});
  if (ownsReverse) await adb(serial, ['reverse', '--remove', `tcp:${port}`]).catch(() => {});
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ ok: report.ok, summary: report.summary, failure: report.failure }, null, 2));
