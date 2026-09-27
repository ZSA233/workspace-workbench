/** Isolated actual-host crash recovery, separate from browser rendering. */
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
import { backendRequest } from '../server/backend-supervisor.ts';
const exec = promisify(execFile), plugin = resolve(import.meta.dirname, '..');
const child = spawn(process.execPath, [join(plugin, 'scripts/verify-live.mjs')], { env: { ...process.env, WORKBENCH_LIVE_UI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise(r => child.once('exit', r));
let logs = '', ui, client;
child.stderr.on('data', b => { logs += b; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  ui = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(Error('isolated host readiness timeout')), 90000);
    createInterface({ input: child.stdout }).on('line', line => {
      logs += line + '\n';
      try { const value = JSON.parse(line); if (value.kind === 'ui-ready') { clearTimeout(timer); resolveReady(value); } } catch {}
    });
    void exited.then(code => { clearTimeout(timer); reject(Error(`host exited: ${code}`)); });
  });
  client = new DaemonClient({ url: `ws://${new URL(ui.url).host}/ws`, clientId: 'isolated-backend-recovery', clientType: 'mcp', reconnect: { enabled: false }, webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }) });
  await client.connect();
  await exec(process.env.PASEO_CLI || 'paseo', ['plugin', 'reload', 'workspace-workbench-paseo', '--host', new URL(ui.url).host, '--json'], { timeout: 60000 });
  const projectConfig = join(ui.project, 'project.json');
  await client.invokePluginRpc('workspace-workbench-paseo', 'workspace.workbench.backend.start', { projectConfig });
  for (let i = 0; i < 3; i++) {
    const prior = (await backendRequest(join(ui.project, 's.sock'), 'observer.health'))?.result;
    assert.equal(prior?.process.configPath, projectConfig);
    assert.ok(prior.process.pid > 0);
    process.kill(prior.process.pid, 'SIGKILL');
    await sleep(100);
    const started = Date.now();
    const response = await client.invokePluginRpc('workspace-workbench-paseo', 'workspace.workbench.query', { projectConfig, method: 'observer.versions', params: { workspaceIds: [] } });
    const status = await client.invokePluginRpc('workspace-workbench-paseo', 'workspace.workbench.backend.status', { projectConfig });
    console.log(JSON.stringify({ round: i, elapsedMs: Date.now() - started, response, status }));
    assert.equal(response.ok, true);
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await client?.close();
  if (ui) writeFileSync(ui.continueFile, 'continue\n');
  const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
  if (code !== 0) { process.exitCode = 1; if (code === 'timeout') child.kill('SIGTERM'); }
  if (process.exitCode) console.error(logs.slice(-4000));
}
