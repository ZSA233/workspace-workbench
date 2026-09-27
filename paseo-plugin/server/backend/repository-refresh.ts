import { Git, withBackgroundGit } from './git.ts';
import { now, stable, issue, WorkbenchError, type Json } from './storage.ts';
import { count, fileJson, protocol, type Observation } from './observation.ts';

/** One read generation owns its Git promises; no caller's abort leaks to another generation. */
class SnapshotGit extends Git {
  private reads = new Map<string, ReturnType<Git['run']>>();
  readonly trace: Json[];
  phase = 'critical';
  constructor(path: string, timeout: number, deadline: number, signal: AbortSignal | undefined, trace: Json[]) { super(path, timeout, deadline, signal); this.trace = trace; }
  override run(args: string[], check = true, output?: { maxBytes: number; truncate?: boolean }) {
    const key = stable({ args, check, output });
    const existing = this.reads.get(key);
    if (existing) return existing;
    const start = Date.now();
    const promise = super.run(args, check, output).then(value => {
      this.trace.push({ phase: this.phase, command: args[0], durationMs: Date.now() - start, bytes: value.bytes, ok: true }); return value;
    }, error => {
      this.trace.push({ phase: this.phase, command: args[0], durationMs: Date.now() - start, ok: false, code: issue(error).code }); throw error;
    });
    this.reads.set(key, promise);
    return promise;
  }
  override async files(scope: string, base?: string | null, commit?: string | null, ignoreSubmoduleContent = false, namesOnly = false) {
    // Status already establishes the candidate set. A clean index must not be
    // scanned a second time merely to discover that the diff name list is empty.
    const paths = scope === 'working' && namesOnly
      ? [...new Set((await this.status(ignoreSubmoduleContent)).filter(([code]) => code !== '??').flatMap(([, path]) => path.split('\0')))] : undefined;
    return super.files(scope, base, commit, ignoreSubmoduleContent, namesOnly, paths && paths.reduce((bytes, path) => bytes + Buffer.byteLength(path) + 1, 0) <= 64_000 ? paths : undefined);
  }
  override async range(scope: string, base?: string | null, commit?: string | null) {
    if (scope === 'working') { const head = await this.head(); return { args: ['diff', head || 'HEAD'], left: head, right: null }; }
    return super.range(scope, base, commit);
  }
  override async commit(ref: string) {
    // The Git operation that consumes an object still validates its existence.
    return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(ref) ? ref : super.commit(ref);
  }
}
export class RepositoryRefresh {
  private observation: Observation;
  private closed = false;
  private producers = new Set<AbortController>();
  private statistics = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  constructor(observation: Observation) { this.observation = observation; }
  private context(params: Json) {
    const workspace = this.observation.workspaces.get(String(params.workspaceId || ''));
    const repo = this.observation.workspaces.repository(workspace, params.repoPath || params.repositoryId || '');
    return { workspace, repo, path: repo.worktreePath || repo.sourcePath };
  }
  key(method: string, workspace: Json, params: Json) {
    const options = method === 'repository.graph' ? { historyMode: params.historyMode || (workspace.kind === 'live' ? 'full' : 'branch'), maxCommits: Number(params.maxCommits) || 50 }
      : method === 'repository.changes' ? { scope: params.scope || 'branch', commitSha: params.commitSha || null } : {};
    return `selected:v1:${method}:${workspace.id}:${params.repoPath || params.repositoryId}:${stable(options)}`;
  }
  retained(workspace: Json, repo: Json) { return this.observation.cache.retained(this.key('repository.summary', workspace, { repoPath: repo.repoPath }))?.repository; }

  private async cycle(params: Json, signal?: AbortSignal, deadline = Date.now() + 30_000) {
    const { workspace, repo, path } = this.context(params);
    const cacheEpoch = this.observation.cache.epoch;
    const trace: Json[] = [];
    const git = new SnapshotGit(path, this.observation.workspaces.config.gitTimeout, deadline, signal, trace);
    git.statistics = this.observation.statistics;
    git.statisticsComplete = () => this.observation.scheduler.statisticsChanged(path);
    if (await git.root() !== git.path) throw new WorkbenchError('repository_root_mismatch', 'Expected recorded repository root');
    const readStartedAt = Date.now();
    const token = this.observation.scheduler.token(path, 'working');
    const refsToken = this.observation.scheduler.token(path, 'refs');
    const meta = (scope: string) => ({ state: 'ready', readStartedAt, observedAt: now(), validationKey: `${path}#${scope}`, validationToken: scope === 'working' ? token : refsToken, validationDependencies: { [`${path}#${scope}`]: scope === 'working' ? token : refsToken } });
    // Registration prepares independently; an index scan never gates cached content.
    void withBackgroundGit(() => this.observation.scheduler.register(workspace.id, path, () => this.prewarm(params))).catch(() => {});
    const base = async () => repo.baseSha || (await git.upstream())[1];
    const produce = async (area: string, namesOnly = true): Promise<Json> => {
      const scope = params.scope || 'working';
      const common = { schemaVersion: protocol, workspaceId: workspace.id, repoPath: repo.repoPath };
      if (area === 'summary') {
        const [head, branch, status] = await Promise.all([git.head(), git.branch(), git.status(repo.role === 'gitlink-root')]);
        const baseSha = await base();
        return { ...common, repository: { ...repo, registeredBranch: repo.branch || null, branch: branch || '', head, headShort: head?.slice(0, 8) || null,
          refState: branch ? 'attached' : 'detached', refCandidates: [], status: status.length ? 'dirty' : branch ? 'clean' : 'detached',
          observationPending: false, worktreeExists: true, dirty: status.length > 0, dirtyPaths: status.map(([, path]) => path),
          baseSha, baseShaShort: baseSha?.slice(0, 8) || null, branchScopeAvailable: !!baseSha,
          ahead: null, behind: null, unpushed: null, workingChanges: null, changes: null, changesLoaded: false, issues: [], changeIssues: [], observedAt: now() }, observation: meta('working') };
      }
      const baseSha = await base();
      if (area === 'graph') {
        const historyMode = params.historyMode || (workspace.kind === 'live' ? 'full' : 'branch');
        const graph = await git.graph(historyMode === 'branch' && !baseSha ? 'full' : historyMode, baseSha, Math.max(1, Math.min(200, Number(params.maxCommits) || 50)));
        return { ...common, ...graph, head: await git.head(), branch: await git.branch(), baseSha, truncated: graph.hasOlder, observation: meta('working') };
      }
      const existing = this.observation.cache.retained(this.key('repository.changes', workspace, { ...params, scope }));
      if (scope === 'commit' && existing?.observation?.immutableIdentity && !existing.observation.statisticsPending) return existing;
      const files = (await git.files(scope, baseSha, params.commitSha, repo.role === 'gitlink-root', namesOnly)).map(fileJson);
      const immutable = scope === 'commit' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(String(params.commitSha || ''));
      return { ...common, scope, head: immutable ? params.commitSha : await git.head(), baseSha: scope === 'commit' ? (await git.range(scope, baseSha, params.commitSha)).left : baseSha,
        files, summary: count(files), issues: [], observation: { ...meta(scope === 'working' ? 'working' : 'refs'),
          ...(immutable ? { immutableIdentity: `${path}:${params.commitSha}:changes` } : {}), statisticsPending: namesOnly && files.length > 0 } };
    };
    return { workspace, repo, path, trace, produce, token, refsToken, cacheEpoch, statistics: async (signal: AbortSignal) => { git.signal = signal; git.phase = 'statistics'; return produce('changes', false); } };
  }
  async query(method: string, params: Json, signal?: AbortSignal): Promise<Json> {
    const { workspace, repo, path } = this.context(params);
    const area = method.slice('repository.'.length);
    const scope = area === 'graph' || area === 'summary' || (params.scope || 'branch') === 'working' ? 'working' : 'refs';
    const fingerprint = this.observation.scheduler.token(path, scope) + stable(repo);
    const key = this.key(method, workspace, params);
    const background = !!this.observation.cache.retained(key);
    return this.observation.cache.read(key, fingerprint, async () => {
      if (this.closed) throw new WorkbenchError('observer_closed', 'Repository observer closed');
      const abort = new AbortController(); this.producers.add(abort);
      const cancel = () => abort.abort();
      if (!background && signal) { if (signal.aborted) abort.abort(); else signal.addEventListener('abort', cancel, { once: true }); }
      const ownedSignal = abort.signal;
      const work = async () => {
        const deadline = Date.now() + Math.min(30_000, this.observation.workspaces.config.observationTimeout, background ? 30_000 : Number(params.observationBudgetMs) || 30_000);
        const cycle = await this.cycle({ ...params, scope: params.scope || 'branch' }, ownedSignal, deadline);
        return cycle.produce(area, false);
      };
      try { return await (background ? withBackgroundGit(work) : work()); }
      finally { signal?.removeEventListener('abort', cancel); this.producers.delete(abort); }
    }, true, false, { workspaceId: workspace.id, repoPath: path });
  }
  async request(params: Json): Promise<Json> {
    const tasks = this.observation.diffTasks;
    const requestId = String(params.requestId || '');
    if (params.action === 'status') return tasks.status(String(params.taskId || ''), requestId);
    if (params.action === 'release') return tasks.release(String(params.taskId || ''), requestId);
    if (params.action && params.action !== 'start') throw new WorkbenchError('request_invalid', 'Unknown refresh action');
    if (Number.isFinite(params.readDeadline) && Date.now() >= params.readDeadline) throw new WorkbenchError('observer_timeout', 'Refresh request expired before acceptance');
    const { workspace, repo, path } = this.context(params);
    const identity = stable({ workspaceId: workspace.id, path, historyMode: params.historyMode || null, maxCommits: params.maxCommits || 50, scope: params.scope || 'working', commitSha: params.commitSha || null });
    // Concurrent clicks use the same identity while a generation is unfinished.
    const key = `refresh:${identity}:${this.observation.scheduler.token(path)}${params.force ? `:manual:${requestId}` : ''}`;
    if (!params.force) {
      const areas = ['summary', 'graph', 'changes'];
      const retained = areas.map(area => this.observation.cache.retained(this.key(`repository.${area}`, workspace, { ...params, scope: params.scope || 'working' })));
      // Persisted results display immediately, but a new backend generation is
      // not considered validated until this task has checked its source.
      if (retained.every((value, index) => value?.observation?.state === 'ready' && (value.observation.immutableIdentity || value.observation.validationToken === this.observation.scheduler.token(path, index === 2 && (params.scope || 'working') !== 'working' ? 'refs' : 'working')))) {
        return { protocol: 1, generation: tasks.generation, requestId, taskId: '', state: 'ready', acceptedAt: Date.now(), deadline: Date.now() + 30000,
          result: { refreshId: requestId, workspaceId: workspace.id, repoPath: repo.repoPath, cacheHit: true, observation: { ...retained[0]!.observation, refreshing: !!retained[2]?.observation?.statisticsPending },
            regions: Object.fromEntries(areas.map((area, i) => [area, { state: 'ready', phase: 'cache', result: retained[i], completedAt: Date.now() }])) } };
      }
    }
    return tasks.start(key, requestId, async (signal, deadline, publish) => {
      const acceptedAt = Date.now();
      const regions: Json = Object.fromEntries(['summary', 'graph', 'changes'].map(area => [area, { state: 'queued', phase: 'identity', result: this.observation.cache.retained(this.key(`repository.${area}`, workspace, { ...params, scope: params.scope || 'working' })) }]));
      const value: Json = { protocol: 1, refreshId: requestId, workspaceId: workspace.id, repoPath: repo.repoPath, acceptedAt, regions, trace: [] };
      const update = () => publish({ ...value, regions: { ...regions } });
      update();
      const cycle = await this.cycle(params, signal, deadline); value.trace = cycle.trace;
      await Promise.all(Object.keys(regions).map(async area => {
        const start = Date.now(); regions[area] = { result: regions[area].result, state: 'running', phase: area === 'summary' ? 'status' : area === 'graph' ? 'history-and-refs' : 'file-names', startedAt: start }; update();
        try { const result = await cycle.produce(area); if (cycle.cacheEpoch !== this.observation.cache.epoch) throw new WorkbenchError('observation_superseded', 'Workspace changed during refresh'); const token = area === 'changes' && (params.scope || 'working') !== 'working' ? cycle.refsToken : cycle.token;
          const scope = area === 'changes' && (params.scope || 'working') !== 'working' ? 'refs' : 'working';
          if (Number(this.observation.cache.retained(this.key(`repository.${area}`, workspace, { ...params, scope: params.scope || 'working' }))?.observation?.readStartedAt || 0) <= Number(result.observation.readStartedAt)) this.observation.cache.publish(this.key(`repository.${area}`, workspace, { ...params, scope: params.scope || 'working' }), token + stable(repo), result, { workspaceId: workspace.id, repoPath: path }, cycle.cacheEpoch);
          regions[area] = { state: 'ready', phase: 'published', result, durationMs: Date.now() - start, completedAt: Date.now() }; }
        catch (error) { regions[area] = { state: 'failed', phase: 'git', error: issue(error), durationMs: Date.now() - start }; }
        update();
      }));
      value.completedAt = Date.now();
      value.observation = { state: 'ready', observedAt: now(), validationKey: `${path}#working`, validationToken: cycle.token, refreshing: !!regions.changes.result?.observation?.statisticsPending };
      // Optional statistics are a separate ordinary query/cache fill. They do
      // not own the critical refresh completion or reuse a cancelled signal.
      if (regions.changes.state === 'ready' && regions.changes.result.observation.statisticsPending) {
        const statisticsKey = `${identity}:${cycle.token}`;
        if (!this.closed && !this.statistics.has(statisticsKey) && this.statistics.size < 32) {
          const abort = new AbortController();
          const promise = withBackgroundGit(async () => {
            const result = await cycle.statistics(abort.signal);
            const scope = (params.scope || 'working') === 'working' ? 'working' : 'refs';
            const token = scope === 'working' ? cycle.token : cycle.refsToken;
            if (!abort.signal.aborted && token === this.observation.scheduler.token(path, scope) && Number(this.observation.cache.retained(this.key('repository.changes', workspace, { ...params, scope: params.scope || 'working' }))?.observation?.readStartedAt || 0) <= Number(result.observation.readStartedAt)) this.observation.cache.publish(this.key('repository.changes', workspace, { ...params, scope: params.scope || 'working' }), token + stable(repo), result, { workspaceId: workspace.id, repoPath: path }, cycle.cacheEpoch);
          }).catch(() => {}).finally(() => this.statistics.delete(statisticsKey));
          this.statistics.set(statisticsKey, { abort, promise });
        }
      }
      return value;
    }, Math.min(30_000, this.observation.workspaces.config.observationTimeout), `refresh:${identity}`, params.prefetch ? 'background' : 'observation');
  }
  private async prewarm(params: Json): Promise<Json> {
    if (this.closed) return { status: 'closed' };
    const requestId = `warm:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let task: Json | undefined;
    try {
      task = await this.request({ ...params, requestId, action: 'start', force: false, prefetch: true });
      if (task.taskId && ['queued', 'running'].includes(task.state)) task = await this.observation.diffTasks.wait(task.taskId, requestId, task.deadline);
      return { status: task.state === 'ready' ? 'ready' : 'error' };
    } finally { if (task?.taskId) this.observation.diffTasks.release(task.taskId, requestId); }
  }
  async close() {
    this.closed = true;
    for (const abort of this.producers) abort.abort();
    for (const task of this.statistics.values()) task.abort.abort();
    await Promise.allSettled([...this.statistics.values()].map(task => task.promise));
    this.statistics.clear();
  }

}
