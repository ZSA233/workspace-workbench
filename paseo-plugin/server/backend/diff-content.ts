import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { Git, withBackgroundGit } from './git.ts';
import { validateDiffPath } from './file-diff.ts';
import { canonical, stable, WorkbenchError, type Json } from './storage.ts';
import type { Workspaces } from './workspaces.ts';
import type { ObservationCache } from './cache.ts';
import type { ObservationScheduler } from './observation-scheduler.ts';

export class DiffContent {
  private workspaces: Workspaces;
  private cache: ObservationCache;
  private scheduler: ObservationScheduler;
  constructor(workspaces: Workspaces, cache: ObservationCache, scheduler: ObservationScheduler) { this.workspaces = workspaces; this.cache = cache; this.scheduler = scheduler; }
  identify(params: Json) {
    if (typeof params.path !== 'string' || !params.path) throw new WorkbenchError('path_required', 'Diff path is required');
    validateDiffPath(params.path);
    if (params.oldPath != null && typeof params.oldPath !== 'string') throw new WorkbenchError('path_invalid', 'Previous path must be a string');
    if (params.oldPath) validateDiffPath(params.oldPath);
    const workspace = this.workspaces.get(String(params.workspaceId || ''));
    const repo = this.workspaces.repository(workspace, params.repoPath || params.repositoryId || '');
    const path = canonical(repo.worktreePath || repo.sourcePath);
    const scope = String(params.scope || 'branch');
    if (scope === 'commit' && (typeof params.commitSha !== 'string' || !params.commitSha)) throw new WorkbenchError('commit_required', 'Commit is required');
    if (!['working', 'branch', 'commit'].includes(scope)) throw new WorkbenchError('scope_invalid', 'Unsupported diff scope');
    const token = this.scheduler.token(path, scope === 'working' ? 'working' : 'refs');
    const immutable = scope === 'commit' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(String(params.commitSha || ''));
    const identity = stable({ workspace: workspace.id, repository: path, record: repo, scope, path: params.path, oldPath: params.oldPath || null, commit: params.commitSha || null });
    return { workspace, repo, path, scope, token, immutable, identity, key: `diff-content:${identity}`, taskKey: `${identity}:${immutable ? '' : token}` };
  }
  async read(params: Json, deadline: number, signal?: AbortSignal): Promise<Json> {
    const context = this.identify(params);
    const { workspace, repo, path, scope, token, immutable, key } = context;
    const file = immutable ? null : await lstat(join(path, params.path)).catch(() => null);
    const fingerprint = immutable ? context.identity : `${token}:${file?.ino}:${file?.mtimeMs}:${file?.size}`;
    const cached = this.cache.peek(key, fingerprint);
    if (cached) return { ...cached, cacheHit: true };
    const git = new Git(path, this.workspaces.config.gitTimeout, deadline, signal);
    if (await git.root() !== path) throw new WorkbenchError('repository_root_mismatch', 'Expected the recorded worktree root');
    const base = scope === 'branch' ? repo.baseSha || (await git.upstream())[1] : null;
    const value = await this.cache.read(key, fingerprint, async () => {
      const diff = await git.diff(scope, params.path, base, params.commitSha, { oldPath: params.oldPath, maxBytes: this.workspaces.config.maxDiffBytes });
      const observedAt = new Date().toISOString();
      return { schemaVersion: 'workspace.workbench/v1', workspaceId: workspace.id, repoPath: repo.repoPath, scope, path: params.path,
        head: diff.head, baseSha: diff.left, left: diff.left, right: diff.right, patch: diff.patch,
        binary: /Binary files |GIT binary patch/.test(diff.patch), truncated: diff.truncated, readBytes: diff.bytes,
        observation: { state: 'ready', observedAt, ...(immutable ? { immutableIdentity: context.identity } : { validationKey: `${path}#${scope === 'working' ? 'working' : 'refs'}`, validationToken: token, validationDependencies: { [`${path}#${scope === 'working' ? 'working' : 'refs'}`]: token } }) } };
    }, true, true, { workspaceId: workspace.id, repoPath: path });
    // Watching prepares in the background; content does not wait for an index scan.
    void withBackgroundGit(() => this.scheduler.register(workspace.id, path)).catch(() => {});
    return value;
  }
}
