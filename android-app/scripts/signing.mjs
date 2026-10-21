#!/usr/bin/env node
import { readFile, writeFile, mkdir, mkdtemp, rm, appendFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, basename, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { androidRoot } from './version.mjs';

export const secretNames = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];
export function parseProperties(text) {
  const result = {}; let pending = '';
  const decode = value => value.replace(/\\(u[0-9a-fA-F]{4}|[^])/g, (_, x) => x[0] === 'u' && x.length === 5
    ? String.fromCharCode(parseInt(x.slice(1), 16)) : ({ n: '\n', r: '\r', t: '\t', f: '\f' }[x] ?? x));
  for (let row of text.split(/\r\n|\n|\r/)) {
    if (!pending && /^\s*(?:[#!]|$)/.test(row)) continue;
    row = pending + row.replace(/^\s+/, '');
    const tail = row.match(/\\+$/)?.[0].length ?? 0;
    if (tail % 2) { pending = row.slice(0, -1); continue; }
    pending = '';
    const match = /^([^\s=:]+)(?:\s*[=:]\s*|\s+)(.*)$/.exec(row);
    if (!match || Object.hasOwn(result, match[1])) throw new Error('Invalid or duplicate signing property');
    result[match[1]] = decode(match[2]);
  }
  if (pending) throw new Error('Unfinished signing property');
  return result;
}
export function serializeProperties(values) {
  const escape = value => [...String(value)].map(c => {
    if (c === '\\') return '\\\\';
    if (c === ' ') return '\\ ';
    const named = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\f': '\\f' }[c];
    if (named) return named;
    return c.charCodeAt(0) > 127 ? [...c].flatMap(x => {
      const n = x.codePointAt(0);
      return n <= 65535 ? [`\\u${n.toString(16).padStart(4, '0')}`] :
        [n - 65536].flatMap(v => [0xd800 + (v >> 10), 0xdc00 + (v & 1023)].map(u => `\\u${u.toString(16).padStart(4, '0')}`));
    }).join('') : c;
  }).join('');
  return Object.entries(values).map(([key, value]) => `${key}=${escape(value)}\n`).join('');
}
const keytool = () => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'keytool') : 'keytool';
export function certificateDigest(storeFile, values) {
  try {
    const der = execFileSync(keytool(), ['-exportcert', '-keystore', storeFile, '-alias', values.keyAlias,
      '-storepass:env', 'POCKET_PRIVATE_STORE_PASSWORD'], { env: { ...process.env, POCKET_PRIVATE_STORE_PASSWORD: values.storePassword },
      timeout: 30000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return createHash('sha256').update(der).digest('hex');
  } catch { throw new Error('Cannot read signing certificate; check the private signing configuration'); }
}
export async function configure({ repo, properties, dryRun = false, writeCertificate = false }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('--repo OWNER/REPO is required');
  const path = properties ?? process.env.PASEO_POCKET_SIGNING_PROPERTIES ?? join(homedir(), '.config/paseo-pocket/android-signing.properties');
  const values = parseProperties(await readFile(path, 'utf8'));
  for (const field of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'])
    if (!values[field]) throw new Error(`Missing signing property: ${field}`);
  const storeFile = isAbsolute(values.storeFile) ? values.storeFile : resolve(androidRoot, 'app', values.storeFile);
  if ((await stat(storeFile)).size > 32 * 1024) throw new Error('Keystore exceeds the supported GitHub secret size');
  const fingerprint = certificateDigest(storeFile, values), pin = join(androidRoot, 'signing-certificate.sha256');
  if (writeCertificate && !dryRun) await writeFile(pin, `${fingerprint}\n`);
  if (!writeCertificate && (await readFile(pin, 'utf8')).trim() !== fingerprint)
    throw new Error('Signing certificate differs from the public pin; forks can explicitly use --write-certificate');
  if (!dryRun) {
    const secrets = [ (await readFile(storeFile)).toString('base64'), values.storePassword, values.keyAlias, values.keyPassword ];
    for (let i = 0; i < secretNames.length; i++) {
      try { execFileSync('gh', ['secret', 'set', secretNames[i], '--repo', repo], {
        input: secrets[i], timeout: 60000, maxBuffer: 128 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { throw new Error(`Unable to configure ${secretNames[i]}; rerun to complete configuration`); }
    }
  }
  return { repository: repo, certificateSha256: fingerprint, secrets: secretNames, uploaded: !dryRun };
}
export async function restoreSigning(environment = process.env, parent = environment.RUNNER_TEMP ?? tmpdir()) {
  for (const name of secretNames) if (!environment[name]) throw new Error(`Configure repository secret ${name} before release`);
  const encoded = environment.ANDROID_KEYSTORE_BASE64.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 48 * 1024 || encoded.length % 4)
    throw new Error('Invalid encoded signing keystore');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('Invalid encoded signing keystore');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'paseo-pocket-signing-'));
  try {
    const storeFile = join(directory, 'release.p12'), config = join(directory, 'signing.properties');
    await writeFile(storeFile, bytes, { mode: 0o600, flag: 'wx' });
    await writeFile(config, serializeProperties({ storeFile, storePassword: environment.ANDROID_STORE_PASSWORD,
      keyAlias: environment.ANDROID_KEY_ALIAS, keyPassword: environment.ANDROID_KEY_PASSWORD }), { mode: 0o600, flag: 'wx' });
    await writeFile(join(directory, '.owned'), 'paseo-pocket-signing\n', { mode: 0o600, flag: 'wx' });
    return { directory, config };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
export async function cleanupSigning(directory, parent = process.env.RUNNER_TEMP ?? tmpdir()) {
  if (!directory) return;
  if (dirname(resolve(directory)) !== resolve(parent) || !basename(directory).startsWith('paseo-pocket-signing-') ||
      await readFile(join(directory, '.owned'), 'utf8') !== 'paseo-pocket-signing\n') throw new Error('Signing directory ownership check failed');
  await rm(directory, { recursive: true });
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { repo: { type: 'string' }, properties: { type: 'string' },
    'dry-run': { type: 'boolean' }, 'write-certificate': { type: 'boolean' } } });
  if (positionals.length !== 1) throw new Error('Use configure, restore, or cleanup');
  if (positionals[0] === 'configure') console.log(JSON.stringify(await configure({ repo: values.repo, properties: values.properties,
    dryRun: values['dry-run'], writeCertificate: values['write-certificate'] }), null, 2));
  else if (positionals[0] === 'restore') {
    if (!process.env.GITHUB_ENV) throw new Error('restore is intended for the GitHub Actions runner');
    const result = await restoreSigning();
    await appendFile(process.env.GITHUB_ENV, `PASEO_POCKET_SIGNING_PROPERTIES=${result.config}\nPASEO_POCKET_SIGNING_DIRECTORY=${result.directory}\n`);
    console.log('Private signing files restored outside the checkout.');
  } else if (positionals[0] === 'cleanup') await cleanupSigning(process.env.PASEO_POCKET_SIGNING_DIRECTORY);
  else throw new Error('Use configure, restore, or cleanup');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(`Android signing: ${error.message}`); process.exitCode = 1; });
