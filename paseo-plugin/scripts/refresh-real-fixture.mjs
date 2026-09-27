import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, cp, symlink, access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function createRealRefreshFixture(root, recordPath) {
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  const sourceRoot = join(root, 'sources'); await mkdir(sourceRoot, { recursive: true });
  const repositories = [], baseRefs = {}, evidence = [];
  for (const repo of record.repositories) {
    const source = repo.sourcePath, path = join(sourceRoot, repo.repoPath);
    await mkdir(resolve(path, '..'), { recursive: true });
    const run = (directory, args) => exec('git', ['-C', directory, ...args], { timeout: 60000, maxBuffer: 16*1024*1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    const head = (await run(repo.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
    // All writes are under the owned destination. Shared objects are read-only.
    try { await access(join(path, '.git')); } catch {
      await mkdir(path, { recursive: true });
      await exec('git', ['clone', '--mirror', '--shared', '-q', source, join(path, '.git')], { timeout: 180000 });
    }
    await exec('git', ['--git-dir', join(path, '.git'), 'config', 'core.bare', 'false']);
    await exec('git', ['--git-dir', join(path, '.git'), 'config', 'core.worktree', path]);
    await run(path, ['config', 'core.hooksPath', '/dev/null']);
    await run(path, ['config', 'filter.lfs.required', 'false']);
    await run(path, ['config', 'filter.lfs.process', '']);
    await run(path, ['config', 'filter.lfs.smudge', '']);
    const refs = (await run(source, ['for-each-ref', '--format=%(objectname) %(refname)'])).stdout.trim().split('\n').filter(Boolean);
    await run(path, ['config', 'user.name', 'Workbench Verification']); await run(path, ['config', 'user.email', 'verify@example.invalid']);
    await exec('git', ['-C', path, 'checkout', '--detach', '-q', head], { timeout: 180000, maxBuffer: 1024*1024, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });
    console.log(JSON.stringify({ prepared: repo.repoPath, refs: refs.length }));
    repositories.push({ id: repo.id || repo.repoPath, path: repo.repoPath }); baseRefs[repo.repoPath] = head;
    evidence.push({ repository: repo.repoPath, refs: refs.length, head, sharedObjectsReadOnly: true });
  }
  const config = join(root, 'project.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, project: { id: 'refresh-real', displayName: 'Isolated real-history refresh' }, sourceRoot,
    stateRoot: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), socketPath: 'auto', repositories, discovery: { mode: 'manual' }, management: { enabled: true }, limits: { gitTimeoutSeconds: 30 } }));
  return { root, config, repositories, baseRefs, evidence };
}
export async function pluginFingerprint(source) {
  const hash = createHash('sha256');
  async function walk(directory, prefix = '') {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (['node_modules','.local','.git'].includes(entry.name)) continue;
      const path = join(directory, entry.name), name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path,name);
      else if (entry.isFile()) { hash.update(name); hash.update(await readFile(path)); }
    }
  }
  await walk(source); return hash.digest('hex').slice(0,16);
}
export async function freezePlugin(source, destination) {
  source = resolve(source); destination = resolve(destination);
  const before = await pluginFingerprint(source);
  await cp(source, destination, { recursive: true, filter: path => !/(?:^|\/)(?:node_modules|\.local|\.git)(?:\/|$)/.test(path.slice(source.length)) });
  await symlink(join(source, 'node_modules'), join(destination, 'node_modules'), 'dir');
  if (before !== await pluginFingerprint(source)) throw Error('Plugin source changed during snapshot preparation');
  await writeFile(join(destination, 'verification-build.json'), JSON.stringify({ build: before }));
  return before;
}
export function distribution(values) {
  const sorted = values.slice().sort((a,b) => a-b);
  return { samples: values.length, p50Ms: sorted[Math.ceil(sorted.length*.5)-1], p95Ms: sorted[Math.ceil(sorted.length*.95)-1], maxMs: sorted.at(-1) };
}
