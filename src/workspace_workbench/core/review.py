from __future__ import annotations

from typing import Any, Mapping

from .errors import WorkbenchError
from .git import GitClient


def compare_entry(git: GitClient, repository: Mapping[str, Any], workspace_id: str, target_ref: str) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "workspaceId": workspace_id, "repoPath": repository["repoPath"],
        "branch": "", "headShort": "", "targetBranch": target_ref,
        "targetHeadShort": "", "relation": "unknown", "dirty": False,
        "unpushed": False, "commitCount": None, "paths": [], "issues": [],
        "changes": {"files": 0, "additions": 0, "deletions": 0, "binaryFiles": 0},
    }
    try:
        head = git.head()
        entry["headShort"] = (head or "")[:8]
        entry["branch"] = git.branch() or ""
        entry["dirty"] = bool(git.status_porcelain())
        if not head or not target_ref:
            raise WorkbenchError("comparison target is unavailable", code="base_missing")
        target = git.resolve_commit(target_ref)
        entry["targetHeadShort"] = target[:8]
        behind, ahead = map(int, git.run(["rev-list", "--left-right", "--count", f"{target}...{head}"]).stdout.split())
        entry["relation"] = "already-contained" if ahead == 0 else "fast-forward-candidate" if behind == 0 else "diverged"
        entry["commitCount"] = ahead
        _, upstream = git.upstream()
        entry["unpushed"] = bool(upstream and int(git.run(["rev-list", "--count", f"{upstream}..{head}"]).stdout))
        files = git.changed_files("branch", base=target)
        entry["paths"] = [item.path for item in files]
        entry["changes"] = {
            "files": len(files), "additions": sum(item.additions or 0 for item in files),
            "deletions": sum(item.deletions or 0 for item in files),
            "binaryFiles": sum(item.binary for item in files),
        }
    except WorkbenchError as error:
        entry["issues"].append(error.as_dict())
    return entry


def aggregate(entries_by_repository: Mapping[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    result = []
    for repo_path, entries in entries_by_repository.items():
        owners: dict[str, list[str]] = {}
        for entry in entries:
            for path in entry.pop("paths", []):
                owners.setdefault(path, []).append(entry["workspaceId"])
        overlaps = [{"path": path, "workspaceIds": ids} for path, ids in owners.items() if len(set(ids)) > 1]
        attention = bool(overlaps or any(item["issues"] or item["dirty"] or item["relation"] in {"unknown", "diverged"} for item in entries))
        status = "needs-review" if attention else "already-contained" if all(item["relation"] == "already-contained" for item in entries) else "fast-forward-candidate"
        result.append({
            "repoPath": repo_path, "entries": entries, "overlaps": overlaps,
            "status": status, "requiresReview": attention,
            "aggregate": {
                "commits": sum(item["commitCount"] or 0 for item in entries),
                **{key: sum(item["changes"][key] for item in entries) for key in ("files", "additions", "deletions")},
            },
        })
    return result


def brief(repositories: list[dict[str, Any]]) -> dict[str, Any]:
    by_repository = {}
    for repository in repositories:
        lines = [f"Repository: {repository['repoPath']}", f"Status: {repository['status']}"]
        for entry in repository["entries"]:
            lines.append(f"- {entry['workspaceId']}: {entry['branch']} → {entry['targetBranch']} ({entry['relation']})")
            lines.extend(f"  Issue: {issue['code']}" for issue in entry["issues"])
        lines.extend(f"Overlap: {item['path']}" for item in repository["overlaps"])
        by_repository[repository["repoPath"]] = "\n".join(lines)
    return {"text": "\n\n".join(by_repository.values()), "byRepository": by_repository}
