/** A bounded stress fixture for observation ownership and retained heap. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ObservationScheduler } from '../server/backend/observation-scheduler.ts';
import { ObservationCache } from '../server/backend/cache.ts';
import { loadConfig } from '../server/backend/config.ts';

if (!global.gc) throw new Error('run with --expose-gc');
const root = mkdtempSync(join(tmpdir(), 'workbench-resource-'));
const repo = join(root, 'repo'), state = join(root, 'state');
mkdirSync(repo); mkdirSync(state);
const git = args => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
let scheduler, cache;
try {
  git(['init', '-q']); git(['config', 'user.name', 'Resource test']); git(['config', 'user.email', 'resource@example.invalid']);
  const file = join(repo, 'file'); writeFileSync(file, 'initial'); git(['add', '.']); git(['commit', '-qm', 'initial']);
  const configPath = join(root, 'project.json');
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, project: { id: 'resources' }, sourceRoot: root,
    stateRoot: state, workspaceRoot: join(root, 'workspaces'), discovery: { mode: 'manual' }, repositories: [{ id: 'repo', path: 'repo' }] }));
  scheduler = new ObservationScheduler({ leaseMs: 80, retentionMs: 100, debounceMs: 100, maxWaitMs: 200 });
  cache = new ObservationCache(loadConfig(configPath));
  await scheduler.register('warm', repo);
  await delay(1200);
  global.gc(); const initialHeap = process.memoryUsage().heapUsed;
  for (let i = 0; i < 500; i++) {
    const id = `workspace-${i}`;
    await scheduler.register(id, repo);
    scheduler.versions([id]);
  }
  for (let i = 0; i < 1000; i++) writeFileSync(file, String(i));
  for (let i = 0; i < 1000; i++) await cache.read(`snapshot-${i}`, 'v1', async () => ({ value: 'x'.repeat(1024), observation: { state: 'ready' } }), true, true);
  await delay(2400);
  const observed = scheduler.health(), cached = cache.status();
  assert.equal(observed.workspaceRegistrations, 0);
  assert.equal(observed.repositories, 0);
  assert.equal(observed.watchedDirectories, 0);
  assert.equal(cached.refreshing, 0);
  assert.ok(cached.memory.entries <= cached.memory.maxEntries);
  assert.ok(cached.memory.bytes <= cached.memory.maxBytes);
  global.gc(); const retainedHeapIncrease = process.memoryUsage().heapUsed - initialHeap;
  assert.ok(retainedHeapIncrease <= 20 * 1024 * 1024, `retained heap grew by ${retainedHeapIncrease} bytes`);
  const report = { kind: 'workbench-resource-bounds', workspaceSwitches: 500, fileEvents: 1000,
    snapshotKeys: 1000, retainedHeapIncrease, scheduler: observed, cache: cached, ok: true };
  const output = resolve(import.meta.dirname, '../../.local/verification');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'resource-bounds.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await scheduler?.close();
  cache?.clear();
  await cache?.close();
  rmSync(root, { recursive: true, force: true });
}
