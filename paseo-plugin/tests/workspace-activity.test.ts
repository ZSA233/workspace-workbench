import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { loadConfig } from '../server/backend/config.ts';
import { Git } from '../server/backend/git.ts';
import { WorkspaceActivityIndex } from '../server/backend/workspace-activity.ts';

const oldDate = '2020-01-01T00:00:00Z';
const now = Date.parse('2026-01-01T00:00:00Z');
const git = (cwd: string, args: string[], date = oldDate) => execFileSync('git', ['-C', cwd, ...args], {
  env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  encoding: 'utf8',
}).trim();
async function until(predicate: () => boolean) {
  const end = Date.now() + 7_000;
  while (!predicate() && Date.now() < end) await delay(15);
  assert.ok(predicate(), 'Workspace activity did not settle');
}
async function fixture(commitAt = oldDate) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wb-activity-')));
  const configPath = join(root, 'project.json');
  await writeFile(configPath, JSON.stringify({ sourceRoot: root, stateRoot: join(root, 'state') }));
  const source = join(root, 'source');
  await mkdir(source);
  git(source, ['init', '-q']);
  git(source, ['config', 'user.name', 'Activity test']);
  git(source, ['config', 'user.email', 'activity@example.invalid']);
  git(source, ['commit', '--allow-empty', '-qm', 'base'], commitAt);
  const config = loadConfig(configPath);
  let at = now;
  const index = new WorkspaceActivityIndex(config, () => at);
  return { root, source, index, advance(ms: number) { at += ms; } };
}
const row = (id: string, path: string) => ({ id, repositories: [{ worktreePath: path }] });

test('current, visible and cold activity have separate deadlines and failed probes back off', async () => {
  const f = await fixture();
  const { root, source, index } = f;
  const visible = join(root, 'visible'), cold = join(root, 'cold');
  try {
    for (const path of [visible, cold]) git(source, ['worktree', 'add', '-q', '--detach', path, 'HEAD']);
    const rows = [row('selected', source), row('visible', visible), row('cold', cold)];
    index.reconcileWorkspaces(rows);
    index.warm();
    await until(() => index.health().jobs === 0 && index.health().started === 3);
    const initial = index.health();
    assert.ok(initial.gitCommands < 3, 'shared OIDs were batched in the common repository');
    assert.equal(index.summary({ ...rows[0], repositories: rows[1].repositories }).activityScope, undefined, 'older roster paths cannot carry a newer activity scope');
    index.view({ viewId: 'panel', sequence: 1, selectedWorkspaceId: 'selected', visibleWorkspaceIds: ['visible'] });
    // A delayed display message cannot restore the old list of visible rows.
    index.view({ viewId: 'panel', sequence: 0, selectedWorkspaceId: 'cold', visibleWorkspaceIds: ['cold'] });
    f.advance(15_000);
    await until(() => index.health().started > initial.started && index.health().jobs === 0);
    assert.equal(index.health().started - initial.started, 1);
    assert.equal(index.health().gitCommands, initial.gitCommands, 'unchanged HEAD reused its date');

    f.advance(15_000);
    await until(() => index.health().started === initial.started + 3 && index.health().jobs === 0);
    const before = index.summary(rows[2]).latestCommitAt;
    git(cold, ['commit', '--allow-empty', '-qm', 'commit in an unobserved worktree'], '2026-01-01T00:01:00Z');
    index.view({ viewId: 'panel', sequence: 2, visibleWorkspaceIds: [] });
    f.advance(29 * 60_000);
    await delay(300);
    assert.equal(index.summary(rows[2]).latestCommitAt, before);
    f.advance(60_000);
    await until(() => Date.parse(index.summary(rows[2]).latestCommitAt || '') === now + 60_000);

    await rename(join(visible, '.git'), join(visible, 'broken.git'));
    index.view({ viewId: 'panel', sequence: 3, selectedWorkspaceId: 'visible' });
    index.refsChanged([join(visible, '.git')], [visible]);
    await until(() => index.summary(rows[1]).latestCommitState === 'partial');
    const failures = index.health().failures;
    f.advance(59_000);
    index.view({ viewId: 'panel', sequence: 4, selectorOpen: true });
    await delay(300);
    assert.equal(index.health().failures, failures);
    await rename(join(visible, 'broken.git'), join(visible, '.git'));
    f.advance(1_000);
    await until(() => index.summary(rows[1]).latestCommitState === 'ready');
    assert.equal(index.health().failures, failures);
  } finally { await index.close(); await rm(root, { recursive: true, force: true }); }
});

test('full checks merge and cancellation keeps finished verification and stops manual targets', async t => {
  const f = await fixture();
  const { root, source, index } = f;
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  try {
    const rows = [row('main', source)];
    for (let i = 0; i < 22; i++) {
      const path = join(root, 'checkout-' + i);
      git(source, ['worktree', 'add', '-q', '--detach', path, 'HEAD']);
      rows.push(row('checkout-' + i, path));
    }
    index.reconcileWorkspaces(rows);
    index.startForIds('initial', undefined, false);
    await until(() => index.status('initial').state === 'complete');
    assert.equal(index.health().started, rows.length);
    assert.ok(index.health().gitCommands < rows.length / 2);
    const slowPath = rows.at(-1)!.repositories[0].worktreePath;
    git(slowPath, ['commit', '--allow-empty', '-qm', 'separate slow commit']);
    const slowHead = git(slowPath, ['rev-parse', 'HEAD']);
    const originalRun = Git.prototype.run;
    t.mock.method(Git.prototype, 'run', async function(this: Git, ...args: Parameters<Git['run']>) {
      // Keep one real read unfinished regardless of how quickly the other
      // batches drain; cancellation must not race a fully completed scan.
      if (this.path === slowPath || args[0].includes(slowHead)) await paused;
      return originalRun.apply(this, args);
    });
    const first = index.startForIds('full', undefined, true);
    const second = index.startForIds('duplicate', undefined, true);
    assert.equal(first.total, rows.length);
    assert.equal(second.total, first.total);
    await until(() => index.status('full').completed > 0);
    assert.equal(index.status('duplicate').completed, index.status('full').completed);
    assert.equal(index.status('full').state, 'running');
    index.cancel('duplicate');
    assert.equal(index.status('full').state, 'cancelled');
    release();
    const started = index.health().started;
    await delay(550);
    assert.equal(index.health().started, started);
    assert.ok(index.status('full').completed > 0);
    assert.ok(rows.every(workspace => index.summary(workspace).latestCommitAt));
  } finally { release(); await index.close(); await rm(root, { recursive: true, force: true }); }
});

test('opening the selector catches a new commit in an offscreen cold Workspace before its normal deadline', async () => {
  const f = await fixture('2025-12-30T00:00:00Z');
  const { root, source, index } = f;
  const cold = join(root, 'cold');
  try {
    git(source, ['worktree', 'add', '-q', '--detach', cold, 'HEAD']);
    git(source, ['commit', '--allow-empty', '-qm', 'recent selected Workspace'], '2025-12-31T23:00:00Z');
    const rows = [row('main', source), row('cold', cold)];
    index.reconcileWorkspaces(rows);
    index.warm();
    await until(() => index.health().started === 2 && index.health().jobs === 0);
    index.view({ viewId: 'panel', sequence: 1, selectedWorkspaceId: 'main', selectorOpen: false });

    f.advance(60_000);
    const freshCommit = '2026-01-01T00:01:00Z';
    git(cold, ['commit', '--allow-empty', '-qm', 'cold Workspace is active again'], freshCommit);
    // This repository has no active watcher and is below the visible rows.
    await delay(300);
    assert.equal(Date.parse(index.summary(rows[1]).latestCommitAt!), Date.parse('2025-12-30T00:00:00Z'));
    index.view({ viewId: 'panel', sequence: 2, selectedWorkspaceId: 'main', visibleWorkspaceIds: ['main'], selectorOpen: true });
    await until(() => Date.parse(index.summary(rows[1]).latestCommitAt || '') === Date.parse(freshCommit));
    await until(() => index.health().jobs === 0);
    assert.ok(Date.parse(index.summary(rows[1]).latestCommitAt!) > Date.parse(index.summary(rows[0]).latestCommitAt!));
    const caughtUp = index.health();

    f.advance(5_000);
    index.view({ viewId: 'panel', sequence: 3, selectedWorkspaceId: 'main', selectorOpen: false });
    index.view({ viewId: 'panel', sequence: 4, selectedWorkspaceId: 'main', visibleWorkspaceIds: ['main'], selectorOpen: true });
    await delay(300);
    assert.equal(index.health().started, caughtUp.started, 'rapidly reopening reuses recently verified HEADs');

    f.advance(60_000);
    index.view({ viewId: 'panel', sequence: 5, selectedWorkspaceId: 'main', selectorOpen: false });
    index.view({ viewId: 'panel', sequence: 6, selectedWorkspaceId: 'main', visibleWorkspaceIds: ['main'], selectorOpen: true });
    await until(() => index.health().headChecks >= caughtUp.headChecks + 2 && index.health().jobs === 0);
    assert.equal(index.health().gitCommands, caughtUp.gitCommands, 'unchanged HEADs reuse commit dates without Git subprocesses');
    assert.equal(index.health().fullScan, null, 'opening never starts a forced full scan');
  } finally { await index.close(); await rm(root, { recursive: true, force: true }); }
});

test('an expired selector lease reconciles offscreen HEADs again while heartbeat polls keep the original opening', async () => {
  const f = await fixture();
  const { root, source, index } = f;
  try {
    const workspace = row('cold', source);
    index.reconcileWorkspaces([workspace]);
    index.warm();
    await until(() => index.health().started === 1 && index.health().jobs === 0);
    index.view({ viewId: 'panel', sequence: 1, selectorOpen: true });
    f.advance(60_000);
    const freshCommit = '2026-01-01T00:01:00Z';
    git(source, ['commit', '--allow-empty', '-qm', 'commit after returning'], freshCommit);
    // The frontend was suspended; its previous view lease has expired.
    index.view({ viewId: 'panel', sequence: 2, selectorOpen: true });
    await until(() => Date.parse(index.summary(workspace).latestCommitAt || '') === Date.parse(freshCommit));
    const caughtUp = index.health();
    for (let sequence = 3; sequence < 6; sequence++) {
      f.advance(30_000);
      index.view({ viewId: 'panel', sequence, selectorOpen: true });
      await delay(270);
    }
    assert.equal(index.health().headChecks, caughtUp.headChecks, 'renewing the same open view does not promote every cold target');
    const nextCommit = '2026-01-01T00:02:00Z';
    git(source, ['commit', '--allow-empty', '-qm', 'reopened between two polls'], nextCommit);
    index.view({ viewId: 'panel', sequence: 6, selectorOpen: true, selectorSequence: 1 });
    // An obsolete close must not erase the newer opening's catch-up demand.
    index.view({ viewId: 'panel', sequence: 5, selectorOpen: false });
    await until(() => Date.parse(index.summary(workspace).latestCommitAt || '') === Date.parse(nextCommit));
  } finally { await index.close(); await rm(root, { recursive: true, force: true }); }
});

test('finished HEAD probes drain a bounded queue without waiting for the next periodic tick', async t => {
  const f = await fixture();
  const { root, source, index } = f;
  const ticks: Array<() => void> = [];
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => {
    ticks.push(callback);
    return { unref() {} };
  });
  try {
    const rows = [row('main', source)];
    for (let i = 0; i < 32; i++) {
      const path = join(root, 'queued-' + i);
      git(source, ['worktree', 'add', '--no-checkout', '-q', '--detach', path, 'HEAD']);
      rows.push(row('queued-' + i, path));
    }
    index.reconcileWorkspaces(rows);
    index.startForIds('bounded', undefined, false);
    assert.equal(ticks.length, 1);
    ticks[0]();
    // A periodic poll is not required for every batch of an already queued scan.
    await until(() => index.status('bounded').state === 'complete');
    assert.equal(index.status('bounded').completed, rows.length);
    assert.ok(index.health().maxHeadRunning <= 4);
    assert.ok(index.health().maxGitRunning <= 2);
    assert.ok(index.health().gitCommands < rows.length / 2, 'shared commit dates are still reused');
  } finally { await index.close(); await rm(root, { recursive: true, force: true }); }
});
