#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { androidRoot, readVersion, parseMetadata, releaseTag, compareVersions } from './version.mjs';

const repository = resolve(androidRoot, '..');
export function command(program, args, options = {}) {
  return execFileSync(program, args, { encoding: 'utf8', cwd: repository, timeout: 120000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}
export function validateTag(tag, metadata) {
  if (tag !== releaseTag(metadata.versionName)) throw new Error('Release tag does not match Android version.properties');
  return tag;
}
function validateRepository(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('GITHUB_REPOSITORY must be OWNER/REPO');
  return repo;
}
export function existingRelease(repo, tag, run = command) {
  validateRepository(repo);
  // REST's by-tag endpoint omits draft releases, even when the tag exists.
  const [owner, name] = repo.split('/');
  const query = 'query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){databaseId isDraft tagName url}}}';
  const result = JSON.parse(run('gh', ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `tag=${tag}`]));
  if (result.errors || !result.data?.repository) throw new Error('GitHub did not confirm repository release state');
  const release = result.data.repository.release;
  return release ? { id: release.databaseId, draft: release.isDraft, tag_name: release.tagName, html_url: release.url } : null;
}
export async function preflight({ tag, repo = process.env.GITHUB_REPOSITORY, root = repository, run = command }) {
  const metadata = await readVersion(join(root, 'android-app'));
  validateTag(tag, metadata); validateRepository(repo);
  const git = args => run('git', args, { cwd: root });
  const commit = git(['rev-parse', 'HEAD']);
  if (git(['rev-parse', `refs/tags/${tag}^{commit}`]) !== commit) throw new Error('Checkout does not match the release tag');
  git(['fetch', '--no-tags', 'origin', 'main']);
  git(['merge-base', '--is-ancestor', commit, 'FETCH_HEAD']);
  const tags = git(['tag', '--list', 'android-v*']).split('\n').filter(Boolean);
  for (const previous of tags) {
    if (!/^android-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(previous) || previous === tag) continue;
    const order = compareVersions(previous.slice(9), metadata.versionName);
    if (order > 0) throw new Error('A newer Android release tag already exists');
    const earlier = parseMetadata(git(['show', `${previous}:android-app/version.properties`]));
    validateTag(previous, earlier);
    if (earlier.versionCode >= metadata.versionCode) throw new Error('versionCode must exceed every earlier Android release');
  }
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Release checkout contains tracked changes');
  const release = existingRelease(repo, tag, run);
  if (release && !release.draft) throw new Error('This Android version is already public and will not be overwritten');
  return { ...metadata, tag, commit, resumingDraft: Boolean(release) };
}
export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function apkIdentity(badging, certificate, expected, fingerprint) {
  const info = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m.exec(badging);
  const signers = [...certificate.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})$/gm)];
  if (!info || info[1] !== 'dev.paseo.pocket' || Number(info[2]) !== expected.versionCode || info[3] !== expected.versionName)
    throw new Error('APK package or version does not match release metadata');
  if (signers.length !== 1 || signers[0][1].toLowerCase() !== fingerprint)
    throw new Error('APK signing certificate differs from the persistent release identity');
}
export async function packageRelease({ root = repository, output = join(root, 'android-app/artifacts/release'), run = command } = {}) {
  const base = join(root, 'android-app'), metadata = await readVersion(base);
  const apk = join(base, 'app/build/outputs/apk/release/app-release.apk');
  const fingerprint = (await readFile(join(base, 'signing-certificate.sha256'), 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid public signing certificate pin');
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('ANDROID_HOME is required for APK verification');
  const tools = join(sdk, 'build-tools/36.0.0');
  const signed = run(join(tools, 'apksigner'), ['verify', '--print-certs', apk]);
  apkIdentity(run(join(tools, 'aapt'), ['dump', 'badging', apk]), signed, metadata, fingerprint);
  run('python3', [join(base, 'scripts/verify-apk.py'), apk]);
  await mkdir(output, { recursive: true });
  const name = `paseo-pocket-${metadata.versionName}.apk`;
  await copyFile(apk, join(output, name));
  const bundle = JSON.parse(await readFile(join(base, 'app/src/main/assets/paseo/_workbench.json'), 'utf8'));
  const manifest = { schemaVersion: 1, applicationId: 'dev.paseo.pocket', ...metadata,
    tag: releaseTag(metadata.versionName), sourceCommit: run('git', ['rev-parse', 'HEAD'], { cwd: root }),
    automationCommit: run('git', ['rev-parse', 'HEAD'], { cwd: repository }),
    apk: name, sha256: await sha256(join(output, name)), certificateSha256: fingerprint,
    webVersion: bundle.metadata.version, webAssetCount: bundle.files.length };
  await writeFile(join(output, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(output, 'SHA256SUMS'), `${manifest.sha256}  ${name}\n${await sha256(join(output, 'release.json'))}  release.json\n`);
  await writeFile(join(output, 'release-notes.md'), `Paseo Pocket ${metadata.versionName}（versionCode ${metadata.versionCode}）\n\n` +
    `面向 Paseo 的社区 Android 薄壳。完整本地网页、路径标志贴边工具及手动网页更新。\n\n` +
    `- Android 8 / API 26 起，完整网页需要 Chromium 100+ 的系统 WebView。\n` +
    `- 内置 Paseo Web ${manifest.webVersion}；源码提交：\`${manifest.sourceCommit}\`。\n` +
    `- 已安装 Paseo Pocket 的用户可直接覆盖升级，保留配对和设置。\n` +
    `- APK SHA-256：\`${manifest.sha256}\`。\n` +
    `- 签名证书 SHA-256：\`${fingerprint}\`。\n\n请下载下方 APK；校验文件与版本清单一同提供。\n`);
  return manifest;
}
export async function verifyArtifacts(output, metadata) {
  const manifest = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
  const name = `paseo-pocket-${metadata.versionName}.apk`;
  if (manifest.apk !== name || manifest.versionName !== metadata.versionName || manifest.versionCode !== metadata.versionCode ||
      manifest.tag !== releaseTag(metadata.versionName) || manifest.sha256 !== await sha256(join(output, name)))
    throw new Error('Release artifacts do not match the tagged version');
  const sums = `${manifest.sha256}  ${name}\n${await sha256(join(output, 'release.json'))}  release.json\n`;
  if (await readFile(join(output, 'SHA256SUMS'), 'utf8') !== sums) throw new Error('Release checksum file does not match artifacts');
  return { manifest, files: [name, 'SHA256SUMS', 'release.json'] };
}
export async function publishRelease({ tag, repo = process.env.GITHUB_REPOSITORY, root = repository,
  output = join(root, 'android-app/artifacts/release'), run = command }) {
  const metadata = await readVersion(join(root, 'android-app'));
  validateTag(tag, metadata); validateRepository(repo);
  const { manifest, files } = await verifyArtifacts(output, metadata);
  const commit = run('git', ['rev-parse', `refs/tags/${tag}^{commit}`], { cwd: root });
  if (manifest.sourceCommit !== commit) throw new Error('Artifacts were built from a different commit');
  const remote = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: root });
  const refs = Object.fromEntries(remote.split('\n').filter(Boolean).map(row => { const [sha, ref] = row.split(/\s+/); return [ref, sha]; }));
  if ((refs[`refs/tags/${tag}^{}`] ?? refs[`refs/tags/${tag}`]) !== commit) throw new Error('Remote release tag changed during the build');
  const release = existingRelease(repo, tag, run);
  if (release && !release.draft) throw new Error('Public releases cannot be overwritten');
  const gh = args => run('gh', [...args, '--repo', repo]);
  if (!release) gh(['release', 'create', tag, '--draft', '--verify-tag', '--latest=false', '--title', `Paseo Pocket ${metadata.versionName}`,
    '--notes-file', join(output, 'release-notes.md')]);
  gh(['release', 'upload', tag, ...files.map(file => join(output, file)), '--clobber']);
  // Verify GitHub's stored bytes while still a draft, before making them public.
  const downloaded = await mkdtemp(join(tmpdir(), 'pocket-draft-check-'));
  try {
    gh(['release', 'download', tag, '--dir', downloaded, ...files.flatMap(file => ['--pattern', file])]);
    for (const file of files) if (await sha256(join(downloaded, file)) !== await sha256(join(output, file)))
      throw new Error('Uploaded draft artifact differs from the verified build');
  } finally { await rm(downloaded, { recursive: true, force: true }); }
  // Another run may have completed while this run was transferring assets.
  if (!existingRelease(repo, tag, run)?.draft) throw new Error('Release is no longer a draft; refusing further changes');
  gh(['release', 'edit', tag, '--draft=false', '--latest=false', '--notes-file', join(output, 'release-notes.md')]);
  const result = existingRelease(repo, tag, run);
  if (!result || result.draft) throw new Error('GitHub did not confirm the public release');
  return result.html_url;
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { tag: { type: 'string' }, output: { type: 'string' }, 'source-root': { type: 'string' } } });
  if (positionals.length !== 1) throw new Error('Use preflight, package, or publish');
  const tag = values.tag ?? process.env.RELEASE_TAG, output = values.output ? resolve(values.output) : undefined;
  const root = values['source-root'] ? resolve(values['source-root']) : undefined;
  if (positionals[0] === 'preflight') console.log(JSON.stringify(await preflight({ tag, root }), null, 2));
  else if (positionals[0] === 'package') console.log(JSON.stringify(await packageRelease({ output, root }), null, 2));
  else if (positionals[0] === 'publish') console.log(await publishRelease({ tag, output, root }));
  else throw new Error('Use preflight, package, or publish');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(`Android release: ${error.message}`); process.exitCode = 1; });
