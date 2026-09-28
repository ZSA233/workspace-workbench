import { copy, type WorkbenchCopy } from "../shared/copy.ts";
import type { RepositorySummary } from "./model.ts";

export function compactRefLabel(value: string): string {
  const branch = value.trim();
  if (!branch) return "";
  const parts = branch.split("/").filter(Boolean);
  if (parts.length <= 3) return branch;
  return `${parts.slice(0, 2).join("/")}/…/${parts.at(-1)}`;
}

export function repositoryBranchLabel(
  repository: Pick<RepositorySummary, "branch" | "status" | "issues" | "refState" | "refCandidates" | "headShort">,
  strings: WorkbenchCopy = copy,
): string {
  if (repository.status === "missing" || repository.issues.some((issue) => issue.code === "worktree_missing")) {
    return strings.branchMissing;
  }
  if (repository.branch) return compactRefLabel(repository.branch);
  if (repository.refState === "detached") {
    const candidates = repository.refCandidates || [];
    if (candidates.length === 1) return `${strings.branchDetached} · ${compactRefLabel(candidates[0])}`;
    return `${strings.branchDetached} · ${repository.headShort || "—"}`;
  }
  return repository.issues.length ? strings.branchUnavailable : strings.branchUnknown;
}

export function repositoryCurrentRefDetail(
  repository: Pick<RepositorySummary, "branch" | "status" | "refState" | "refCandidates" | "headShort">,
  strings: WorkbenchCopy = copy,
): string {
  if (repository.status === "missing" || repository.refState === "missing") return strings.branchMissing;
  if (repository.branch) return repository.branch;
  if (repository.refState !== "detached") return strings.branchUnknown;
  const candidates = repository.refCandidates || [];
  if (candidates.length) {
    return `${strings.branchDetached} · ${candidates.join(", ")}`;
  }
  return `${strings.branchDetached} · ${repository.headShort || "—"}`;
}

export function repositoryRefMismatch(
  repository: Pick<RepositorySummary, "branch" | "registeredBranch" | "refState">,
): boolean {
  if (!repository.registeredBranch || repository.refState === "unknown" || repository.refState === "missing") return false;
  return repository.refState === "detached" || repository.branch !== repository.registeredBranch;
}
