import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { loadConfig } from '../server/backend/config.ts';
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
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wb-activity-')));
  const configPath = join(root, 'project.json');
  await writeFile(configPath, JSON.stringify({ sourceRoot: root, stateRoot: join(root, 'state') }));
  const source = join(root, 'source');
  await mkdir(source);
  git(source, ['init', '-q']);
  git(source, ['config', 'user.name', 'Activity test']);
  git(source, ['config', 'user.email', 'activity@example.invalid']);
  git(source, ['commit', '--allow-empty', '-qm', 'base']);
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
    await delay(300);
    assert.equal(index.health().failures, failures);
    await rename(join(visible, 'broken.git'), join(visible, '.git'));
    f.advance(1_000);
    await until(() => index.summary(rows[1]).latestCommitState === 'ready');
    assert.equal(index.health().failures, failures);
  } finally { await index.close(); await rm(root, { recursive: true, force: true }); }
});

test('full checks merge and cancellation keeps finished verification and stops manual targets', async () => {
  const f = await fixture();
  const { root, source, index } = f;
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
    const first = index.startForIds('full', undefined, true);
    const second = index.startForIds('duplicate', undefined, true);
    assert.equal(first.total, rows.length);
    assert.equal(second.total, first.total);
    await until(() => index.status('full').completed > 0);
    assert.equal(index.status('duplicate').completed, index.status('full').completed);
    assert.equal(index.status('full').state, 'running');
    index.cancel('duplicate');
    assert.equal(index.status('full').state, 'cancelled');
    const started = index.health().started;
    await delay(550);
    assert.equal(index.health().started, started);
    assert.ok(index.status('full').completed > 0);
    assert.ok(rows.every(workspace => index.summary(workspace).latestCommitAt));
  } finally { await index.close(); await rm(root, { recursive: true, force: true }); }
});
