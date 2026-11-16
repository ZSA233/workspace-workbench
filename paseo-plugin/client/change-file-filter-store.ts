import { comparisonKey, type Comparison } from '../shared/comparison.ts';
import { observerSettings, type ObserverSettingsValues } from '../shared/settings.ts';
import { DEFAULT_PATH_FILTER, DEFAULT_TEST_RULES, pathFilterMatcher, validateTestRules, type NoteFilter, type PathFilter, type TestFileDisplay, type TestFileRules } from '../shared/change-file-filter.ts';

export type FileFilterScope = { projectConfig?: string; workspaceId: string; workspaceInstance?: string; repoPath: string; scope: string; commitSha?: string; comparison?: Comparison; noteComparisonId?: string };
export function fileFilterContext(scope: FileFilterScope | undefined): string {
  return JSON.stringify([scope?.projectConfig || '', scope?.workspaceId || '', scope?.repoPath || '', scope?.scope || '', scope?.scope === 'commit' ? scope.commitSha || '' : '', scope?.scope === 'compare' ? comparisonKey(scope.comparison) : '']);
}
export type ProjectFileFilter = { display: TestFileDisplay; rules: TestFileRules; ready: boolean; error: string };
export type SessionFileFilter = PathFilter & { noteFilter: NoteFilter; applied: PathFilter; errors: Partial<Record<'include' | 'exclude', string>> };
type SettingsResult = { status: string; values?: unknown; revision?: string };
export type FileFilterSettingsIO = { read(): Promise<SettingsResult>; write(input: { revision: string; values: ObserverSettingsValues }): Promise<SettingsResult> };
type ProjectPatch = Partial<Pick<ProjectFileFilter, 'display' | 'rules'>>;

/** One store per host plugin runtime, with per-project preferences and per-comparison queries. */
export class ChangeFileFilterStore {
  private projects = new Map<string, ProjectFileFilter>();
  private sessions = new Map<string, SessionFileFilter>();
  private listeners = new Set<() => void>();
  private pending = new Map<string, ProjectPatch>();
  private loaded = false;
  private hydrated = false;
  private loading?: Promise<void>;
  private queue = Promise.resolve();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { for (const listener of this.listeners) listener(); }
  project(key: string): ProjectFileFilter {
    let value = this.projects.get(key);
    if (!value) { value = { display: 'dim', rules: DEFAULT_TEST_RULES, ready: this.loaded, error: '' }; this.projects.set(key, value); }
    return value;
  }
  session(key: string): SessionFileFilter {
    let value = this.sessions.get(key);
    if (!value) { value = { ...DEFAULT_PATH_FILTER, noteFilter: 'all', applied: DEFAULT_PATH_FILTER, errors: {} }; this.sessions.set(key, value); }
    return value;
  }
  private hydrate(values:ObserverSettingsValues|undefined,error='') {
    if(values)this.hydrated=true;
    const keys = new Set([...this.projects.keys(), ...Object.keys(values?.changeFileDisplayByProject || {}), ...Object.keys(values?.testFileRulesByProject || {})]);
    for (const key of keys) {
      const patch = this.pending.get(key), storedRules = values?.testFileRulesByProject[key];
      let rules = storedRules || DEFAULT_TEST_RULES, ruleError = '';
      try { validateTestRules(rules); } catch { rules = DEFAULT_TEST_RULES; ruleError = 'invalid_saved_rules'; }
      this.projects.set(key, { display: values?.changeFileDisplayByProject[key] || 'dim', rules, ...patch, ready: true, error: error || ruleError });
    }
    this.notify();
  }
  load(io: FileFilterSettingsIO): Promise<void> {
    if (this.loading) return this.loading;
    if (this.loaded) return Promise.resolve();
    this.loading = (async () => {
      let values: ObserverSettingsValues | undefined, error = '';
      try {
        const result = await io.read(), parsed = observerSettings.schema.safeParse(result.values);
        if (result.status !== 'ready' || !parsed.success) throw Error('settings_unavailable');
        values = parsed.data;
      } catch { error = 'settings_read_failed'; }
      this.loaded = true;
      this.hydrate(values,error);
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }
  updateSession(key: string, patch: Partial<PathFilter & { noteFilter: NoteFilter }>): void {
    const prior = this.session(key), next = { ...prior, ...patch }, errors: SessionFileFilter['errors'] = {};
    if (next.matchMode === 'glob') for (const field of ['include', 'exclude'] as const) {
      if (!next[field].trim()) continue;
      try { pathFilterMatcher({ include: '', exclude: '', matchMode: 'glob', [field]: next[field] }); } catch { errors[field] = 'invalid_path_pattern'; }
    }
    next.errors = errors;
    if (!Object.keys(errors).length) next.applied = { include: next.include, exclude: next.exclude, matchMode: next.matchMode };
    this.sessions.set(key, next); this.notify();
  }
  resetSession(key: string): void {
    this.sessions.delete(key); this.session(key); this.notify();
  }
  updateProject(key: string, patch: ProjectPatch, io: FileFilterSettingsIO): Promise<void> {
    if (patch.rules) validateTestRules(patch.rules);
    this.pending.set(key, { ...this.pending.get(key), ...patch });
    this.projects.set(key, { ...this.project(key), ...patch, error: '' }); this.notify();
    this.queue = this.queue.then(async () => {
      await this.load(io);
      const edits = this.pending.get(key);
      if (!edits) return;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await io.read(), parsed = observerSettings.schema.safeParse(current.values);
          if (current.status !== 'ready' || !current.revision || !parsed.success) throw Error('settings_unavailable');
          if(!this.hydrated)this.hydrate(parsed.data);
          const values = { ...(current.values as ObserverSettingsValues), ...parsed.data,
            changeFileDisplayByProject: { ...parsed.data.changeFileDisplayByProject, ...(edits.display ? { [key]: edits.display } : {}) },
            testFileRulesByProject: { ...parsed.data.testFileRulesByProject, ...(edits.rules ? { [key]: edits.rules } : {}) } };
          const saved = await io.write({ revision: current.revision, values });
          if (saved.status === 'saved') {
            // A newer edit remains pending and will be written by its own queued operation.
            if (this.pending.get(key) === edits) this.pending.delete(key);
            this.projects.set(key, { ...this.project(key), error: '' }); this.notify(); return;
          }
        }
        throw Error('settings_conflict');
      } catch {
        this.projects.set(key, { ...this.project(key), error: 'settings_save_failed' }); this.notify();
      }
    });
    return this.queue;
  }
  retry(key: string, io: FileFilterSettingsIO): Promise<void> {
    const value = this.project(key);
    const edits=this.pending.get(key);
    if(!this.hydrated&&!edits){this.loaded=false;return this.load(io);}
    return this.updateProject(key, edits||{rules:value.rules}, io);
  }
}

export const changeFileFilters = new ChangeFileFilterStore();
