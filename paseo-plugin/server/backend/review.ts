import { Workspaces } from "./workspaces.ts";
import { Git } from "./git.ts";
import { count, protocol } from "./observation.ts";
import { issue, now, WorkbenchError, type Json } from "./storage.ts";
export async function compare(
  workspaces: Workspaces,
  params: Json,
  includeBrief = false,
) {
  if (!Array.isArray(params.workspaceIds) || !params.workspaceIds.length)
    throw new WorkbenchError("workspace_required", "workspaceIds are required");
  const targets = params.targetRefs || {};
  if (typeof targets !== "object" || Array.isArray(targets))
    throw new WorkbenchError("request_invalid", "targetRefs must be an object");
  const ids = [...new Set(params.workspaceIds.map(String))],
    groups: Record<string, Json[]> = Object.create(null);
  for (const id of ids) {
    const workspace = workspaces.get(id);
    if (!workspace.managed)
      throw new WorkbenchError(
        "live_workspace_not_reviewable",
        "live workspace is not reviewable",
      );
    for (const repo of workspace.repositories) {
      const targetRef = String(targets[repo.repoPath] || repo.baseRef || ""),
        git = new Git(repo.worktreePath, workspaces.config.gitTimeout);
      const entry: Json = {
        workspaceId: id,
        repoPath: repo.repoPath,
        branch: "",
        headShort: "",
        targetBranch: targetRef,
        targetHeadShort: "",
        relation: "unknown",
        dirty: false,
        unpushed: false,
        commitCount: null,
        paths: [],
        issues: [],
        changes: count([]),
      };
      try {
        const head = await git.head();
        entry.headShort = (head || "").slice(0, 8);
        entry.branch = (await git.branch()) || "";
        entry.dirty = !!(await git.status(repo.role === "gitlink-root")).length;
        if (!head || !targetRef)
          throw new WorkbenchError(
            "base_missing",
            "comparison target unavailable",
          );
        const target = await git.commit(targetRef),
          [behind, ahead] = (
            await git.text([
              "rev-list",
              "--left-right",
              "--count",
              `${target}...${head}`,
            ])
          )
            .split(/\s+/)
            .map(Number);
        entry.targetHeadShort = target.slice(0, 8);
        entry.relation =
          ahead === 0
            ? "already-contained"
            : behind === 0
              ? "fast-forward-candidate"
              : "diverged";
        entry.commitCount = ahead;
        const [, upstream] = await git.upstream();
        entry.unpushed =
          !!upstream &&
          Number(
            await git.text(["rev-list", "--count", `${upstream}..${head}`]),
          ) > 0;
        const files = await git.files("branch", target);
        entry.paths = files.map((file) => file.path);
        entry.changes = count(files);
      } catch (error) {
        entry.issues.push(issue(error));
      }
      (groups[repo.repoPath] ||= []).push(entry);
    }
  }
  const repositories = Object.entries(groups).map(([repoPath, entries]) => {
    const owners: Record<string, string[]> = Object.create(null);
    for (const entry of entries) {
      for (const path of entry.paths)
        (owners[path] ||= []).push(entry.workspaceId);
      delete entry.paths;
    }
    const overlaps = Object.entries(owners)
      .filter(([, ids]) => new Set(ids).size > 1)
      .map(([path, workspaceIds]) => ({ path, workspaceIds }));
    const requiresReview =
      !!overlaps.length ||
      entries.some(
        (entry) =>
          entry.issues.length ||
          entry.dirty ||
          ["unknown", "diverged"].includes(entry.relation),
      );
    return {
      repoPath,
      entries,
      overlaps,
      requiresReview,
      status: requiresReview
        ? "needs-review"
        : entries.every((entry) => entry.relation === "already-contained")
          ? "already-contained"
          : "fast-forward-candidate",
      aggregate: {
        commits: entries.reduce((n, e) => n + (e.commitCount || 0), 0),
        ...Object.fromEntries(
          ["files", "additions", "deletions"].map((key) => [
            key,
            entries.reduce((n, e) => n + e.changes[key], 0),
          ]),
        ),
      },
    };
  });
  const issues = repositories.flatMap((repo) =>
    repo.entries.flatMap((entry) => entry.issues),
  );
  const result: Json = {
    schemaVersion: protocol,
    workspaceIds: ids,
    repositories,
    overlaps: repositories.flatMap((repo) =>
      repo.overlaps.map((overlap) => ({ repoPath: repo.repoPath, ...overlap })),
    ),
    testEvidence: null,
    issues,
    observation: {
      state: issues.length ? "partial" : "ready",
      observedAt: now(),
      issues,
    },
  };
  if (includeBrief) {
    const byRepository = Object.fromEntries(
      repositories.map((repo) => [
        repo.repoPath,
        [
          `Repository: ${repo.repoPath}`,
          `Status: ${repo.status}`,
          ...repo.entries.flatMap((entry) => [
            `- ${entry.workspaceId}: ${entry.branch} → ${entry.targetBranch} (${entry.relation})`,
            ...entry.issues.map((e: Json) => `  Issue: ${e.code}`),
          ]),
          ...repo.overlaps.map((item) => `Overlap: ${item.path}`),
        ].join("\n"),
      ]),
    );
    result.brief = {
      text: Object.values(byRepository).join("\n\n"),
      byRepository,
    };
  }
  return result;
}
