import type { ChangeScope, ChangeSummary, ChangesResult, RepositorySummary } from "./model";

/** Detail statistics are valid only for the selected checkout and diff scope. */
export function selectedChangeSummary(
  repository: RepositorySummary | undefined,
  changes: ChangesResult | null,
  workspaceId: string,
  scope: ChangeScope,
  current: boolean,
): ChangeSummary | null {
  if (!current || !repository || !changes || scope === "commit" || changes.scope !== scope) return null;
  if (changes.workspaceId !== workspaceId || changes.repoPath !== repository.repoPath) return null;
  if ((changes.head || null) !== (repository.head || null)) return null;
  if (scope === "branch" && (changes.baseSha || null) !== (repository.baseSha || null)) return null;
  if (changes.issues.length || repository.status === "error" || repository.observationStale) return null;
  return changes.summary.files > 0 ? changes.summary : null;
}
