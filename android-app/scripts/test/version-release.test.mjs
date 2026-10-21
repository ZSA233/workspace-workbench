import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMetadata, nextVersion, bumpedVersion, compareVersions, readVersion } from '../version.mjs';
import { prepareRelease, git } from '../../../scripts/release-android.mjs';
import { gitFixture } from './helpers.mjs';

test('versions reject malformed, duplicate, unsafe and backwards metadata', () => {
  assert.deepEqual(parseMetadata('versionName=0.1.1\r\nversionCode=2\r\n'), { versionName: '0.1.1', versionCode: 2 });
  for (const name of ['v0.1.2', '0.01.2', '0.1.2-beta', '0.1.2\n', '1.2', '1.2.9007199254740992'])
    assert.throws(() => nextVersion({ versionName: '0.1.1', versionCode: 2 }, name));
  for (const code of ['0', '02', '2e1', '-1', '2100000001'])
    assert.throws(() => parseMetadata(`versionName=0.1.1\nversionCode=${code}\n`));
  assert.throws(() => parseMetadata('versionName=0.1.1\nversionCode=2\nversionCode=3\n'));
  assert.throws(() => nextVersion({ versionName: '0.1.1', versionCode: 2 }, '0.1.0'));
  assert.throws(() => nextVersion({ versionName: '0.1.1', versionCode: 2100000000 }, '0.1.2'));
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(bumpedVersion('0.1.9', 'minor'), '0.2.0');
});
test('preparing twice is idempotent and does not commit or push', async t => {
  const f = await gitFixture(); t.after(() => rm(f.parent, { recursive: true, force: true }));
  const head = git(f.root, ['rev-parse', 'HEAD']);
  for (let i = 0; i < 2; i++) {
    assert.equal((await prepareRelease({ root: f.root, version: '0.1.2' })).versionCode, 3);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), head);
    assert.equal(git(f.root, ['ls-remote', '--tags', 'origin']), '');
  }
  assert.equal((await readVersion(join(f.root, 'android-app'))).versionName, '0.1.2');
});
test('publish creates a version-only commit and annotated tag in one push; cannot overwrite', async t => {
  const f = await gitFixture(); t.after(() => rm(f.parent, { recursive: true, force: true }));
  const result = await prepareRelease({ root: f.root, version: '0.1.2', publish: true });
  assert.equal(result.versionCode, 3); assert.equal(result.published, true);
  assert.equal(git(f.root, ['cat-file', '-t', result.tag]), 'tag');
  assert.equal(git(f.root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']), 'android-app/version.properties');
  assert.equal(git(f.remote, ['rev-parse', 'refs/heads/main']), result.commit);
  assert.equal(git(f.remote, ['rev-parse', `${result.tag}^{commit}`]), result.commit);
  await assert.rejects(prepareRelease({ root: f.root, version: '0.1.2', publish: true }), /already exists/);
});
test('rejected atomic push retains version commit, removes only owned unpushed tag, and can retry', async t => {
  const f = await gitFixture(); t.after(() => rm(f.parent, { recursive: true, force: true }));
  const hook = join(f.remote, 'hooks/pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755);
  await assert.rejects(prepareRelease({ root: f.root, version: '0.1.2', publish: true }), /Push did not complete/);
  assert.equal(git(f.root, ['tag', '--list']), '');
  assert.equal((await readVersion(join(f.root, 'android-app'))).versionCode, 3);
  assert.equal(git(f.remote, ['show', 'main:android-app/version.properties']).includes('versionCode=2'), true);
  await rm(hook);
  const retried = await prepareRelease({ root: f.root, version: '0.1.2', publish: true });
  assert.equal(retried.versionCode, 3);
  assert.equal(git(f.remote, ['rev-parse', 'android-v0.1.2^{commit}']), retried.commit);
});
test('unrelated edits, conflicting version edits and existing local tags are preserved', async t => {
  const f = await gitFixture(); t.after(() => rm(f.parent, { recursive: true, force: true }));
  await writeFile(join(f.root, 'source.txt'), 'user edit');
  await assert.rejects(prepareRelease({ root: f.root, version: '0.1.2' }), /other changes/);
  assert.equal(await readFile(join(f.root, 'source.txt'), 'utf8'), 'user edit');
  git(f.root, ['restore', 'source.txt']);
  await writeFile(join(f.root, 'android-app/version.properties'), 'versionName=0.9.0\nversionCode=9\n');
  await assert.rejects(prepareRelease({ root: f.root, version: '0.1.2' }), /refusing to overwrite/);
  git(f.root, ['restore', 'android-app/version.properties']);
  git(f.root, ['tag', 'android-v0.1.2']);
  const original = git(f.root, ['rev-parse', 'android-v0.1.2']);
  await assert.rejects(prepareRelease({ root: f.root, version: '0.1.2', publish: true }), /already exists/);
  assert.equal(git(f.root, ['rev-parse', 'android-v0.1.2']), original);
});
test('remote advancement stops publishing before changing version metadata', async t => {
  const f = await gitFixture(); t.after(() => rm(f.parent, { recursive: true, force: true }));
  const second = join(f.parent, 'second'); git(f.parent, ['clone', f.remote, second]);
  git(second, ['config', 'user.name', 'Other Test']); git(second, ['config', 'user.email', 'other@example.invalid']);
  await writeFile(join(second, 'source.txt'), 'new remote commit');
  git(second, ['add', '.']); git(second, ['commit', '-m', 'Remote work']); git(second, ['push', 'origin', 'main']);
  await assert.rejects(prepareRelease({ root: f.root, version: '0.1.2', publish: true }), /Remote main has advanced/);
  assert.equal((await readVersion(join(f.root, 'android-app'))).versionCode, 2);
});
