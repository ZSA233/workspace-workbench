#!/usr/bin/env node
import { mkdir, readFile, writeFile, cp, access, rename, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readMetadata, verifyMetadata, httpsUrl } from './metadata.mjs';
import { downloadArchive, verifyArchive } from './archive.mjs';

export async function createMirror(metadata, archive, output, publicBase) {
  verifyMetadata(metadata); await verifyArchive(archive, metadata);
  const base = httpsUrl(publicBase);
  if (base.search) throw new Error('Public base URL must not contain a query');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  try { await access(output); throw new Error('Output already exists; choose a new directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(output), { recursive: true });
  const staging = `${output}.staging-${randomUUID()}`;
  await mkdir(staging, { recursive: false });
  try {
    const name = `server-${metadata.version}.tgz`;
    await cp(archive, resolve(staging, name));
    const mirrored = verifyMetadata({ ...metadata, dist: { ...metadata.dist, tarball: new URL(name, base).href } });
    await writeFile(resolve(staging, 'latest.json'), `${JSON.stringify(mirrored, null, 2)}\n`);
    await writeFile(resolve(staging, 'README.txt'), 'Serve this directory over HTTPS. The package is unmodified and retains the official npm signature.\n');
    await rename(staging, output);
    return mirrored;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
  const version = args.get('--version'); const output = args.get('--output'); const base = args.get('--public-base');
  if (!version || !output || !base || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
    throw new Error('Usage: node src/mirror.mjs --version 0.12.0 --output ./output/mirror --public-base https://mirror.example/paseo/');
  const metadata = await readMetadata(`https://registry.npmjs.org/@getpaseo/server/${encodeURIComponent(version)}`);
  const cache = fileURLToPath(new URL('../cache/', import.meta.url));
  await mkdir(cache, { recursive: true });
  const archive = resolve(cache, `server-${metadata.version}.tgz`);
  try { await access(archive); await verifyArchive(archive, metadata); }
  catch { await rm(archive, { force: true }); await downloadArchive(metadata, archive); }
  const mirrored = await createMirror(metadata, archive, resolve(output), base);
  console.log(`Verified mirror ${mirrored.version} written to ${resolve(output)}`);
}
