import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

let built;
const sourceRoot = process.env.COMMUNICATIONS_SERVICE_DIR || resolve(import.meta.dirname, '../../../../communications-service');
export function serviceAvailable() {
  return process.env.COMMUNICATIONS_TEST_BINARY ? existsSync(process.env.COMMUNICATIONS_TEST_BINARY) : existsSync(join(sourceRoot, 'go.mod'));
}
export function serviceBinary() {
  if (process.env.COMMUNICATIONS_TEST_BINARY) return process.env.COMMUNICATIONS_TEST_BINARY;
  if (built) return built.path;
  const directory = mkdtempSync(join(tmpdir(), 'communications-go-binary-'));
  const path = join(directory, 'project-communications');
  const result = spawnSync('go', ['build', '-o', path, './cmd/project-communications'], {
    cwd: sourceRoot, encoding: 'utf8', timeout: 180000,
  });
  if (result.status !== 0) { rmSync(directory, { recursive: true, force: true }); throw Error(result.stderr || result.error?.message || 'Go service build failed'); }
  built = { path, directory };
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  return path;
}
export async function startService(home) {
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => {
      const port = server.address().port; server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
  const child = spawn(serviceBinary(), ['serve', '--home', home, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-32768); }); child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-32768); });
  const exit = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolveExit({ code, signal })); });
  const started = Date.now();
  try {
    while (!stdout.includes('communications-service-ready')) {
      if (child.exitCode !== null || Date.now() - started > 15000) throw Error('Go service did not become ready: ' + stderr);
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
  } catch (error) { child.kill('SIGKILL'); await exit; throw error; }
  const service = { child, url: `http://127.0.0.1:${port}`, token: readFileSync(join(home, 'api-token'), 'utf8').trim(),
    async request(path, method = 'GET', input) {
      const response = await fetch(service.url + path, { method, headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10000) });
      const result = await response.json(); if (!response.ok) throw Error(result.error); return result;
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000); try { const result = await exit; if (result.code !== 0) throw Error('Go service exit failed: ' + JSON.stringify(result) + ' ' + stderr); } finally { clearTimeout(timer); }
    },
  };
  return service;
}
export async function until(read, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!(await read())) { if (Date.now() >= end) throw Error('condition timed out'); await new Promise(resolveWait => setTimeout(resolveWait, 25)); }
}
