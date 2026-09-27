/** Isolated real-Git benchmark. No daily registry or plugin interaction. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { createDiffPerformanceFixture, percentile95 } from './diff-performance-fixture.mjs';
import { Service } from '../server/backend/service.ts';
import { loadConfig } from '../server/backend/config.ts';
import { Git, withBackgroundGit } from '../server/backend/git.ts';
const exec = promisify(execFile), root = await mkdtemp(join(tmpdir(), 'wb-diff-performance-')), repo = join(root, 'repo');
let service, pressure = false; const background = [];
const report = { kind: 'isolated-real-git-performance', ok: false };
try {
  await mkdir(repo); await exec('git', ['-C', repo, 'init', '-q']);
  await exec('git', ['-C', repo, 'config', 'user.name', 'Verification']); await exec('git', ['-C', repo, 'config', 'user.email', 'verify@example.invalid']);
  report.fixture = await createDiffPerformanceFixture(repo);
  const config = join(root, 'project.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, project: { id: 'performance' }, sourceRoot: root, stateRoot: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), repositories: [{ id: 'repo', path: 'repo' }], discovery: { mode: 'manual' }, management: { enabled: true }, limits: { gitTimeoutSeconds: 30 } }));
  service = new Service(loadConfig(config));
  const workspaceId = (await service.handle('workspace.list', {})).workspaces[0].id;
  const originalRun = Git.prototype.run, calls = [];
  Git.prototype.run = async function(...args) { calls.push(args[0]); return originalRun.apply(this, args); };
  const read = async (index, id) => {
    const started = performance.now();
    let value = await service.handle('repository.diff.read', { workspaceId, repoPath: 'repo', scope: 'working', path: `diff-performance/file-${String(index).padStart(5, '0')}.txt`, requestId: id });
    while (['queued', 'running'].includes(value.state)) { await new Promise(resolve => setTimeout(resolve, 25)); value = await service.handle('repository.diff.read', { action: 'status', taskId: value.taskId, requestId: id }); }
    assert.equal(value.state, 'ready', JSON.stringify(value.error)); assert.match(value.result.patch, new RegExp(`changed ${index}`));
    await service.handle('repository.diff.read', { action: 'release', taskId: value.taskId, requestId: id });
    return performance.now() - started;
  };
  const cold = [];
  for (let i = 0; i < 20; i++) cold.push(await read(i, `cold-${i}`));
  assert.ok(calls.every(args => !args.includes('--numstat')), 'single-file path ran numstat');
  assert.ok(calls.filter(args => args[0] === 'status').every(args => args.includes('--')), 'single-file path ran global status');
  // Watcher preparation may run ls-files, but it must never read untracked file contents.
  assert.equal(service.observation.statistics.health().bytes, 0);
  pressure = true;
  for (let i = 0; i < 3; i++) background.push((async () => {
    const git = new Git(repo, 30_000);
    while (pressure) await withBackgroundGit(() => git.run(['diff', '--numstat']));
  })());
  const busy = [], health = [];
  for (let i = 20; i < 40; i++) {
    busy.push(await read(i, `busy-${i}`));
    const start = performance.now(); await service.handle('observer.versions', { workspaceIds: [workspaceId] }); health.push(performance.now() - start);
  }
  pressure = false; await Promise.all(background);
  Git.prototype.run = originalRun;
  report.coldP95Ms = percentile95(cold); report.busyP95Ms = percentile95(busy); report.healthP95Ms = percentile95(health);
  report.samples = { cold, busy, health }; report.singleFileUntrackedBytes = service.observation.statistics.health().bytes;
  assert.ok(report.coldP95Ms <= 3000); assert.ok(report.busyP95Ms <= 3000); assert.ok(report.healthP95Ms <= 500);
  report.ok = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally { pressure = false; await Promise.allSettled(background); await service?.close(); await rm(root, { recursive: true, force: true }); console.log(JSON.stringify(report, null, 2)); }
