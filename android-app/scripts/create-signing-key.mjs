#!/usr/bin/env node
import { mkdir, writeFile, access, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const directory = resolve(process.argv[2] ?? join(homedir(), '.config/paseo-pocket'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const storeFile = join(directory, 'android-release.p12');
const config = join(directory, 'android-signing.properties');
for (const file of [storeFile, config]) {
  try { await access(file); throw new Error(`Already exists; keep this key for upgrades: ${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const password = randomBytes(32).toString('hex');
execFileSync('keytool', ['-genkeypair', '-keystore', storeFile, '-storetype', 'PKCS12',
  '-alias', 'workbench', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
  '-dname', 'CN=Paseo Pocket', '-storepass:env', 'WB_SIGNING_PASSWORD',
  '-keypass:env', 'WB_SIGNING_PASSWORD'], { env: { ...process.env, WB_SIGNING_PASSWORD: password }, stdio: 'pipe' });
await chmod(storeFile, 0o600);
const escaped = storeFile.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
await writeFile(config, `storeFile=${escaped}\nstorePassword=${password}\nkeyAlias=workbench\nkeyPassword=${password}\n`, { mode: 0o600, flag: 'wx' });
console.log(`Signing key created outside the repository. Back up this directory securely: ${directory}`);
console.log(`PASEO_POCKET_SIGNING_PROPERTIES=${config}`);
