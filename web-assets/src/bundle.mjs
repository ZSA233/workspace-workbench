#!/usr/bin/env node
import { readFile, mkdir, access, cp, rm, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadArchive, extractWeb, verifyArchive } from './archive.mjs';
import { verifyMetadata } from './metadata.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = verifyMetadata(JSON.parse(await readFile(resolve(root, 'upstream.lock.json'), 'utf8')));
const cache = resolve(root, 'cache');
await mkdir(cache, { recursive: true });
const archive = resolve(cache, `server-${metadata.version}.tgz`);
try { await access(archive); await verifyArchive(archive, metadata); }
catch { await rm(archive, { force: true }); await downloadArchive(metadata, archive); }
const output = resolve(root, '../android-app/app/src/main/assets/paseo');
const staging = `${output}.staging`;
await mkdir(dirname(output), { recursive: true });
await rm(staging, { recursive: true, force: true });
const manifest = await extractWeb(archive, staging, metadata);
await cp(resolve(root, 'trust.json'), resolve(staging, '_trust.json'));
const legal = resolve(root, '../android-app/app/src/main/assets/legal');
await mkdir(legal, { recursive: true });
await cp(resolve(root, 'licenses'), legal, { recursive: true });
await rm(output, { recursive: true, force: true });
await rename(staging, output);
console.log(`Bundled Paseo ${metadata.version}: ${manifest.files.length} files, ${manifest.files.reduce((n, f) => n + f.size, 0)} bytes`);
