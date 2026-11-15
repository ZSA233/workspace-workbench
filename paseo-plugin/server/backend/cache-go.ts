import { access, lstat, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { homedir } from 'node:os';
import type { CacheResource, CacheReference, CacheScope } from '../../shared/cache-management.ts';
import { workspaceInstanceKey } from '../../shared/workspace-lineage.ts';
import type { CacheProvider, CacheDiscoveryContext, DiscoveredCache } from './cache-provider.ts';
import { runtimeCacheRoot, runtimePath } from './runtime-layout.ts';
import { canonicalAsync, inside, WorkbenchError } from './storage.ts';
import { command } from './process.ts';

const labels = { build: { en: 'Build cache', zh: '编译缓存' }, module: { en: 'Module cache', zh: '模块缓存' } };
const reference = (context: CacheDiscoveryContext, workspace: Record<string, any>): CacheReference => ({ projectConfig: context.config.configPath,
  workspaceId: workspace.id, instance: workspaceInstanceKey(workspace as any), displayName: workspace.displayName || workspace.id });
const protectedContexts = new WeakMap<CacheDiscoveryContext, Promise<{ roots: string[]; data: string[] }>>();
const within = (path: string, root: string) => { const part = relative(root, path); return part !== '..' && !part.startsWith('../') && !isAbsolute(part); };

/** Only these known roots are admitted. Tool invocations never accept client paths. */
export async function safeGoCachePath(path: string, context: CacheDiscoveryContext): Promise<boolean> {
  if (!isAbsolute(path) || path === 'off') return false;
  const actual = await canonicalAsync(path);
  let protectedPaths = protectedContexts.get(context);
  if (!protectedPaths) {
    protectedPaths = (async () => {
      const protectedRoots = [homedir(), context.config.sourceRoot, context.config.workspaceRoot, context.config.stateRoot, context.config.recordsRoot,
        ...context.config.repositories.flatMap(repo => [join(context.config.sourceRoot, repo.path), join(context.config.sourceRoot, repo.path, '.git')]),
        ...context.workspaces.flatMap(workspace => [workspace.treePath || workspace.sourceRoot, ...(workspace.repositories || []).flatMap((repo: any) => [repo.worktreePath || repo.sourcePath, join(repo.worktreePath || repo.sourcePath || '/', '.git')])]).filter(Boolean)];
      const protectedData = [context.config.recordsRoot, join(context.config.sourceRoot, '.git'),
        ...context.config.repositories.map(repo => join(context.config.sourceRoot, repo.path, '.git')),
        ...context.workspaces.flatMap(workspace => (workspace.repositories || []).map((repo: any) => join(repo.worktreePath || repo.sourcePath || '/', '.git')))];
      const canonical = new Map<string, string>();
      for (const path of new Set([...protectedRoots, ...protectedData])) {
        if (context.signal.aborted) throw new WorkbenchError('cache_scan_cancelled', 'Cache discovery cancelled');
        canonical.set(path, await canonicalAsync(path));
      }
      return { roots: protectedRoots.map(path => canonical.get(path)!), data: protectedData.map(path => canonical.get(path)!) };
    })();
    protectedContexts.set(context, protectedPaths);
  }
  const protectedData = await protectedPaths;
  return actual !== dirname(actual) && !protectedData.roots.some(root => within(root, actual)) && !protectedData.data.some(root => within(actual, root));
}

export class GoCacheProvider implements CacheProvider {
  readonly id = 'go';
  readonly label = { en: 'Go', zh: 'Go' };
  private options: { executable?: string; env?: NodeJS.ProcessEnv; run?: typeof command };
  constructor(options: { executable?: string; env?: NodeJS.ProcessEnv; run?: typeof command } = {}) { this.options = options; }
  private env(): NodeJS.ProcessEnv { return { ...(this.options.env || process.env), GOTOOLCHAIN: 'local', GOWORK: 'off' }; }
  private async executable(context: CacheDiscoveryContext): Promise<string | undefined> {
    const directories = [...(context.config.toolchain?.runtimePaths || []).map((path: string) => runtimePath(context.config, path)), ...(this.env().PATH || '').split(delimiter), '/opt/homebrew/bin', '/usr/local/go/bin', '/usr/local/bin'];
    const candidates: string[] = this.options.executable ? [this.options.executable] : directories.flatMap((path: string) =>
      /^(go|go\.exe)$/.test(basename(path)) ? [path] : [join(path, process.platform === 'win32' ? 'go.exe' : 'go')]);
    const saved = await readdir(join(context.config.stateRoot, 'toolchains')).catch(() => []);
    for (const file of saved.filter(file => file.endsWith('.json')).slice(0, 256)) {
      try {
        const entries = JSON.parse(await readFile(join(context.config.stateRoot, 'toolchains', file), 'utf8'));
        for (const entry of Object.values(entries) as any[]) if (entry?.executables?.go) candidates.push(entry.executables.go);
      } catch { /* A broken runtime record must not hide other caches. */ }
    }
    for (const candidate of candidates) {
      if (!isAbsolute(candidate)) continue;
      // Version-manager shims can install tools as a side effect of `go env`.
      if (!this.options.executable && /[/\\]shims[/\\]/.test(candidate)) continue;
      try {
        await access(candidate, constants.X_OK); if ((await lstat(candidate)).isDirectory()) continue;
        const actual = await canonicalAsync(candidate);
        if (!this.options.executable && /^(mise|asdf|rtx)(\.exe)?$/.test(basename(actual))) continue;
        return actual;
      } catch {}
    }
    return undefined;
  }
  private async buildRoots(root: string, context: CacheDiscoveryContext, depth = 0): Promise<string[]> {
    if (context.signal.aborted) throw new WorkbenchError('cache_scan_cancelled', 'Cache discovery cancelled');
    if (depth >= 3) return [root];
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const versions = entries.filter(entry => entry.isDirectory() && /^(go\d|mixed|(?:darwin|linux|win32|windows)-)/.test(entry.name));
    if (!versions.length) return [root];
    if (versions.length > 64) context.reportDiscoveryIssue?.('Go version directory limit reached; inventory is partial');
    const nested: string[] = [];
    if (entries.some(entry => entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name))) nested.push(root);
    for (const version of versions.slice(0, 64)) nested.push(...await this.buildRoots(join(root, version.name), context, depth + 1));
    return nested;
  }
  async discover(context: CacheDiscoveryContext): Promise<DiscoveredCache[]> {
    const executable = await this.executable(context);
    let globals: Record<string, string> = {}, unavailable = executable ? '' : 'Go executable unavailable';
    if (executable) {
      try {
        const result = await (this.options.run || command)(executable, ['env', '-json', 'GOCACHE', 'GOMODCACHE', 'GOCACHEPROG'], { cwd: homedir(), env: this.env(), timeout: 5000, maxBytes: 64 * 1024, signal: context.signal });
        if (result.code !== 0) throw new Error(result.stderr);
        globals = JSON.parse(result.stdout);
      } catch (error) { unavailable = String(error).slice(0, 300); }
    }
    if (unavailable) context.reportDiscoveryIssue?.(unavailable);
    const values: DiscoveredCache[] = [];
    const add = async (kind: 'build' | 'module', path: string, scope: CacheScope, references: CacheReference[], managed = false) => {
      if (context.signal.aborted) throw new WorkbenchError('cache_scan_cancelled', 'Cache discovery cancelled');
      if (!path || !isAbsolute(path)) return;
      const safe = await safeGoCachePath(path, context);
      const displayPath = await canonicalAsync(path);
      const rawRoots = kind === 'build' && managed ? await this.buildRoots(displayPath, context) : [displayPath];
      const paths: string[] = [];
      let existing = true;
      for (const root of rawRoots) {
        const actual = await canonicalAsync(root); paths.push(actual);
        const info = await lstat(actual).catch(() => null);
        existing &&= !!info?.isDirectory() && !info.isSymbolicLink();
      }
      const external = scope === 'global' && kind === 'build' && !!globals.GOCACHEPROG;
      values.push({ kind, kindLabel: labels[kind], scope, displayPath, paths: [...new Set(paths)].sort(), references,
        cleanup: { action: 'clear', label: kind === 'build' ? { en: 'Clean build cache', zh: '清理编译缓存' } : { en: 'Clean module cache', zh: '清理模块缓存' },
          available: safe && existing && !unavailable && !external,
          ...(!safe ? { reason: 'Path overlaps protected project data' } : external ? { reason: 'External Go cache program owns this cache' } : unavailable ? { reason: unavailable } : !existing ? { reason: 'Cache directory does not exist' } : {}) } });
    };
    const globalReferences = context.config.cacheEnabled ? [] : context.workspaces.filter(workspace => workspace.state !== 'removed').map(workspace => reference(context, workspace));
    await add('build', globals.GOCACHE || this.env().GOCACHE || '', 'global', globalReferences);
    await add('module', globals.GOMODCACHE || this.env().GOMODCACHE || '', 'global', globalReferences);
    if (context.config.cacheEnabled) {
      const roots = new Map<string, CacheReference[]>();
      for (const workspace of context.workspaces) {
        if (!workspace.id || workspace.state === 'record_invalid') continue;
        const root = runtimeCacheRoot(context.config, workspace);
        roots.set(root, [...(roots.get(root) || []), reference(context, workspace)]);
      }
      // Retain visibility of caches left by removed/permanently deleted Workspaces.
      const retained = await readdir(join(context.config.cacheRoot, 'workspaces'), { withFileTypes: true }).catch(() => []);
      if (retained.length > 1000) context.reportDiscoveryIssue?.('Retained Workspace cache limit reached; inventory is partial');
      for (const entry of retained.filter(entry => entry.isDirectory()).slice(0, 1000)) {
        const root = join(context.config.cacheRoot, 'workspaces', entry.name);
        if (!roots.has(root)) roots.set(root, []);
      }
      const shared = join(context.config.cacheRoot, 'shared');
      if (!roots.has(shared) && await lstat(shared).catch(() => null)) roots.set(shared, []);
      for (const [root, references] of roots) {
        const scope = root === shared ? 'project' : 'workspace';
        await add('build', join(root, 'go-build'), scope, references, true);
        await add('module', join(root, 'go-mod'), scope, references, true);
      }
    }
    const snapshots = await readdir(join(context.config.stateRoot, 'environments')).catch(() => []);
    for (const file of snapshots.filter(file => /^snapshot-.*\.json$/.test(file)).slice(-256)) {
      if (context.signal.aborted) throw new Error('Cache discovery cancelled');
      try {
        const value = JSON.parse(await readFile(join(context.config.stateRoot, 'environments', file), 'utf8'));
        const workspace = context.workspaces.find(workspace => workspace.id === value.workspaceId);
        const refs = workspace ? [reference(context, workspace)] : [];
        for (const [kind, variable] of [['build', 'GOCACHE'], ['module', 'GOMODCACHE']] as const) {
          const path = value.environment?.variables?.[variable];
          if (typeof path === 'string') await add(kind, path, context.config.cacheScope === 'project' && inside(path, context.config.cacheRoot, true) ? 'project' : 'workspace', refs);
        }
      } catch { /* Saved descriptors may be obsolete; configured roots remain available. */ }
    }
    return values;
  }
  async cleanup(resource: CacheResource, context: CacheDiscoveryContext): Promise<void> {
    if (!['build', 'module'].includes(resource.kind) || resource.cleanup.action !== 'clear') throw new WorkbenchError('cache_action_invalid', 'Unsupported Go cleanup');
    const executable = await this.executable(context);
    if (!executable) throw new WorkbenchError('go_unavailable', 'Go executable unavailable');
    for (const [index, path] of resource.paths.entries()) {
      if (!await safeGoCachePath(path, context)) throw new WorkbenchError('cache_path_protected', 'Cache path overlaps protected data');
      if (inside(executable, path, true)) throw new WorkbenchError('cache_tool_in_use', 'The Go executable is stored inside this cache');
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || await canonicalAsync(path) !== path) throw new WorkbenchError('cache_path_changed', 'Cache root changed');
      await context.validateCleanup?.();
      const env = { ...this.env(), GOCACHEPROG: '', [resource.kind === 'build' ? 'GOCACHE' : 'GOMODCACHE']: path };
      const result = await (this.options.run || command)(executable, ['clean', resource.kind === 'build' ? '-cache' : '-modcache'], { cwd: homedir(), env, timeout: 120_000, maxBytes: 1024 * 1024, signal: context.signal });
      if (result.code !== 0) throw new WorkbenchError('cache_cleanup_failed', result.stderr.slice(0, 1000) || 'Go clean failed');
      await context.cleanupProgress?.(index + 1);
    }
  }
}
