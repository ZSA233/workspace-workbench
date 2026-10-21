import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMirror } from '../src/mirror.mjs';
import { verifyMetadata } from '../src/metadata.mjs';
import { verifyArchive } from '../src/archive.mjs';

test('mirror retains signed official package while changing only download URL', async t => {
  const archive = new URL('../cache/server-0.12.0.tgz', import.meta.url);
  try { await access(archive); } catch { t.skip('Run npm run bundle for the downloaded official archive integration'); return; }
  const metadata = JSON.parse(await readFile(new URL('../upstream.lock.json', import.meta.url)));
  const root = await mkdtemp(join(tmpdir(), 'paseo-pocket-mirror-'));
  const output = join(root, 'mirror');
  const mirror = await createMirror(metadata, archive, output, 'https://mirror.test/paseo/');
  assert.equal(mirror.dist.tarball, 'https://mirror.test/paseo/server-0.12.0.tgz');
  assert.deepEqual(mirror.dist.signatures, metadata.dist.signatures);
  verifyMetadata(JSON.parse(await readFile(join(output, 'latest.json'))));
  await verifyArchive(join(output, 'server-0.12.0.tgz'), metadata);
  await assert.rejects(createMirror(metadata, archive, output, 'https://mirror.test/'), /exists/);
});
