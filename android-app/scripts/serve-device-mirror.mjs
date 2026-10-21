#!/usr/bin/env node
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const mirror = resolve(root, '../web-assets/output/device-mirror');
const server = createServer({ key: await readFile(resolve(root, '.device-fixtures/localhost-key.pem')),
  cert: await readFile(resolve(root, '.device-fixtures/localhost-cert.pem')) }, async (request, response) => {
  const pathname = new URL(request.url, 'https://localhost').pathname;
  if (pathname === '/latest.json' || pathname === '/slow/latest.json') {
    const metadata = JSON.parse(await readFile(resolve(mirror, 'latest.json'), 'utf8'));
    if (pathname.startsWith('/slow/')) metadata.dist.tarball = new URL('/slow/server-0.12.0.tgz', metadata.dist.tarball).href;
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(metadata));
  } else if (pathname === '/server-0.12.0.tgz' || pathname === '/slow/server-0.12.0.tgz') {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 16205528 });
    const stream = createReadStream(resolve(mirror, 'server-0.12.0.tgz'), { highWaterMark: 64 * 1024 });
    let resume;
    if (pathname.startsWith('/slow/')) {
      stream.on('data', chunk => {
        stream.pause(); response.write(chunk, () => { resume = setTimeout(() => stream.resume(), 150); });
      });
      stream.on('end', () => response.end());
    } else stream.pipe(response);
    stream.on('error', () => response.destroy());
    response.on('close', () => { clearTimeout(resume); stream.destroy(); });
  } else { response.writeHead(404); response.end(); }
});
server.listen(19443, '127.0.0.1', () => console.log('Isolated signed update mirror listening on 127.0.0.1:19443'));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
