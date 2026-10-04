import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRealRefreshFixture, freezePlugin, pluginFingerprint, distribution } from './refresh-real-fixture.mjs';
const exec = promisify(execFile), plugin = resolve(import.meta.dirname, '..');
const output = resolve(process.env.WORKBENCH_REFRESH_OUTPUT || join(plugin, '../.local/verification/panel-refresh'));
await mkdir(output, { recursive: true });
const build = await pluginFingerprint(plugin);
const frozen = join(output, `plugin-${build}`);
try { await access(join(frozen, 'package.json')); } catch { await freezePlugin(plugin, frozen); }
const { Service } = await import(pathToFileURL(join(frozen, 'server/backend/service.ts')).href);
const { loadConfig } = await import(pathToFileURL(join(frozen, 'server/backend/config.ts')).href);
let fixture;
try { fixture = JSON.parse(await readFile(join(output, 'fixture.json'), 'utf8')); }
catch {
  if (!process.env.WORKBENCH_REAL_WORKSPACE_RECORD) throw Error('WORKBENCH_REAL_WORKSPACE_RECORD must identify the user-approved read-only source');
  fixture = await createRealRefreshFixture(join(output, 'fixture'), process.env.WORKBENCH_REAL_WORKSPACE_RECORD);
  await writeFile(join(output, 'fixture.json'), JSON.stringify(fixture, null, 2));
}
const config = loadConfig(fixture.config), groups = {}, stageSamples = [], report = { kind: 'same-volume-real-history-backend', build, fixture: fixture.evidence, samplesPerGroup: 20, groups, stageSamples, ok: false };
let service = new Service(config, '0.4.10');
const workspaceId = 'verify-current-repository';
try { service.workspaces.get(workspaceId); } catch { await service.handle('workspace.create', { name: workspaceId, repositories: fixture.repositories.map(r=>r.path), baseRefs: fixture.baseRefs }); }
const record = service.workspaces.get(workspaceId), repository = record.repositories.find(r => r.repoPath === process.env.WORKBENCH_REFRESH_REPOSITORY) || record.repositories[0];
const input = { workspaceId, repoPath: repository.repoPath, historyMode: 'full', maxCommits: 50, scope: 'working' };
const proof = join(repository.worktreePath, 'workbench-refresh-proof.txt');
const git = args => exec('git', ['-C', repository.worktreePath, ...args], { timeout: 60000, maxBuffer: 1024*1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
await writeFile(proof, `baseline ${Date.now()}\n`); await git(['add', 'workbench-refresh-proof.txt']); await git(['commit', '-qm', 'refresh verification baseline']);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let serial = 0;
async function refresh(params = input, force = true) {
  const started = performance.now(), requestId = `measure:${serial++}`;
  let task = await service.handle('observer.refresh', { ...params, requestId, force });
  const firstMs = performance.now() - started;
  const retained = !!task.result?.regions?.graph?.result;
  while (['queued','running'].includes(task.state)) {
    await sleep(20);
    task = await service.handle('observer.refresh', { action: 'status', requestId, taskId: task.taskId });
  }
  try {
    assert.equal(task.state, 'ready', JSON.stringify(task.error));
    for (const area of ['summary','graph','changes']) assert.equal(task.result.regions[area].state, 'ready', JSON.stringify(task.result.regions[area]));
    stageSamples.push({ requestId, durationMs: performance.now()-started, firstMs, retained, cacheHit: !!task.result.cacheHit,
      regions: Object.fromEntries(Object.entries(task.result.regions).map(([area, data])=>[area,{durationMs:data.durationMs, phase:data.phase}])), trace: task.result.trace });
    return { ms: performance.now()-started, firstMs, retained, task };
  } finally { if (task.taskId) await service.handle('observer.refresh', { action:'release',requestId,taskId:task.taskId }); }
}
async function group(name, work) {
  const values = [];
  for (let i=0;i<20;i++) values.push(await work(i));
  groups[name] = distribution(values);
  console.log(JSON.stringify({ group: name, ...groups[name] }));
  assert.ok(groups[name].p95Ms <= (name === 'cached-switch' || name === 'persisted-first-response' ? 200 : 5000), `${name}: ${JSON.stringify(groups[name])}`);
}
try {
  await refresh();
  await group('manual-clean', async()=> (await refresh()).ms);
  await group('external-edit', async i=> { await writeFile(proof, `edit ${i}\n`); const r=await refresh(); assert.ok(r.task.result.regions.changes.result.files.some(f=>f.path==='workbench-refresh-proof.txt')); assert.equal(r.task.result.regions.summary.result.repository.dirty,true); return r.ms; });
  await group('external-commit', async i=> { await writeFile(proof, `commit ${i}\n`); await git(['add','workbench-refresh-proof.txt']); await git(['commit','-qm',`refresh proof ${i}`]); const head=(await git(['rev-parse','HEAD'])).stdout.trim(); const r=await refresh(); assert.equal(r.task.result.regions.graph.result.head,head); assert.equal(r.task.result.regions.summary.result.repository.head,head); return r.ms; });
  for(const repo of record.repositories) { await service.observation.scheduler.register(workspaceId,repo.worktreePath); await refresh({...input,repoPath:repo.repoPath}); }
  await group('cached-switch', async i=> (await refresh({...input,repoPath:record.repositories[i%record.repositories.length].repoPath},false)).ms);
  await group('persisted-first-response', async()=> { await service.close(); service=new Service(config,'0.4.10'); const r=await refresh(input,false); assert.ok(r.retained); return r.firstMs; });
  await group('backend-cold-no-snapshot', async()=> { await service.close(); await rm(join(config.stateRoot,'observer-node-cache.json'),{force:true}); service=new Service(config,'0.4.10'); return (await refresh()).ms; });
  report.ok=true;
} catch(error) { report.error=error.stack; process.exitCode=1; }
finally { await service.close(); await writeFile(join(output,'performance.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({ok:report.ok,error:report.error,groups},null,2)); }
