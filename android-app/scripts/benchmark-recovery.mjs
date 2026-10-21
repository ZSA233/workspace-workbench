#!/usr/bin/env node
// Destructive lifecycle checks are restricted to our separate QA installation and fixture host.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { adb, connectDevice } from './device-browser.mjs';
const { values } = parseArgs({ options: { serial: { type: 'string' }, output: { type: 'string' },
  label: { type: 'string' }, trials: { type: 'string', default: '8' }, background: { type: 'string', default: '3000' } } });
assert(values.serial && values.output && values.label, 'Use --serial DEVICE --output report.json --label before|after');
const trials = Number(values.trials), backgroundMs = Number(values.background);
assert(Number.isInteger(trials) && trials >= 1 && trials <= 30);
assert(Number.isInteger(backgroundMs) && backgroundMs >= 1000 && backgroundMs <= 120000);
const serial = values.serial, app = 'dev.paseo.pocket.qa';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const launch = () => adb(serial, ['shell', 'am', 'start', '-n', `${app}/dev.paseo.pocket.MainActivity`]);
async function events() {
  // Android <= 10 AtomicFile briefly renames the base file during a commit.
  let text;
  for(let attempt=0;attempt<6;attempt++) {
    try { text=await adb(serial, ['shell', 'run-as', app, 'cat', 'files/diagnostics.txt']);break; }
    catch(error) { if(attempt===5||!String(error.stderr).includes('No such file'))throw error;await sleep(50); }
  }
  return text.trim().split('\n').map(line => {
    const [at, code, ...fields] = line.split(' ');
    return { at: Number(at), code, ...Object.fromEntries(fields.map(f => { const [k,v] = f.split('='); return [k, Number(v)]; })) };
  }).filter(row => Number.isFinite(row.at));
}
async function waitReady(since, kind) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const rows = (await events()).filter(row => row.at > since);
    const start = rows.find(row => row.code === (kind === 'cold' ? 'page_loading' : 'page_resumed'));
    const ready = start && rows.find(row => row.code === 'host_ready' && row.at >= start.at);
    if (ready) {
      const loading = rows.find(row => row.code === 'page_loaded');
      const connecting = rows.find(row => row.code === 'host_connecting');
      const syncing = rows.find(row => row.code === 'host_syncing');
      const between = (a,b) => Number.isFinite(a.elapsed_ms) && Number.isFinite(b.elapsed_ms)
        ? b.elapsed_ms-a.elapsed_ms : b.at-a.at;
      return { kind, totalMs: ready.total_ready_ms ?? ready.ready_ms ?? ready.at - start.at, pageMs: loading?.duration_ms ?? null,
        connectionMs: connecting ? between(connecting,syncing ?? ready) : null,
        syncMs: syncing ? between(syncing,ready) : null,
        backgroundMs: start.background_ms ?? null };
    }
    await sleep(150);
  }
  throw Error('Fixture host did not become ready within 30 seconds');
}
await launch();
const cdp = await connectDevice(serial, { packageName: app });
try {
  for (let n=0;n<150;n++) {
    if (await cdp.evaluate('window.__paseoHostRuntimeStore?.isHostRegistryLoaded?.() === true')) break;
    await sleep(100);
  }
  const safe = await cdp.evaluate(`(()=>{const hosts=window.__paseoHostRuntimeStore?.getHosts();return hosts?.length===1&&hosts.every(h=>h.label==='Pocket isolated fixture'&&h.connections.every(c=>c.type==='directTcp'&&c.endpoint==='localhost:19444'))})()`);
  assert.equal(safe, true, 'Only the isolated localhost fixture may be benchmarked');
} finally { await cdp.close(); }
const report = { label: values.label, kind: 'real-device-isolated-host-protocol-fixture', packageName: app,
  sdk: (await adb(serial, ['shell', 'getprop', 'ro.build.version.sdk'])).trim(), backgroundMs, rows: [] };
function percentile(data, p) { const sorted = data.filter(Number.isFinite).sort((a,b)=>a-b); return sorted.length ? sorted[Math.ceil(p * sorted.length)-1] : null; }
async function save() {
  report.summary = Object.fromEntries(['cold','background'].map(kind => {
    const rows = report.rows.filter(row=>row.kind===kind);
    return [kind, Object.fromEntries(['totalMs','pageMs','connectionMs','syncMs'].map(field => [field,
      { count: rows.filter(r=>Number.isFinite(r[field])).length, median: percentile(rows.map(r=>r[field]), .5), p95: percentile(rows.map(r=>r[field]), .95) }]))];
  }));
  await mkdir(resolve(values.output, '..'), { recursive: true });
  await writeFile(resolve(values.output), JSON.stringify(report, null, 2)+'\n');
}
try {
  for (const kind of ['cold', 'background']) for (let n=0; n<trials; n++) {
    const since = (await events()).at(-1)?.at ?? 0;
    if (kind === 'cold') await adb(serial, ['shell', 'am', 'force-stop', app]);
    else { await adb(serial, ['shell', 'input', 'keyevent', '3']); await sleep(backgroundMs); }
    await launch();
    const row = await waitReady(since, kind); report.rows.push(row); await save();
    console.log(JSON.stringify({ label: values.label, trial: n+1, ...row }));
    await sleep(300);
  }
} finally { await save(); }
