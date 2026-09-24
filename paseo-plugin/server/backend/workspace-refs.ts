import type { Json } from "./storage.ts";

/**
 * Returns the logical branch label shared by a multi-repository Workspace.
 *
 * Managed Workspaces keep a separate Git branch for each repository. Their
 * common label is derived from the branch template prefix (for example,
 * `obs/demo` for `obs/demo/api`). Gitlink Workspaces already have one real
 * branch name, so that name is returned unchanged.
 */
export function workspaceBranchLabel(workspace: Json): string | null {
  if (workspace.kind === "live" || workspace.managed === false) return null;
  if (workspace.layout === "gitlink" && typeof workspace.branchName === "string" && workspace.branchName.trim()) {
    return workspace.branchName.trim();
  }

  const repositories = Array.isArray(workspace.repositories) ? workspace.repositories as Json[] : [];
  const prefixes = repositories.map((repository) => {
    const branch = typeof repository.branch === "string" ? repository.branch.trim() : "";
    const id = typeof repository.id === "string" ? repository.id.trim() : "";
    if (!branch || !id) return null;
    const suffix = `/${id}`;
    const prefix = branch.endsWith(suffix) ? branch.slice(0, -suffix.length) : null;
    return prefix && prefix.includes("/") ? prefix : null;
  });
  if (prefixes.length && prefixes.every((prefix) => Boolean(prefix)) && new Set(prefixes).size === 1) {
    return prefixes[0];
  }

  const id = typeof workspace.id === "string" ? workspace.id.trim() : "";
  return id || null;
}

export type WorkspaceCurrentRefState = "uniform" | "mixed" | "unknown";

export function workspaceCurrentRefSummary(repositories: Json[]): {
  currentRef: string | null;
  currentRefState: WorkspaceCurrentRefState;
} {
  if (!repositories.length) return { currentRef: null, currentRefState: "unknown" };
  const refs = repositories.map((repository) => typeof repository.branch === "string" && repository.branch ? repository.branch : null);
  if (refs.some((ref) => !ref)) return { currentRef: null, currentRefState: "mixed" };
  const first = refs[0]!;
  return refs.every((ref) => ref === first)
    ? { currentRef: first, currentRefState: "uniform" }
    : { currentRef: null, currentRefState: "mixed" };
}
