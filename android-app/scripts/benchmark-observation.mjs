#!/usr/bin/env node
// Explicit QA-only foreground sampling comparison; never operates the production app.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { adb, connectDevice } from './device-browser.mjs';
import { tapNode, uiNodes } from './device-ui.mjs';
const { values } = parseArgs({ options: { serial: { type: 'string' }, output: { type: 'string' }, seconds: { type: 'string', default: '30' } } });
assert(values.serial && values.output, 'Use --serial DEVICE --output report.json');
const seconds = Number(values.seconds); assert(Number.isInteger(seconds) && seconds >= 10 && seconds <= 60);
const app = 'dev.paseo.pocket.qa', serial = values.serial;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
await adb(serial, ['shell','am','start','-n',`${app}/dev.paseo.pocket.MainActivity`]);
const cdp = await connectDevice(serial,{packageName:app});
const rows = [];
try {
  for (let n=0;n<150;n++) {
    if (await cdp.evaluate('window.__paseoHostRuntimeStore?.isHostRegistryLoaded?.() === true')) break;
    await sleep(100);
  }
  assert.equal(await cdp.evaluate(`(()=>{const h=window.__paseoHostRuntimeStore?.getHosts();return h?.length===1&&h.every(x=>x.label==='Pocket isolated fixture'&&x.connections.every(c=>c.endpoint==='localhost:19444'))})()`), true);
  await cdp.send('Performance.enable'); await cdp.send('Network.enable');
  let newSockets = 0; cdp.events.on('Network.webSocketCreated',()=>newSockets++);
  const pid = (await adb(serial,['shell','pidof',app])).trim(); assert(/^\d+$/.test(pid));
  const ticksPerSecond = Number((await adb(serial,['shell','getconf','CLK_TCK'])).trim()); assert(ticksPerSecond>0);
  async function counters() {
    const stat = await adb(serial,['shell','run-as',app,'cat',`/proc/${pid}/stat`]);
    const fields = stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
    const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    return { at:performance.now(),nativeTicks:Number(fields[11])+Number(fields[12]),rendererProcessSeconds:metrics.ProcessTime ?? null,
      rendererHeapBytes:metrics.JSHeapUsedSize ?? null,sockets:newSockets };
  }
  const nodes = await uiNodes(serial);
  if (!nodes.some(n=>n['content-desc']==='关闭面板')) await tapNode(serial,n=>n['content-desc']==='Paseo Pocket 工具');
  if ((await uiNodes(serial)).some(n=>n['content-desc']?.startsWith('连接与诊断，')))
    await tapNode(serial,n=>n['content-desc']?.startsWith('连接与诊断，'));
  for (const enabled of [false,true,false]) {
    const expected = enabled ? '查看性能' : '收起性能';
    if ((await uiNodes(serial)).some(n=>n.text===expected)) await tapNode(serial,n=>n.text===expected);
    await sleep(1500);
    const start = await counters(); await sleep(seconds*1000); const end = await counters();
    const elapsed = (end.at-start.at)/1000;
    rows.push({ enabled,seconds:elapsed,nativeCpuOneCorePercent:(end.nativeTicks-start.nativeTicks)/ticksPerSecond/elapsed*100,
      rendererCpuOneCorePercent:start.rendererProcessSeconds===null||end.rendererProcessSeconds===null?null:
        (end.rendererProcessSeconds-start.rendererProcessSeconds)/elapsed*100,
      rendererHeapBefore:start.rendererHeapBytes,rendererHeapAfter:end.rendererHeapBytes,newWebSockets:end.sockets-start.sockets });
    console.log(JSON.stringify(rows.at(-1)));
  }
  await tapNode(serial,n=>n['content-desc']==='关闭面板');
} finally {
  await cdp.close();
  await mkdir(resolve(values.output,'..'),{recursive:true});
  await writeFile(resolve(values.output),JSON.stringify({kind:'real-device-qa-idle-foreground',seconds,
    scope:'Native app process and CDP renderer ProcessTime; not whole browser/GPU or battery consumption',rows},null,2)+'\n');
}
