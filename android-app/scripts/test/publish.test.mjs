import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { gitFixture } from './helpers.mjs';
import { prepareRelease, git } from '../../../scripts/release-android.mjs';
import { command, sha256, preflight, publishRelease, apkIdentity, existingRelease } from '../release.mjs';

const repo = 'fixture/pocket', tag = 'android-v0.1.2';
async function fixture(t) {
  const f = await gitFixture(); t.after(() => rm(f.parent, { recursive: true, force: true }));
  await prepareRelease({ root: f.root, version: '0.1.2', publish: true });
  f.output = join(f.root, 'output'); await mkdir(f.output);
  f.name = 'paseo-pocket-0.1.2.apk';
  await writeFile(join(f.output, f.name), 'isolated APK byte fixture');
  const manifest = { versionName: '0.1.2', versionCode: 3, tag, apk: f.name,
    sourceCommit: git(f.root, ['rev-parse', 'HEAD']), sha256: await sha256(join(f.output, f.name)) };
  await writeFile(join(f.output, 'release.json'), JSON.stringify(manifest));
  await writeFile(join(f.output, 'SHA256SUMS'), `${manifest.sha256}  ${f.name}\n${await sha256(join(f.output, 'release.json'))}  release.json\n`);
  await writeFile(join(f.output, 'release-notes.md'), 'Isolated release test');
  return f;
}
function fakeGitHub(f) {
  const state = { release: null, uploaded: new Map(), calls: [], failDownload: false, corruptDownload: false };
  state.run = (program, args, options) => {
    if (program !== 'gh') return command(program, args, options);
    state.calls.push(args);
    if (args[0] === 'api') {
      if (state.release) return JSON.stringify(state.release);
      throw Object.assign(new Error('not found'), { status: 1, stderr: 'gh: Not Found (HTTP 404)' });
    }
    const action = args[1];
    if (action === 'create') state.release = { draft: true, tag_name: tag, html_url: `https://github.com/${repo}/releases/tag/${tag}` };
    else if (action === 'upload') {
      for (const path of args.slice(3).filter(value => value.startsWith(f.output))) state.uploaded.set(basename(path), path);
    } else if (action === 'download') {
      if (state.failDownload) throw new Error('download interrupted');
      const destination = args[args.indexOf('--dir') + 1];
      for (const [name, path] of state.uploaded) copyFileSync(path, join(destination, name));
      if (state.corruptDownload) writeFileSync(join(destination, f.name), 'wrong remote bytes');
    } else if (action === 'edit') state.release.draft = false;
    else throw new Error(`Unexpected gh operation: ${action}`);
    return '';
  };
  return state;
}
test('tag preflight accepts main source and draft retries but rejects public or mismatched releases', async t => {
  const f = await fixture(t), remote = fakeGitHub(f);
  assert.equal((await preflight({ root: f.root, tag, repo, run: remote.run })).versionCode, 3);
  await assert.rejects(preflight({ root: f.root, tag: 'v0.1.2', repo, run: remote.run }), /tag does not match/);
  remote.release = { draft: true };
  assert.equal((await preflight({ root: f.root, tag, repo, run: remote.run })).resumingDraft, true);
  remote.release.draft = false;
  await assert.rejects(preflight({ root: f.root, tag, repo, run: remote.run }), /already public/);
  assert.throws(() => existingRelease(repo, tag, () => { throw Object.assign(new Error('server unavailable'), { status: 1, stderr: 'HTTP 503' }); }), /unavailable/);
});
test('draft upload is downloaded and checked before publishing without changing global Latest', async t => {
  const f = await fixture(t), remote = fakeGitHub(f);
  const url = await publishRelease({ root: f.root, output: f.output, tag, repo, run: remote.run });
  assert.ok(url.endsWith(`/releases/tag/${tag}`));
  assert.equal(remote.release.draft, false);
  assert.equal(remote.uploaded.size, 3);
  const writes = remote.calls.filter(args => args[0] === 'release');
  assert.deepEqual(writes.map(args => args[1]), ['create', 'upload', 'download', 'edit']);
  assert.ok(writes.filter(args => ['create', 'edit'].includes(args[1])).every(args => args.includes('--latest=false')));
});
test('interrupted draft verification remains private and resumes without a second release', async t => {
  const f = await fixture(t), remote = fakeGitHub(f);
  remote.failDownload = true;
  await assert.rejects(publishRelease({ root: f.root, output: f.output, tag, repo, run: remote.run }), /interrupted/);
  assert.equal(remote.release.draft, true);
  remote.failDownload = false;
  await publishRelease({ root: f.root, output: f.output, tag, repo, run: remote.run });
  assert.equal(remote.release.draft, false);
  assert.equal(remote.calls.filter(args => args[1] === 'create').length, 1);
});
test('corrupt uploaded bytes and already-public versions cannot be published or overwritten', async t => {
  const f = await fixture(t), remote = fakeGitHub(f);
  remote.corruptDownload = true;
  await assert.rejects(publishRelease({ root: f.root, output: f.output, tag, repo, run: remote.run }), /differs from the verified/);
  assert.equal(remote.release.draft, true);
  assert.equal(remote.calls.some(args => args[1] === 'edit'), false);
  remote.release.draft = false;
  const count = remote.calls.length;
  await assert.rejects(publishRelease({ root: f.root, output: f.output, tag, repo, run: remote.run }), /cannot be overwritten/);
  assert.equal(remote.calls.slice(count).some(args => args[0] === 'release'), false);
});
test('tag ancestry and earlier versionCode prevent publishing unrelated or non-upgradable APKs', async t => {
  const f = await fixture(t), remote = fakeGitHub(f);
  git(f.root, ['tag', 'android-v0.1.1', 'HEAD^']);
  assert.equal((await preflight({ root: f.root, tag, repo, run: remote.run })).versionCode, 3);
  await writeFile(join(f.root, 'android-app/version.properties'), 'versionName=0.1.3\nversionCode=3\n');
  git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'Invalid code reuse']); git(f.root, ['tag', 'android-v0.1.3']);
  git(f.root, ['push', '--atomic', 'origin', 'main', 'android-v0.1.1', 'android-v0.1.3']);
  await assert.rejects(preflight({ root: f.root, tag: 'android-v0.1.3', repo, run: remote.run }), /versionCode must exceed/);
  git(f.root, ['checkout', '-b', 'unmerged']);
  await writeFile(join(f.root, 'android-app/version.properties'), 'versionName=0.1.4\nversionCode=4\n');
  git(f.root, ['add', '.']); git(f.root, ['commit', '-m', 'Unmerged change']); git(f.root, ['tag', 'android-v0.1.4']);
  await assert.rejects(preflight({ root: f.root, tag: 'android-v0.1.4', repo, run: remote.run }));
});
test('APK metadata and signer checks reject wrong identity, version or additional signers', () => {
  const fingerprint = 'a'.repeat(64), expected = { versionName: '0.1.2', versionCode: 3 };
  const badging = "package: name='dev.paseo.pocket' versionCode='3' versionName='0.1.2'";
  const certificate = `Signer #1 certificate SHA-256 digest: ${fingerprint}`;
  apkIdentity(badging, certificate, expected, fingerprint);
  assert.throws(() => apkIdentity(badging.replace("versionCode='3'", "versionCode='2'"), certificate, expected, fingerprint));
  assert.throws(() => apkIdentity(badging.replace('dev.paseo.pocket', 'example.other'), certificate, expected, fingerprint));
  assert.throws(() => apkIdentity(badging, certificate, expected, 'b'.repeat(64)));
  assert.throws(() => apkIdentity(badging, `${certificate}\nSigner #2 certificate SHA-256 digest: ${fingerprint}`, expected, fingerprint));
});
