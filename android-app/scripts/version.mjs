#!/usr/bin/env node
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

export const androidRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function parseVersion(value) {
  if (typeof value !== 'string' || !pattern.test(value) || value.length > 60)
    throw new Error('Android version must be MAJOR.MINOR.PATCH, without a prefix or leading zeros');
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Android version component is too large');
  return parts;
}
export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
export function validateMetadata(value) {
  parseVersion(value.versionName);
  if (!Number.isSafeInteger(value.versionCode) || value.versionCode < 1 || value.versionCode > 2100000000)
    throw new Error('Android versionCode must be an integer from 1 to 2100000000');
  return { versionName: value.versionName, versionCode: value.versionCode };
}
export function parseMetadata(text) {
  const result = {}, seen = new Set();
  for (const row of text.split(/\r?\n/)) {
    if (!row.trim() || row.trimStart().startsWith('#')) continue;
    const match = /^(versionName|versionCode)=([^\r\n]+)$/.exec(row);
    if (!match || seen.has(match[1])) throw new Error('Invalid or duplicate Android version property');
    seen.add(match[1]); result[match[1]] = match[2];
  }
  if (!/^[1-9]\d*$/.test(result.versionCode ?? '')) throw new Error('Invalid Android versionCode');
  return validateMetadata({ versionName: result.versionName, versionCode: Number(result.versionCode) });
}
export const readVersion = async (base = androidRoot) => parseMetadata(await readFile(join(base, 'version.properties'), 'utf8'));
export function nextVersion(current, requested) {
  validateMetadata(current);
  const order = compareVersions(requested, current.versionName);
  if (order < 0) throw new Error('Android releases cannot move backwards');
  return validateMetadata({ versionName: requested, versionCode: current.versionCode + (order > 0 ? 1 : 0) });
}
export function bumpedVersion(current, level) {
  const parts = parseVersion(current);
  const i = ['major', 'minor', 'patch'].indexOf(level);
  if (i < 0) throw new Error('Bump must be major, minor or patch');
  parts[i]++; for (let j = i + 1; j < 3; j++) parts[j] = 0;
  const value = parts.join('.'); parseVersion(value); return value;
}
export async function writeVersion(base, value) {
  validateMetadata(value);
  const path = join(base, 'version.properties'), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `versionName=${value.versionName}\nversionCode=${value.versionCode}\n`, { flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export const releaseTag = value => { parseVersion(value); return `android-v${value}`; };

async function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, set: { type: 'string' }, bump: { type: 'string' },
    tag: { type: 'string' }, json: { type: 'boolean' } } });
  if ([values.check, values.set !== undefined, values.bump !== undefined].filter(Boolean).length !== 1)
    throw new Error('Use exactly one of --check, --set VERSION, or --bump patch|minor|major');
  const current = await readVersion();
  const result = values.check ? current : nextVersion(current, values.set ?? bumpedVersion(current.versionName, values.bump));
  if (values.tag !== undefined && values.tag !== releaseTag(result.versionName)) throw new Error('Android tag does not match version.properties');
  if (!values.check) await writeVersion(androidRoot, result);
  console.log(values.json ? JSON.stringify(result) : `Android ${result.versionName} / ${result.versionCode} (${releaseTag(result.versionName)})`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(`Android version: ${error.message}`); process.exitCode = 1; });
