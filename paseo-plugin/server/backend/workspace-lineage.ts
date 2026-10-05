import { readWorkspaceLineage, workspaceInstanceKey, workspaceSource, type WorkspaceLineage, type WorkspaceSource } from '../../shared/workspace-lineage.ts';
import { WorkbenchError, type Json } from './storage.ts';
import type { WorkspaceDirectory } from './workspace-directory.ts';
type Dependencies = { directory: Pick<WorkspaceDirectory, 'get' | 'roster'> };
type SourceIndex = Map<string, Json[]>;
const referenceKey = (repository: Json, branch: string) => JSON.stringify([repository.id, repository.sourcePath, branch]);
function sourceIndex(workspaces: Json[]): SourceIndex {
  const index: SourceIndex = new Map();
  for (const workspace of workspaces) {
    if (workspace.id === 'main' || workspace.managed === false || workspace.kind === 'live' || workspace.kind === 'linked-live' || !['active','removed'].includes(workspace.state)) continue;
    for (const repo of Array.isArray(workspace.repositories) ? workspace.repositories as Json[] : []) {
      if (typeof repo.id !== 'string' || typeof repo.sourcePath !== 'string' || !repo.branch) continue;
      const key = referenceKey(repo,repo.branch), owners = index.get(key) || [];
      if (!owners.includes(workspace)) owners.push(workspace);
      index.set(key,owners);
    }
  }
  return index;
}
/** Only exact repository/ref ownership establishes automatic provenance. */
export function sourceFromBases(child: Json, workspaces: Json[], legacy = false, index = sourceIndex(workspaces)): Json | null {
  const plans = Array.isArray(child.repositories) ? child.repositories as Json[] : [];
  if (!plans.length) return null;
  const childTime = Date.parse(child.createdAt || '');
  let selected: Json | null = null;
  for (const plan of plans) {
    const ref = typeof plan.baseBranch === 'string' ? plan.baseBranch : legacy && typeof plan.baseRef === 'string' ? plan.baseRef : '';
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : legacy && !ref.startsWith('refs/') && !/[~^@:]/.test(ref) ? ref : '';
    if (!branch || branch === 'HEAD') return null;
    const owners = (index.get(referenceKey(plan,branch)) || []).filter(workspace => workspace.id !== child.id
      && (!legacy || Number.isFinite(childTime) && Number.isFinite(Date.parse(workspace.createdAt || '')) && Date.parse(workspace.createdAt) < childTime));
    if (owners.length !== 1) return null;
    if (selected && workspaceInstanceKey(selected as any) !== workspaceInstanceKey(owners[0] as any)) return null;
    selected = owners[0];
  }
  return selected;
}
export class WorkspaceLineages {
  private deps: Dependencies;
  constructor(deps: Dependencies) { this.deps = deps; }
  snapshot(parent: Json, childKey: string, recordedBy: WorkspaceLineage['recordedBy'], catalog?: Json[]): WorkspaceLineage {
    const ancestors: WorkspaceSource[] = [], seen = new Set<string>();
    const byId = catalog ? new Map(catalog.map(workspace => [workspace.id,workspace])) : null;
    const refs = catalog ? sourceIndex(catalog) : undefined;
    const lookup = (id: string) => byId ? byId.get(id) : this.deps.directory.get(id);
    let current: Json | undefined = parent;
    while (current) {
      const source = workspaceSource(current as any);
      if (source.instanceKey === childKey || seen.has(source.instanceKey)) throw new WorkbenchError('workspace_source_cycle', 'Workspace source would create a cycle');
      seen.add(source.instanceKey); ancestors.push(source);
      const currentLineage = readWorkspaceLineage(current.lineage);
      const next = currentLineage?.parent;
      if (!next) {
        if (current.lineage === undefined) {
          let original: Json | null | undefined;
          if (current.sourceWorkspaceId) { try { original = lookup(current.sourceWorkspaceId); } catch { /* unavailable source */ } }
          else if (catalog) original = sourceFromBases(current, catalog, true, refs);
          if (original) { current = original; continue; }
        }
        break;
      }
      let live: Json | undefined;
      try { live = lookup(next.id); } catch { /* parent can have been deleted */ }
      if (live && workspaceInstanceKey(live as any) === next.instanceKey) { current = live; continue; }
      for (const retained of [next, ...(currentLineage?.ancestors || [])]) {
        if (retained.instanceKey === childKey) throw new WorkbenchError('workspace_source_cycle', 'Workspace source would create a cycle');
        if (!seen.has(retained.instanceKey)) { ancestors.push(retained); seen.add(retained.instanceKey); }
      }
      break;
    }
    return { version: 1, parent: ancestors[0] || null, ancestors: ancestors.slice(1), recordedBy, repositories: [] };
  }
  async infer(child: Json): Promise<WorkspaceLineage | undefined> {
    try {
      const catalog = await this.deps.directory.roster(), parent = sourceFromBases(child,catalog);
      if (!parent) return undefined;
      const lineage = this.snapshot(parent,workspaceInstanceKey(child as any),'reference',catalog);
      lineage.repositories = child.repositories.map((repo: Json) => ({ repositoryId:repo.id,baseRef:repo.baseRef,baseSha:repo.baseSha }));
      return lineage;
    } catch { return undefined; }
  }
  /** Roster-only compatibility: no Git, disk writes or repeated branch-history scans. */
  summaries(workspaces: Json[]): Json[] {
    const refs = sourceIndex(workspaces);
    return workspaces.map(workspace => {
      if (workspace.lineage !== undefined || workspace.sourceWorkspaceId || workspace.id === 'main') return workspace;
      const parent = sourceFromBases(workspace,workspaces,true,refs);
      if (!parent) return workspace;
      // Live parent rows supply the rest of the tree. Historical data is never
      // rewritten merely to display this direct saved-reference relationship.
      const lineage: WorkspaceLineage = { version: 1, parent: workspaceSource(parent as any), ancestors: [], recordedBy: 'reference',
        repositories: workspace.repositories.map((repo: Json) => ({ repositoryId:repo.id,baseRef:repo.baseRef || null,baseSha:repo.baseSha || null })) };
      return { ...workspace,lineage };
    });
  }
}
