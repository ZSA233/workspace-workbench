#!/usr/bin/env node
// Test CA is trusted ONLY for localhost in debug builds. Never included in release.
import { mkdir, access, writeFile, copyFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = resolve(root, '.device-fixtures');
const res = resolve(root, 'build/device-fixtures/res');
await mkdir(fixture, { recursive: true, mode: 0o700 });
await mkdir(resolve(res, 'raw'), { recursive: true });
await mkdir(resolve(res, 'xml'), { recursive: true });
const cert = resolve(fixture, 'localhost-cert.pem'); const key = resolve(fixture, 'localhost-key.pem');
try { await access(cert); await access(key); }
catch {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
    '-keyout', key, '-out', cert, '-subj', '/CN=localhost/O=Paseo Pocket Device Test',
    '-addext', 'subjectAltName=DNS:localhost', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'pipe' });
  await chmod(key, 0o600);
}
await copyFile(cert, resolve(res, 'raw/pocket_test_ca.pem'));
await writeFile(resolve(res, 'xml/pocket_debug_network.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /></trust-anchors></base-config>
  <domain-config cleartextTrafficPermitted="false"><domain includeSubdomains="false">localhost</domain>
    <trust-anchors><certificates src="@raw/pocket_test_ca" /><certificates src="system" /></trust-anchors>
  </domain-config>
</network-security-config>
`);
console.log('Prepared localhost-only debug test certificate');
