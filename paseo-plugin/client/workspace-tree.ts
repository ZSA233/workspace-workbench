import type { WorkspaceSummary } from './model.ts';
import { readWorkspaceLineage, workspaceInstanceKey, workspaceSource, type WorkspaceSource } from '../shared/workspace-lineage.ts';
export type WorkspaceTreeNode = {
  key: string; source: WorkspaceSource; workspace?: WorkspaceSummary; match: boolean;
  children: WorkspaceTreeNode[]; members: WorkspaceSummary[]; rank: number;
};
export type WorkspaceTreeRow = { node: WorkspaceTreeNode; depth: number };
/** Build solely from recorded identities. Branch names and shared SHAs are not ancestry. */
export function workspaceForest(all: readonly WorkspaceSummary[], matches: readonly WorkspaceSummary[]): WorkspaceTreeNode[] {
  const actual = new Map(all.map(workspace => [workspaceInstanceKey(workspace), workspace]));
  const ids = new Map(all.map(workspace => [workspace.id, workspace]));
  const ranks = new Map(matches.map((workspace, index) => [workspaceInstanceKey(workspace), index]));
  const nodes = new Map<string, WorkspaceTreeNode>(), parents = new Map<string,string>();
  const get = (source: WorkspaceSource) => {
    let node = nodes.get(source.instanceKey);
    if (!node) {
      const workspace = actual.get(source.instanceKey);
      node = { key: source.instanceKey, source: workspace ? workspaceSource(workspace) : source, workspace, match: ranks.has(source.instanceKey), children: [], members: [], rank: ranks.get(source.instanceKey) ?? Infinity };
      nodes.set(source.instanceKey,node);
    }
    return node;
  };
  const recorded = (workspace: WorkspaceSummary): WorkspaceSource[] => {
    if (workspace.lineage !== undefined) { const lineage = readWorkspaceLineage(workspace.lineage); return lineage?.parent ? [lineage.parent, ...lineage.ancestors] : []; }
    if (!workspace.sourceWorkspaceId) return [];
    const source = ids.get(workspace.sourceWorkspaceId);
    return [source && source.kind === 'linked-live' ? workspaceSource(source) : { id: workspace.sourceWorkspaceId, displayName: workspace.sourceWorkspaceId, instanceKey: `${workspace.sourceWorkspaceId}:${workspace.sourceRoot || 'legacy'}` }];
  };
  for (const workspace of matches) {
    let node = get(workspaceSource(workspace));
    let trail = recorded(workspace);
    const seen = new Set([node.key]);
    while (trail.length) {
      const source = trail.shift()!;
      if (!source || typeof source.instanceKey !== 'string' || !source.id || source.id === 'main' || seen.has(source.instanceKey)) break;
      const parent = get(source);
      let check: string | undefined = parent.key;
      const inspected = new Set<string>();
      while (check && !inspected.has(check) && check !== node.key) { inspected.add(check); check = parents.get(check); }
      if (check === node.key) break;
      parents.set(node.key,parent.key); seen.add(parent.key); node = parent;
      if (parent.workspace) trail = recorded(parent.workspace);
    }
  }
  const roots: WorkspaceTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = parents.get(node.key);
    if (parent) nodes.get(parent)!.children.push(node); else roots.push(node);
  }
  const complete = (node: WorkspaceTreeNode) => {
    node.members = node.match && node.workspace ? [node.workspace] : [];
    for (const child of node.children) { complete(child); node.members.push(...child.members); node.rank = Math.min(node.rank,child.rank); }
    node.children.sort((a,b) => a.rank-b.rank || a.key.localeCompare(b.key));
  };
  roots.forEach(complete);
  return roots.filter(node => node.members.length).sort((a,b) => a.rank-b.rank || a.key.localeCompare(b.key));
}
export function workspaceTreeRows(roots: readonly WorkspaceTreeNode[], collapsed: ReadonlySet<string>, searching = false): WorkspaceTreeRow[] {
  const rows: WorkspaceTreeRow[] = [];
  const visit = (node: WorkspaceTreeNode, depth: number) => { rows.push({ node,depth }); if (searching || !collapsed.has(node.key)) node.children.forEach(child => visit(child,depth+1)); };
  roots.forEach(node => visit(node,0)); return rows;
}
