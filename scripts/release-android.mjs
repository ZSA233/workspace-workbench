#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readVersion, parseMetadata, nextVersion, writeVersion, releaseTag } from '../android-app/scripts/version.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function hasLocalTag(root, tag) {
  try { git(root, ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`]); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}
function remoteTag(root, tag) {
  try { return git(root, ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`]); }
  catch (error) { if (error.status === 2) return ''; throw error; }
}
export async function prepareRelease({ root = repository, version, publish = false }) {
  const base = join(root, 'android-app');
  const baseline = parseMetadata(git(root, ['show', 'HEAD:android-app/version.properties']));
  const planned = nextVersion(baseline, version), current = await readVersion(base), tag = releaseTag(version);
  const dirty = [...new Set([
    ...git(root, ['diff', '--name-only', '-z', 'HEAD', '--']).split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))];
  if (dirty.some(path => path !== 'android-app/version.properties')) throw new Error('Commit other changes before preparing an Android release');
  if (![baseline, planned].some(v => v.versionName === current.versionName && v.versionCode === current.versionCode))
    throw new Error('Existing version edits do not match this release; refusing to overwrite them');
  if (publish) {
    if (git(root, ['branch', '--show-current']) !== 'main') throw new Error('Publish Android releases from main');
    git(root, ['fetch', '--no-tags', 'origin', 'main']);
    try { git(root, ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD']); }
    catch { throw new Error('Remote main has advanced; synchronize main before publishing'); }
    if (hasLocalTag(root, tag) || remoteTag(root, tag)) throw new Error(`Tag ${tag} already exists; use Actions to retry that tag`);
  }
  await writeVersion(base, planned);
  if (!publish) return { ...planned, tag, published: false };
  if (git(root, ['diff', 'HEAD', '--', 'android-app/version.properties'])) {
    git(root, ['add', '--', 'android-app/version.properties']);
    git(root, ['commit', '-m', `chore(android): release ${version}`, '--', 'android-app/version.properties']);
  }
  const commit = git(root, ['rev-parse', 'HEAD']);
  git(root, ['tag', '-a', tag, '-m', `Paseo Pocket ${version}`]);
  const tagObject = git(root, ['rev-parse', `refs/tags/${tag}`]);
  try { git(root, ['push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`]); }
  catch (error) {
    // Retire only the tag created by this invocation, and only after confirming
    // the remote did not receive it. Keep the version commit for a safe retry.
    try {
      if (!remoteTag(root, tag) && git(root, ['rev-parse', `refs/tags/${tag}`]) === tagObject)
        git(root, ['tag', '-d', tag]);
    } catch { /* An uncertain push result must be inspected instead of replayed. */ }
    throw new Error(`Push did not complete. The version commit is retained; inspect remote ${tag} before retrying. ${error.stderr?.toString().trim() ?? ''}`);
  }
  return { ...planned, tag, commit, published: true };
}

async function main() {
  const { values } = parseArgs({ options: { version: { type: 'string' }, publish: { type: 'boolean', default: false } } });
  if (!values.version) throw new Error('Usage: node scripts/release-android.mjs --version 0.1.2 [--publish]');
  const result = await prepareRelease({ version: values.version, publish: values.publish });
  console.log(JSON.stringify(result, null, 2));
  console.log(result.published ? 'Tag pushed. Follow the Android release workflow on GitHub.' : 'Version prepared only. Review the change; add --publish to commit, tag and push.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(`Android release: ${error.message}`); process.exitCode = 1; });
