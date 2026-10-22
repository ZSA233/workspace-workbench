import { lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { directoryGitMark, emptyGitCounts, gitCountKey, gitMark, type FileDecoration, type FileDecorations, type GitMark } from '../../shared/file-decorations.ts';
import { FileRoots, type FileRoot } from './file-roots.ts';
import { RepositoryStatus } from './repository-status.ts';
import { Git } from './git.ts';
import { hash, issue, now, stable, WorkbenchError, type Json } from './storage.ts';
import { workspaceInstanceKey } from '../../shared/workspace-lineage.ts';

type Repo = { path: string; gitlinkRoot: boolean };
type Event = { to: string; from?: string; mark: GitMark; changes: NonNullable<FileDecoration['changes']> };
const inside = (root: string, path: string) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
const slash = (path: string) => path.split(sep).join('/');
const priority = ['!', 'D', 'R', 'C', 'T', 'M', 'A', 'U'];

/** Decorate requested paths only; ignored directories are never recursively enumerated. */
export class FileDecorationsService {
  readonly roots: FileRoots;
  readonly status: RepositoryStatus;
  constructor(roots: FileRoots, status: RepositoryStatus) { this.roots = roots; this.status = status; }
  async query(context: FileRoot, paths: string[], force = false): Promise<FileDecorations> {
    if (Buffer.byteLength(JSON.stringify(paths)) > 60 * 1024) throw new WorkbenchError('file_request_invalid', 'Decoration path batch exceeds the request byte budget');
    paths = [...new Set(paths)];
    paths.forEach(path => this.roots.parts(path));
    const id = String(context.workspace.id), cache = this.status.cache;
    const instance = workspaceInstanceKey(context.workspace as Json & { id: string });
    if (force) cache.invalidateWorkspace(id);
    const repos: Repo[] = [];
    for (const record of context.workspace.repositories || []) {
      const configured = String(record.worktreePath || record.sourcePath);
      // A missing configured repository remains an unknown boundary, never its parent's checkout.
      const path = await realpath(configured).catch(() => configured);
      if (inside(context.root, path)) repos.push({ path, gitlinkRoot: record.role === 'gitlink-root' });
    }
    repos.sort((a, b) => b.path.length - a.path.length);
    const owner = (path: string) => repos.find(repo => inside(repo.path, path));
    const requested = await Promise.all(paths.map(async path => {
      if (this.roots.metadata(context, path)) return { path, full: join(context.root, path), directory: false, metadata: true, valid: true };
      try {
        const full = await this.roots.path(context, path), stat = await lstat(full);
        return { path, full, directory: stat.isDirectory() && !stat.isSymbolicLink(), metadata: false, valid: true };
      } catch { return { path, full: join(context.root, path), directory: false, metadata: false, valid: false }; }
    }));
    const relevant = repos.filter(repo => requested.some(p => !p.metadata && (owner(p.full) === repo || p.directory && inside(p.full, repo.path))));
    // Registration and watcher preparation do not block the directory RPC or its initial paint.
    await Promise.all(relevant.map(repo => this.status.scheduler.register(id, repo.path)));
    const fingerprint = stable([context.instance, this.status.cache.workspaceEpoch(id), relevant.map(repo => [repo.path, this.status.version(id, repo.path, instance)])]);
    const key = `file-decorations:v1:${hash(context.instance)}:${hash(stable(paths))}`;
    let partial: FileDecorations | undefined;
    try {
      const value = await cache.read(key, fingerprint, async () => {
        const events = new Map<string, Event>(), ignored = new Map<string, NonNullable<FileDecoration['ignored']>>(), failed = new Set<string>();
        const issues: FileDecorations['issues'] = [];
        // The global Git scheduler bounds subprocess concurrency; batches themselves stay small.
        for (const repo of relevant) {
          try {
            const snapshot = await this.status.read(id, repo.path, repo.gitlinkRoot, instance);
            for (const [code, names] of snapshot.rows) {
              const mark = gitMark(code); if (!mark) continue;
              const [name, old] = names.split('\0'), to = join(repo.path, name.replace(/\/$/, '')), from = old ? join(repo.path, old) : undefined;
              const boundary = owner(to);
              if (!inside(context.root, to) || boundary !== repo && !(boundary?.path === to && code !== '??')) continue;
              if (this.roots.metadata(context, slash(relative(context.root, to)))) continue;
              const eventKey = `${repo.path}\0${to}`, existing = events.get(eventKey);
              const change = { index: code[0], worktree: code[1], ...(from ? { from: slash(relative(context.root, from)) } : {}) };
              if (existing) { existing.changes.push(change); if (priority.indexOf(mark) < priority.indexOf(existing.mark)) existing.mark = mark; if (from) existing.from = from; }
              else events.set(eventKey, { to, from, mark, changes: [change] });
            }
            const candidates = requested.filter(p => p.valid && !p.metadata && owner(p.full) === repo && p.full !== repo.path);
            // -z requires --stdin. Prefix ./ to preserve literal names starting with pathspec
            // magic. No --no-index: tracked files must stay excluded from ignore results.
            let batch: string[] = [], bytes = 0;
            const flush = async () => {
              if (!batch.length) return;
              const result = await new Git(repo.path, this.status.timeout).run(['check-ignore', '-v', '-z', '--stdin'], false, { maxBytes: 4 * 1024 * 1024, input: batch.map(path => './' + path + '\0').join('') });
              if (![0, 1].includes(result.code)) throw new WorkbenchError('git_ignore_failed', 'Git ignore rules could not be checked');
              const values = result.stdout.split('\0');
              if (values.at(-1) === '') values.pop();
              if (values.length % 4) throw new WorkbenchError('git_ignore_incomplete', 'Git returned incomplete ignore information');
              for (let i = 0; i < values.length; i += 4) {
                const [source, line, pattern, name] = values.slice(i, i + 4);
                // Verbose output also includes matching negations; these are explicitly unignored.
                if (!pattern.startsWith('!')) ignored.set(join(repo.path, name.replace(/\/$/, '')), { source, line: Number(line), pattern });
              }
              batch = []; bytes = 0;
            };
            for (const p of candidates) {
              const name = slash(relative(repo.path, p.full)), size = Buffer.byteLength(name) + 1;
              if (bytes + size > 8000) await flush();
              batch.push(name); bytes += size;
            }
            await flush();
          } catch (error) { failed.add(repo.path); const failure = issue(error); issues.push({ code: failure.code, message: failure.message, path: slash(relative(context.root, repo.path)) }); }
        }
        const entries: FileDecoration[] = requested.map(p => {
          const repo = owner(p.full);
          const entry: FileDecoration = { path: p.path, state: p.valid ? 'ready' : 'unknown', ...(repo ? { repository: slash(relative(context.root, repo.path)) } : {}) };
          if (p.metadata) return entry;
          if (relevant.some(r => failed.has(r.path) && (r === repo || p.directory && inside(p.full, r.path)))) entry.state = 'unknown';
          const direct = [...events.values()].filter(e => e.to === p.full);
          const strongest = direct.reduce<Event | undefined>((best, e) => !best || priority.indexOf(e.mark) < priority.indexOf(best.mark) ? e : best, undefined);
          if (strongest) { entry.mark = strongest.mark; entry.changes = direct.flatMap(e => e.changes); }
          if (p.directory) {
            const counts = emptyGitCounts();
            for (const event of events.values()) {
              // A rename is one event in a common ancestor, and reaches both old and new parents.
              if (!inside(p.full, event.to) && !(event.mark === 'R' && event.from && inside(p.full, event.from))) continue;
              counts.total++; counts[gitCountKey[event.mark]]++;
            }
            entry.directory = counts;
            const mark = directoryGitMark(counts); if (mark) entry.mark = mark;
          }
          if (!entry.mark && ignored.has(p.full)) entry.ignored = ignored.get(p.full);
          return entry;
        });
        partial = { workspaceId: id, instance: context.instance, version: hash(fingerprint), observedAt: now(), freshness: issues.length ? 'unknown' : 'fresh', entries, issues };
        // A failed refresh must not overwrite a complete, previously useful decoration snapshot.
        if (issues.length) throw new WorkbenchError('file_git_incomplete', 'Git status is pending an update', issues);
        if (fingerprint !== stable([context.instance, cache.workspaceEpoch(id), relevant.map(repo => [repo.path, this.status.version(id, repo.path, instance)])])) {
          partial.freshness = 'unknown'; partial.entries = paths.map(path => ({ path, state: 'unknown' }));
          throw new WorkbenchError('file_git_superseded', 'Git state changed during decoration');
        }
        return { ...partial, observation: { state: 'ready' } };
      }, true, force, { workspaceId: id });
      return this.result(value);
    } catch (error) {
      const old = cache.retained(key);
      if (old) return { ...this.result(old), freshness: 'stale' };
      const failure = issue(error);
      return partial || { workspaceId: id, instance: context.instance, version: hash(fingerprint), observedAt: now(), freshness: 'unknown', entries: paths.map(path => ({ path, state: 'unknown' })), issues: [{ code: failure.code, message: failure.message }] };
    }
  }
  private result(value: Json): FileDecorations {
    const freshness = value.observation?.state !== 'ready' ? 'stale' : value.cache?.refreshing ? 'refreshing' : 'fresh';
    return { workspaceId: value.workspaceId, instance: value.instance, version: value.version, observedAt: value.observedAt, entries: value.entries, issues: value.issues || [], freshness };
  }
}
