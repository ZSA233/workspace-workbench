#!/usr/bin/env node
// Actual host integration, isolated home + fake Codex protocol. Never touches the normal daemon.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as netServer, connect } from 'node:net';
import { createServer } from 'node:https';
const require = createRequire(new URL('../../paseo-plugin/package.json', import.meta.url));
const { DaemonClient } = await import(require.resolve('@getpaseo/client/internal/daemon-client'));
const WebSocket = require('ws');
const root = await mkdtemp(join(tmpdir(), 'paseo-pocket-host-'));
const proxyPort = Number(process.env.POCKET_TEST_PROXY_PORT || 19444);
if (!Number.isInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535) throw new Error('Invalid fixture proxy port');
await chmod(root, 0o700);
const home = join(root, 'home'); const repo = join(root, 'repo');
await mkdir(home); await mkdir(repo);
execFileSync('git', ['init', '-q', repo]);
const probe = netServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise(r => probe.close(r));
const reportText = 'Paseo Pocket isolated scrolling fixture\n\n' + Array.from({length: 250}, (_, i) =>
  `### Fixture paragraph ${i + 1}\n\nThis is repeatable test content for scrolling and page lifecycle checks. No commands or tasks are executed.\n\n`).join('');
const fixture = (await readFile(new URL('../../paseo-plugin/scripts/fixtures/recovery-codex.mjs', import.meta.url), 'utf8'))
  .replace('text: "RECOVERY_FIXTURE_COMPLETED"', `text: ${JSON.stringify(reportText)}`);
const script = join(root, 'codex-fixture.mjs'); await writeFile(script, fixture);
const relay = process.env.POCKET_TEST_RELAY_CONFIG
  ? JSON.parse(await readFile(process.env.POCKET_TEST_RELAY_CONFIG, 'utf8')).daemon.relay
  : { enabled: false };
await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, pluginsEnabled: false,
  daemon: { listen: `127.0.0.1:${port}`, relay, cors: { allowedOrigins: ['https://appassets.androidplatform.net'] }, mcp: { enabled: false, injectIntoAgents: false } },
  features: { webUi: { enabled: false } },
  agents: { providers: { codex: { command: [process.execPath, script], env: { WORKBENCH_RECOVERY_FIXTURE_ROOT: join(root, 'codex') } } } }
}));
const daemon = spawn(process.env.PASEO_CLI || 'paseo', ['daemon', 'run', '--home', home], {
  env: { ...process.env, PASEO_HOME: home, PASEO_DICTATION_ENABLED: 'false', PASEO_VOICE_MODE_ENABLED: 'false' },
  stdio: ['ignore','pipe','pipe'],
});
let logs = '';
for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-100000); });
const client = new DaemonClient({ url: `ws://127.0.0.1:${port}/ws`, clientId: 'pocket-device-fixture', clientType: 'mcp',
  reconnect: { enabled: false }, webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }) });
let stopping = false; let proxy;
async function stop() {
  if (stopping) return; stopping = true;
  await writeFile(join(root, 'daemon.log'), logs, { mode: 0o600 });
  client.close?.(); client.disconnect?.(); proxy?.close(); daemon.kill('SIGTERM');
  const timer = setTimeout(() => process.exit(0), 4000); timer.unref();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  const deadline = Date.now() + 30000;
  while (true) {
    if (daemon.exitCode !== null) throw new Error('Isolated daemon exited');
    try { await client.connect(); break; } catch { if (Date.now() > deadline) throw new Error('Isolated daemon did not start'); await new Promise(r => setTimeout(r, 250)); }
  }
  const agents = [];
  for (let i = 0; i < 2; i++) agents.push(await client.createAgent({ config: { provider: 'codex', model: 'recovery-fixture', cwd: repo, modeId: 'auto' },
    initialPrompt: `MANUAL_CONTINUE. Isolated Pocket UI fixture ${i + 1}.` }));
  if (relay.enabled) {
    const pair = execFileSync(process.env.PASEO_CLI || 'paseo', ['daemon', 'pair', '--home', home, '--json'],
      { env: { ...process.env, PASEO_HOME: home }, timeout: 30000 });
    await writeFile(join(root, 'pairing.json'), pair, { mode: 0o600 });
  }
  const tlsRoot = resolve('android-app/.device-fixtures');
  proxy = createServer({ key: await readFile(join(tlsRoot, 'localhost-key.pem')), cert: await readFile(join(tlsRoot, 'localhost-cert.pem')) }, (_, response) => {
    response.writeHead(404); response.end();
  });
  proxy.on('upgrade', (request, socket, head) => {
    const upstream = connect(port, '127.0.0.1', () => {
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(request.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  proxy.listen(proxyPort, '127.0.0.1', () => console.log(JSON.stringify({ kind: 'actual-isolated-paseo-with-protocol-fixture',
    endpoint: `localhost:${proxyPort}`, tls: true, agents: agents.map(a => a.id ?? a.agentId ?? a.agent?.id), home: root })));
} catch (error) { await stop(); console.error(error.message); process.exitCode = 1; }
