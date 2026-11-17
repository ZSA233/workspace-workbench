import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchExtensions } from '../server/extensions.ts';
import { ExtensionRegistry } from '../server/backend/extensions/registry.ts';
import { communicationsManifest } from '../shared/extensions/project-communications/manifest.ts';
import { serviceConnectionSchema } from '../shared/extensions.ts';
import { communicationsActionSchema } from '../shared/extensions/project-communications/service-contract.ts';
import { serviceAvailable, startService, until } from './helpers/communications-service.mjs';

test('registry accepts independent test contributions and rejects incompatible versions', () => {
  const registry = new ExtensionRegistry(); registry.register(communicationsManifest); registry.register({ ...communicationsManifest, id: 'fixture', contributions: { settings: true, unread: false } });
  assert.equal(registry.list().length, 2); assert.throws(() => registry.register({ ...communicationsManifest, id: 'future', apiVersion: 2 }), /incompatible/); assert.throws(() => registry.register(communicationsManifest), /registration_invalid/);
});

test('TypeScript SDK validates the shared Go API-v1 compatibility fixtures', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/communications-protocol-v1.json', import.meta.url), 'utf8'));
  for (const item of cases) { const parsed = communicationsActionSchema.safeParse(item.input); assert.equal(parsed.success, item.valid, JSON.stringify(item.input)); if (parsed.success) assert.deepEqual(parsed.data, item.output); }
});

test('group directory SDK agrees with Go on defaults, cursors and bounded requests', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/communications-group-directory-v1.json', import.meta.url), 'utf8'));
  for (const item of cases) { const parsed = communicationsActionSchema.safeParse(item.input); assert.equal(parsed.success, item.valid, JSON.stringify(item.input)); if (parsed.success) assert.deepEqual(parsed.data, item.output); }
});

test('connector uses a real Go process; collection outlives disable, unload and reconnect', {
  skip: !serviceAvailable() && 'Set COMMUNICATIONS_TEST_BINARY or COMMUNICATIONS_SERVICE_DIR to test the independent service',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'communications-go-host-'));
  const previous = { home: process.env.PASEO_HOME, registry: process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY, service: process.env.COMMUNICATIONS_HOME };
  process.env.PASEO_HOME = join(root, 'paseo'); process.env.COMMUNICATIONS_HOME = join(root, 'service');
  const config = join(root, 'project.json'), registry = join(root, 'registry.json'), state = join(root, 'state');
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, sourceRoot: root, stateRoot: state, project: { id: 'test' } })); writeFileSync(registry, JSON.stringify({ configs: [config] })); process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY = registry;
  const service = await startService(join(root, 'service')); const executable = join(root, 'dws-fixture'); const messages = join(root, 'messages.json'); writeFileSync(messages, '[]');
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2); const emit = value => console.log(JSON.stringify(value));
if(args[0] === 'version') console.log('dws v1.0.68');
else if(args[0] === 'auth') emit({ success: true, authenticated: true, corp_id: 'corp', user_id: 'user' });
else if(args.includes('+chat-bots')) emit({ bots: [{ openBotId: 'bot' }], complete: true, hasMore: false });
else if(args.includes('+chat-messages')) emit({ messages: JSON.parse(fs.readFileSync(${JSON.stringify(messages)},'utf8')), complete: true, hasMore: false });
else if(args.includes('+listen-im')) { console.error('[event] ready'); setInterval(() => { for(const message of JSON.parse(fs.readFileSync(${JSON.stringify(messages)},'utf8'))) emit(message); }, 50); }
else process.exit(2);
`, { mode: 0o700 });
  let host = new WorkbenchExtensions();
  const direct = async (request: unknown) => (await service.request('/v1/projects/same-project/actions', 'POST', request)).result;
  try {
    assert.equal((await host.state(config, 'project-communications')).enabled, false);
    mkdirSync(join(state, 'extensions'), { recursive: true }); writeFileSync(join(state, 'extensions', 'enabled.json'), JSON.stringify({ version: 1, enabled: {}, unknown: 'retain' }));
    const initial = await host.connection(config, 'project-communications', 'read');
    await host.connection(config, 'project-communications', 'configure', { revision: initial.revision, connection: { endpoint: service.url, projectId: 'same-project' }, token: service.token });
    assert.equal((await host.setEnabled(config, 'project-communications', true)).state, 'ready');
    const before = await direct({ action: 'snapshot' }); before.config.source = { executable, mode: 'custom', clientId: 'fixture-app', profile: '', botId: 'bot' };
    await direct({ action: 'configure', revision: before.revision, config: before.config, appSecret: 'fixture-secret' });
    await until(async () => (await direct({ action: 'snapshot' })).source.authenticated);
    await direct({ action: 'groups.bind', groupId: 'group-one', name: '项目群' });
    await until(async () => (await direct({ action: 'snapshot' })).groups[0]?.stream.state === 'verified');
    await host.setEnabled(config, 'project-communications', false); await host.close();
    writeFileSync(messages, JSON.stringify([{ message_id: 'ordinary-after-unload', conversation_id: 'group-one', create_time: Date.now(), content: '没有艾特的需求，界面关闭后仍继续采集', sender: '开发者' }]));
    await until(async () => (await direct({ action: 'snapshot' })).messageCount === 1);
    assert.equal((await service.request('/health')).apiVersion, 1);
    host = new WorkbenchExtensions(); assert.equal((await host.setEnabled(config, 'project-communications', true)).state, 'ready');
    assert.equal((await host.request(config, 'project-communications', { action: 'snapshot' })).messageCount, 1);
    assert.equal(JSON.parse(readFileSync(join(state, 'extensions', 'enabled.json'), 'utf8')).unknown, 'retain');
    assert.equal(serviceConnectionSchema.safeParse({ endpoint: 'http://example.com', projectId: 'x' }).success, false);
    await assert.rejects(host.connection(config, 'project-communications', 'configure', { revision: 1, connection: { endpoint: service.url, projectId: 'changed' } }), /revision_conflict/);
  } finally {
    await host.close(); await service.close();
    for (const [key, value] of Object.entries({ PASEO_HOME: previous.home, WORKSPACE_WORKBENCH_PROJECT_REGISTRY: previous.registry, COMMUNICATIONS_HOME: previous.service })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
