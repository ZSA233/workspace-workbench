#!/usr/bin/env node
// Isolated HTTPS fixture: original signed public APK, mixed releases and controlled transfer failures.
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const base = fileURLToPath(new URL('../', import.meta.url));
const assets = resolve(base, process.env.POCKET_TEST_UPDATE_ASSETS || 'artifacts/release');
const manifest = JSON.parse(await readFile(resolve(assets, 'release.json'), 'utf8'));
const archive = resolve(assets, manifest.apk);
const bytes = await readFile(archive);
if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw Error('Fixture APK digest mismatch');
const repository = process.env.POCKET_TEST_UPDATE_REPOSITORY || 'ZSA233/workspace-workbench';
const release = { tag_name: manifest.tag, draft: false, prerelease: false, body: 'Original signed Pocket integration fixture',
  assets: [manifest.apk, 'release.json', 'SHA256SUMS'].map(name => ({ name, state: 'uploaded',
    size: name === manifest.apk ? bytes.length : 1024,
    browser_download_url: `https://github.com/${repository}/releases/download/${manifest.tag}/${name}` })) };
const server = createServer({ key: await readFile(resolve(base, '.device-fixtures/localhost-key.pem')),
  cert: await readFile(resolve(base, '.device-fixtures/localhost-cert.pem')) }, async (request, response) => {
  try {
    const path = new URL(request.url, 'https://localhost').pathname;
    if (path.startsWith('/offline/')) { response.writeHead(503); response.end(); }
    else if (path.endsWith('/releases')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify([{ tag_name: 'v99.0.0', draft: false, prerelease: false, assets: [] }, release,
        { ...release, tag_name: 'android-v99.0.0', draft: true }]));
    } else if (path.endsWith('/' + manifest.apk)) {
      response.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': bytes.length });
      let stream = createReadStream(archive, { highWaterMark: 64 * 1024 });
      if (path.startsWith('/corrupt/')) {
        let first = true;
        stream = stream.pipe(new Transform({ transform(chunk, _, next) {
          if (first) { chunk[0] ^= 1; first = false; } next(null, chunk);
        } }));
      }
      let timer;
      if (path.startsWith('/slow/')) {
        stream.on('data', chunk => { stream.pause(); response.write(chunk, () => { timer = setTimeout(() => stream.resume(), 70); }); });
        stream.on('end', () => response.end());
      } else stream.pipe(response);
      stream.on('error', () => response.destroy());
      response.on('close', () => { clearTimeout(timer); stream.destroy(); });
    } else if (path.endsWith('/release.json') || path.endsWith('/SHA256SUMS')) {
      response.writeHead(200); response.end(await readFile(resolve(assets, path.endsWith('/release.json') ? 'release.json' : 'SHA256SUMS')));
    } else { response.writeHead(404); response.end(); }
  } catch { response.destroy(); }
});
server.listen(19446, '127.0.0.1', () => console.log('Pocket update fixture listening on 127.0.0.1:19446'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
