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

test('a blocked directory scan cannot block initial or subsequent workspace records', async () => {
  const { Worker } = await import('node:worker_threads');
  const { ObservationRecords } = await import('../server/backend/observation-records.ts');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-roster-lanes-'))), path = join(root,'project.json');
  writeFileSync(path, JSON.stringify({schemaVersion:1,sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),discovery:{mode:'manual'},repositories:[]}));
  const config = loadConfig(path), gate = new Int32Array(new SharedArrayBuffer(8));
  const source = `
    import {workerData} from 'node:worker_threads';
    import {Workspaces} from ${JSON.stringify(new URL('../server/backend/workspaces.ts',import.meta.url).href)};
    const original = Workspaces.prototype.orphanSnapshot;
    Workspaces.prototype.orphanSnapshot = async function(...args) {
      const gate = new Int32Array(workerData);
      Atomics.store(gate,0,1); Atomics.wait(gate,1,0,10000);
      return original.apply(this,args);
    };
    await import(${JSON.stringify(new URL('../server/backend/observation-records-worker.ts',import.meta.url).href)});
  `;
  let changes = 0;
  const reader = new ObservationRecords(()=>config,()=>{changes++;},()=>new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`),{workerData:gate.buffer,execArgv:['--experimental-strip-types']}));
  try {
    const first = await reader.request('roster');
    assert.equal(first.workspaces[0].id,'main');
    assert.equal(first.orphanScan.state,'scanning');
    for(let i=0;i<250 && !Atomics.load(gate,0);i++) await new Promise(r=>setTimeout(r,20));
    assert.equal(Atomics.load(gate,0),1,'scan never started');
    const start=Date.now();
    const [second, main] = await Promise.all([reader.request('roster'),reader.request('get',{workspaceId:'main'})]);
    assert.equal(second.workspaces[0].id,'main'); assert.equal(main.id,'main');
    assert.ok(Date.now()-start<1500,'metadata waited for the blocked auxiliary scan');
    assert.equal(reader.health().supplements.active,true);
    Atomics.store(gate,1,1); Atomics.notify(gate,1);
    for(let i=0;i<250 && reader.health().supplements.active;i++) await new Promise(r=>setTimeout(r,20));
    const recovered=await reader.request('roster');
    assert.equal(recovered.orphanScan.state,'ready');
    assert.ok(changes>0,'scan completion did not publish a roster invalidation');
    assert.ok(reader.health().recent.every((item:any)=>item.executionMs>=0 && item.queueMs>=0));
  } finally {Atomics.store(gate,1,1);Atomics.notify(gate,1);await reader.close();rmSync(root,{recursive:true,force:true});}
});

test('failed scan publication does not automatically restart discovery', async () => {
  const {Worker}=await import('node:worker_threads');
  const {ObservationRecords}=await import('../server/backend/observation-records.ts');
  const root=realpathSync(mkdtempSync(join(tmpdir(),'wb-scan-failure-'))), path=join(root,'project.json');
  writeFileSync(path,JSON.stringify({schemaVersion:1,sourceRoot:root,stateRoot:join(root,'state'),workspaceRoot:join(root,'workspaces'),discovery:{mode:'manual'},repositories:[]}));
  const config=loadConfig(path), calls=new Int32Array(new SharedArrayBuffer(4));
  const source=`
    import {workerData} from 'node:worker_threads';
    import {Workspaces} from ${JSON.stringify(new URL('../server/backend/workspaces.ts',import.meta.url).href)};
    Workspaces.prototype.orphanSnapshot=async function() {
      Atomics.add(new Int32Array(workerData),0,1);
      this.orphanScan={state:'failed',candidates:[],scannedDirectories:0,reason:'injected_failure'};
      this.onOrphanScanChanged?.();
      return this.orphanScan;
    };
    await import(${JSON.stringify(new URL('../server/backend/observation-records-worker.ts',import.meta.url).href)});
  `;
  const reader=new ObservationRecords(()=>config,()=>{},()=>new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`),{workerData:calls.buffer,execArgv:['--experimental-strip-types']}));
  try {
    assert.equal((await reader.request('roster')).workspaces[0].id,'main');
    for(let i=0;i<250 && !Atomics.load(calls,0);i++) await new Promise(r=>setTimeout(r,20));
    assert.equal(Atomics.load(calls,0),1);
    await new Promise(r=>setTimeout(r,150));
    assert.equal(Atomics.load(calls,0),1,'failure publication restarted the scan');
    assert.equal(reader.health().supplements.active,false);
  }finally{await reader.close();rmSync(root,{recursive:true,force:true});}
});
