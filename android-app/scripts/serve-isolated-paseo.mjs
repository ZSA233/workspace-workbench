#!/usr/bin/env node
// Actual host integration, isolated home + fake Codex protocol. Never touches the normal daemon.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, chmod, cp, symlink } from 'node:fs/promises';
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
const withWorkbench = process.env.POCKET_TEST_WORKBENCH === '1';
let project, projectConfig, registry, examplePlugin;
if (withWorkbench) {
  project = join(root, 'project'); await mkdir(project);
  projectConfig = join(project, 'project.json'); registry = join(root, 'projects.json');
  for (const name of ['one', 'two']) {
    const repository = join(project, name); await mkdir(repository);
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'config', 'user.name', 'Pocket verification']);
    execFileSync('git', ['-C', repository, 'config', 'user.email', 'verification@example.invalid']);
    await writeFile(join(repository, 'README.md'), '# Pocket extension fixture\n\nOriginal content.\n');
    execFileSync('git', ['-C', repository, 'add', '.']);
    execFileSync('git', ['-C', repository, 'commit', '-qm', 'Initial fixture']);
  }
  await writeFile(projectConfig, JSON.stringify({ schemaVersion: 1, project: { id: 'pocket-extensions' }, sourceRoot: project,
    stateRoot: join(project, 'state'), workspaceRoot: join(project, 'workspaces'), socketPath: join(project, 's.sock'),
    discovery: { mode: 'manual' }, repositories: ['one', 'two'].map(id => ({ id, path: id })), management: { enabled: true },
    limits: { cacheTtlSeconds: 0.5 } }));
  await writeFile(registry, JSON.stringify({ configs: [projectConfig] }));
  if (process.env.POCKET_TEST_EXTENSION_HELPER === '1') {
    examplePlugin = join(root, 'example-plugin');
    await cp(resolve('paseo-plugin/scripts/fixtures/pocket-example'), examplePlugin, { recursive: true });
    await mkdir(join(examplePlugin, 'client'), { recursive: true });
    await cp(resolve('paseo-plugin/client/pocket-sdk/index.ts'), join(examplePlugin, 'client/pocket-sdk.ts'));
    await symlink(resolve('paseo-plugin/node_modules'), join(examplePlugin, 'node_modules'));
    await writeFile(join(examplePlugin, 'package.json'), JSON.stringify({ name: 'pocket-example', version: '1.0.0', type: 'module' }));
    await writeFile(join(examplePlugin, 'paseo-plugin.json'), JSON.stringify({ id: 'pocket-example', requirements: { paseo: '>=0.12.0' } }));
  }
}
const probe = netServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise(r => probe.close(r));
if (projectConfig) {
  const config = JSON.parse(await readFile(projectConfig, 'utf8'));
  config.agent = { provider: 'paseo', bridge: { script: resolve('paseo-plugin/mcp.mjs'), endpoint: `127.0.0.1:${port}` } };
  config.review = { mode: 'manual', reviewerTarget: 'independent', autoFix: false };
  await writeFile(projectConfig, JSON.stringify(config));
}
const reportText = 'Paseo Pocket isolated scrolling fixture\n\n' + Array.from({length: 250}, (_, i) =>
  `### Fixture paragraph ${i + 1}\n\nThis is repeatable test content for scrolling and page lifecycle checks. No commands or tasks are executed.\n\n`).join('');
const fixture = (await readFile(new URL('../../paseo-plugin/scripts/fixtures/recovery-codex.mjs', import.meta.url), 'utf8'))
  .replace('text: "RECOVERY_FIXTURE_COMPLETED"', `text: ${JSON.stringify(reportText)}`);
const script = join(root, 'codex-fixture.mjs'); await writeFile(script, fixture);
const relay = process.env.POCKET_TEST_RELAY_CONFIG
  ? JSON.parse(await readFile(process.env.POCKET_TEST_RELAY_CONFIG, 'utf8')).daemon.relay
  : { enabled: false };
await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, pluginsEnabled: withWorkbench,
  daemon: { listen: `127.0.0.1:${port}`, relay, cors: { allowedOrigins: ['https://appassets.androidplatform.net'] }, mcp: { enabled: false, injectIntoAgents: false } },
  features: { webUi: { enabled: withWorkbench } },
  ...(withWorkbench ? { plugins: { 'workspace-workbench-paseo': {
    source: 'directory', path: resolve('paseo-plugin'), enabled: true,
  }, ...(examplePlugin ? { 'pocket-example': { source: 'directory', path: examplePlugin, enabled: true } } : {}) } } : {}),
  agents: { providers: { codex: { command: [process.execPath, script], env: { WORKBENCH_RECOVERY_FIXTURE_ROOT: join(root, 'codex') } } } }
}));
const daemon = spawn(process.env.PASEO_CLI || 'paseo', ['daemon', 'run', '--home', home], {
  env: { ...process.env, PASEO_HOME: home, PASEO_DICTATION_ENABLED: 'false', PASEO_VOICE_MODE_ENABLED: 'false',
    ...(registry ? { WORKSPACE_WORKBENCH_PROJECT_REGISTRY: registry, WORKSPACE_WORKBENCH_PLUGIN_ROOT: resolve('paseo-plugin') } : {}) },
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
  client.close?.(); client.disconnect?.(); proxy?.close();
  // Stop this verified, isolated home through its supervisor, including owned plugin workers.
  try { execFileSync(process.env.PASEO_CLI || 'paseo', ['daemon', 'stop', '--home', home, '--timeout', '5', '--json'],
    { env: { ...process.env, PASEO_HOME: home }, timeout: 10000, stdio: 'pipe' }); }
  catch { if (daemon.exitCode === null) daemon.kill('SIGTERM'); }
  const timer = setTimeout(() => process.exit(process.exitCode || 0), 500); timer.unref();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  const deadline = Date.now() + 90000;
  while (true) {
    if (daemon.exitCode !== null) throw new Error('Isolated daemon exited');
    try { await client.connect(); break; } catch { if (Date.now() > deadline) throw new Error('Isolated daemon did not start'); await new Promise(r => setTimeout(r, 250)); }
  }
  const agents = [];
  for (let i = 0; i < 2; i++) agents.push(await client.createAgent({ config: { provider: 'codex', model: 'recovery-fixture', cwd: withWorkbench ? join(project, i === 0 ? 'one' : 'two') : repo, modeId: 'auto' },
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
    endpoint: `localhost:${proxyPort}`, url: `http://127.0.0.1:${port}`, tls: true,
    agents: agents.map(a => a.id ?? a.agentId ?? a.agent?.id), home: root, ...(withWorkbench ? { project, projectConfig } : {}) })));
} catch (error) { process.exitCode = 1; await stop(); console.error(`${error.message}; logs: ${join(root, 'daemon.log')}`); }
