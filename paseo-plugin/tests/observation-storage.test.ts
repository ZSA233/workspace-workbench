import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { open, readFile, stat, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DerivedJsonWriter, writeDerivedJson } from '../server/backend/derived-json.ts';
import { loadConfig } from '../server/backend/config.ts';
import { Service } from '../server/backend/service.ts';

test('slow derived-cache storage leaves the event loop free and coalesces replacement snapshots', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: unknown[] = [];
  const writer = new DerivedJsonWriter('unused', async (_path, value) => { writes.push(value); if (writes.length === 1) await gate; });
  writer.save({ revision: 1 }); writer.save({ revision: 2 }); writer.save({ revision: 3 });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [{ revision: 1 }]);
  release(); await writer.flush();
  assert.deepEqual(writes, [{ revision: 1 }, { revision: 3 }]);
});

test('derived JSON uses atomic replacement with restrictive permissions and no leftover temporary files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-derived-')), path = join(root, 'cache.json');
  try {
    await writeDerivedJson(path, { revision: 1 }); await writeDerivedJson(path, { revision: 2 });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { revision: 2 });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), ['cache.json']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a blocking record read stays outside the service event loop and identical requests merge', { skip: process.platform === 'win32' }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-record-worker-'))), config = join(root, 'project.json');
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, sourceRoot: root, stateRoot: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), discovery: { mode: 'manual' }, repositories: [] }));
  const service = new Service(loadConfig(config));
  const pipe = join(service.config.recordsRoot, 'blocked.json'); execFileSync('mkfifo', [pipe]);
  const first = service.workspaces.observationRecords.request('get', { workspaceId: 'blocked' });
  const duplicate = service.workspaces.observationRecords.request('get', { workspaceId: 'blocked' });
  assert.equal(first, duplicate);
  const rejected = assert.rejects(first, (error: any) => error.code === 'record_invalid');
  try {
    let writer;
    for (let attempt = 0; attempt < 150; attempt++) {
      try { writer = await open(pipe, constants.O_WRONLY | constants.O_NONBLOCK); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENXIO') throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.ok(writer, 'worker did not begin its blocked read');
    try {
      const health = await service.handle('observer.health');
      assert.equal(health.recordReads.active, true);
      assert.equal(health.recordReads.merged, 1);
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally { await writer.writeFile('{}'); await writer.close(); }
    await rejected;
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
