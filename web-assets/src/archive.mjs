import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import { fetchHttps, limits, verifyMetadata } from './metadata.mjs';

export async function verifyArchive(file, metadata) {
  const hash = createHash('sha512'); let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    if (size > limits.archive) throw new Error('Archive exceeds size limit');
    hash.update(chunk);
  }
  const expected = Buffer.from(metadata.dist.integrity.substring(7), 'base64');
  if (expected.length !== 64 || !timingSafeEqual(hash.digest(), expected)) throw new Error('Archive integrity mismatch');
}

export async function downloadArchive(metadata, file, signal = AbortSignal.timeout(180_000)) {
  verifyMetadata(metadata);
  const response = await fetchHttps(metadata.dist.tarball, { signal });
  let size = 0;
  const counter = new Transform({ transform(chunk, _, done) {
    size += chunk.length;
    done(size > limits.archive ? new Error('Archive exceeds size limit') : null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    await verifyArchive(file, metadata);
  } catch (error) { await rm(file, { force: true }); throw error; }
}

export function safeArchivePath(name) {
  if (typeof name !== 'string' || name.length > 1024 || name.startsWith('/') ||
      /[\\\x00-\x1f:]/.test(name) || name.replace(/\/$/, '').split('/').some(p => !p || p === '.' || p === '..'))
    throw new Error('Unsafe archive path');
  return name.replace(/\/$/, '');
}

export async function extractWeb(file, output, metadata, policy) {
  verifyMetadata(metadata, policy);
  await verifyArchive(file, metadata);
  await mkdir(output, { recursive: false });
  const inventory = []; const names = new Set(); let expanded = 0; let count = 0;
  const prefix = 'package/dist/server/web-ui/';
  const extractor = tar.extract();
  const counter = new Transform({ transform(chunk, _, done) {
    expanded += chunk.length;
    done(expanded > limits.expanded ? new Error('Expanded archive exceeds limit') : null, chunk);
  } });
  extractor.on('entry', (header, stream, next) => {
    (async () => {
      const name = safeArchivePath(header.name);
      if (++count > limits.files || header.size > limits.file) throw new Error('Archive file limit exceeded');
      if (!['file', 'directory'].includes(header.type)) throw new Error('Links and special archive entries are forbidden');
      if (names.has(name)) throw new Error('Duplicate archive path');
      names.add(name);
      let relative = null;
      if (header.type === 'file' && name.startsWith(prefix) && !/\.(?:gz|br|map)$/.test(name))
        relative = name.substring(prefix.length);
      else if (header.type === 'file' && /^package\/(?:LICENSE(?:\.md|\.txt)?|NOTICE(?:\.txt)?)$/i.test(name))
        relative = `licenses/${name.substring(8)}`;
      if (relative) {
        if (!relative || relative.startsWith('/') || ['_workbench.json', '_trust.json'].includes(relative)) throw new Error('Invalid resource path');
        const destination = join(output, relative);
        await mkdir(dirname(destination), { recursive: true });
        const hash = createHash('sha256'); let bytes = 0;
        const hashing = new Transform({ transform(chunk, _, done) { hash.update(chunk); bytes += chunk.length; done(null, chunk); } });
        await pipeline(stream, hashing, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
        inventory.push({ path: relative, size: bytes, sha256: hash.digest('hex') });
      } else { for await (const _chunk of stream) { /* bounded by the archive counter */ } }
    })().then(() => next(), error => extractor.destroy(error));
  });
  try {
    await pipeline(createReadStream(file), createGunzip(), counter, extractor);
    if (!inventory.some(f => f.path === 'index.html') || !inventory.some(f => f.path.endsWith('.js')))
      throw new Error('Required index.html or JavaScript is missing');
    const index = await readFile(join(output, 'index.html'), 'utf8');
    for (const match of index.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      if (match[1].startsWith('#')) continue;
      const path = match[1].split(/[?#]/)[0];
      if (/^(?:https?:)?\/\//.test(path)) throw new Error('Remote index resource is forbidden');
      if (!inventory.some(f => f.path === path.replace(/^\//, '')))
        throw new Error(`Missing index resource: ${path}`);
    }
    inventory.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const manifest = { schema: 1, metadata, files: inventory };
    await writeFile(join(output, '_workbench.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}
