import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { verifyMetadata, httpsUrl } from '../src/metadata.mjs';
import { extractWeb, safeArchivePath, verifyArchive } from '../src/archive.mjs';

const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const policy = { packageName: '@getpaseo/server', keys: [{ keyid: 'fixture',
  publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }] };
async function fixture(entries) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-assets-test-'));
  const pack = tar.pack(); const chunks = [];
  const reading = (async () => { for await (const chunk of pack) chunks.push(chunk); })();
  for (const entry of entries) pack.entry(entry.header, entry.body ?? '');
  pack.finalize(); await reading;
  const bytes = gzipSync(Buffer.concat(chunks)); const file = join(directory, 'package.tgz');
  await writeFile(file, bytes);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const payload = `@getpaseo/server@0.12.0:${integrity}`;
  const metadata = { name: '@getpaseo/server', version: '0.12.0', dist: {
    tarball: 'https://example.test/package.tgz', integrity,
    signatures: [{ keyid: 'fixture', sig: sign('sha256', Buffer.from(payload), key.privateKey).toString('base64') }] } };
  return { directory, file, metadata, output: join(directory, 'web') };
}
const valid = [
  { header: { name: 'package/dist/server/web-ui/index.html' }, body: '<script src="/app.js"></script>' },
  { header: { name: 'package/dist/server/web-ui/app.js' }, body: 'console.log("fixture")' },
  { header: { name: 'package/LICENSE' }, body: 'fixture license' },
  { header: { name: 'package/install.js' }, body: 'throw new Error("must never execute")' },
];

test('locked official signature is valid; mirror URL is not part of signed payload', async () => {
  const lock = JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url)));
  assert.equal(verifyMetadata(lock).version, '0.13.0');
  lock.dist.tarball = 'https://mirror.test/server.tgz';
  assert.equal(verifyMetadata(lock).dist.tarball, lock.dist.tarball);
  assert.throws(() => verifyMetadata({ ...lock, version: '0.13.1' }), /signature/);
  assert.throws(() => verifyMetadata({ ...lock, name: 'other' }), /identity/);
  lock.dist.signatures = [{ keyid: 'unknown', sig: 'invalid' }];
  assert.throws(() => verifyMetadata(lock), /Untrusted/);
});
test('HTTPS validation rejects credentials, fragments, downgrade', () => {
  for (const url of ['http://x.test', 'https://u:p@x.test', 'https://x.test/#secret'])
    assert.throws(() => httpsUrl(url));
});
test('streaming extraction keeps only web assets and licenses', async () => {
  const f = await fixture(valid);
  const manifest = await extractWeb(f.file, f.output, f.metadata, policy);
  assert.equal(manifest.files.length, 3);
  assert.equal(await readFile(join(f.output, 'licenses/LICENSE'), 'utf8'), 'fixture license');
  await assert.rejects(access(join(f.output, 'install.js')));
  await writeFile(f.file, 'corrupt');
  await assert.rejects(verifyArchive(f.file, f.metadata), /integrity/);
});
test('path traversal, links, duplicate paths, missing chunks fail without leaving installed files', async () => {
  for (const extra of [
    { header: { name: 'package/../../escape' } },
    { header: { name: 'package/link', type: 'symlink', linkname: '/etc/passwd' } },
    valid[0],
  ]) {
    const f = await fixture([...valid, extra]);
    await assert.rejects(extractWeb(f.file, f.output, f.metadata, policy));
    await assert.rejects(access(f.output));
  }
  const missing = await fixture(valid.slice(0, 1));
  await assert.rejects(extractWeb(missing.file, missing.output, missing.metadata, policy), /missing/);
  for (const path of ['/root', 'a/../b', 'a\\b', 'C:drive', 'a\0b'])
    assert.throws(() => safeArchivePath(path));
});
