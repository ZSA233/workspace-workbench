"""Recoverable additions; the caller owns the provider mutation lock."""
from pathlib import Path
from typing import Any, Mapping
import json

from ..core.errors import WorkbenchError, GitCommandError
from ..core.git import GitClient


def assert_scope_idle(provider, workspace_id: str) -> None:
    # Also protect direct socket clients. Unknown persisted task state fails closed.
    root = provider.config.state_root
    binding = root / "agent-bindings.json"
    try:
        bindings = json.loads(binding.read_text())["bindings"] if binding.exists() else []
        for item in bindings:
            if item.get("workspaceId") == workspace_id and item.get("status") not in {"completed", "failed", "cancelled", "stopped", "idle", "archived"}:
                raise WorkbenchError("finish the execution task before adding repositories", code="workspace_task_active")
        for path in (root / "reviews").glob("*.json"):
            item = json.loads(path.read_text())
            if item.get("workspaceId") == workspace_id and item.get("status") not in {"approved", "stopped", "failed", "blocked", "limit_reached"}:
                raise WorkbenchError("finish the review before adding repositories", code="workspace_task_active")
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise WorkbenchError("task state could not be checked", code="workspace_task_status_unavailable") from error


def add_repositories(provider, params: Mapping[str, Any]) -> dict[str, Any]:
    workspace = provider.get(str(params.get("workspaceId") or ""))
    if not workspace.get("managed") or workspace.get("state") != "active":
        raise WorkbenchError("only active managed workspaces can add repositories", code="workspace_state_invalid")
    assert_scope_idle(provider, workspace["id"])
    requested = params.get("repositories")
    bases = params.get("baseRefs", {})
    if not isinstance(requested, list) or not requested or not isinstance(bases, dict):
        raise WorkbenchError("repositories and baseRefs are required", code="request_invalid")
    selected = []
    for ref in requested:
        matches = [repo for repo in provider._enabled_repositories() if provider._repository_reference_matches(provider._configured_repository_record(repo), ref, source_root=provider.config.source_root)]
        if len(matches) != 1:
            raise WorkbenchError("unknown or ambiguous repository", code="repository_invalid")
        if matches[0] not in selected:
            selected.append(matches[0])
    for key, value in bases.items():
        if not isinstance(value, str) or not value.strip() or not any(provider._repository_reference_matches(provider._configured_repository_record(repo), key, source_root=provider.config.source_root) for repo in selected):
            raise WorkbenchError("invalid base ref mapping", code="request_invalid")
    journal = workspace.setdefault("repositoryAdditions", {})
    plans = []
    for repo in selected:
        refs = [value for key, value in bases.items() if provider._repository_reference_matches(provider._configured_repository_record(repo), key, source_root=provider.config.source_root)]
        if len(set(refs)) > 1:
            raise WorkbenchError("conflicting base refs", code="request_invalid")
        existing = next((item for item in workspace["repositories"] if item["id"] == repo.id), None)
        pending = journal.get(repo.id)
        base_ref = refs[0] if refs else (existing or pending or {}).get("baseRef") or repo.default_base or "HEAD"
        if existing:
            if refs and existing["baseRef"] != base_ref:
                raise WorkbenchError("repository already added with another base", code="repository_base_conflict")
            continue
        source = provider.config.repository_path(repo)
        git = GitClient(source, timeout=provider.config.workspace_operation_timeout_seconds)
        target = Path(workspace["treePath"]) / repo.id
        branch = f"obs/{workspace['id']}/{repo.id}"
        if pending:
            expected = {"id": repo.id, "sourcePath": str(source), "worktreePath": str(target), "branch": branch}
            if any(pending.get(key) != value for key, value in expected.items()) or git.resolve_commit(str(pending.get("baseSha") or "")) != pending.get("baseSha"):
                raise WorkbenchError("addition journal identity changed; preserved", code="worktree_identity_changed")
            if pending["baseRef"] != base_ref:
                raise WorkbenchError("retry must use the original base ref", code="repository_base_conflict")
            plan = pending
        else:
            from .git_worktree import _inside
            if target.resolve() == Path(workspace["treePath"]).resolve() or not _inside(target, Path(workspace["treePath"])):
                raise WorkbenchError("invalid worktree path", code="path_invalid")
            git.run(["check-ref-format", "--branch", branch])
            if target.exists() or git.run(["show-ref", "--verify", f"refs/heads/{branch}"], check=False).returncode == 0:
                raise WorkbenchError("target or branch already exists", code="branch_exists")
            plan = {"id": repo.id, "name": repo.name, "repoPath": repo.path, "sourcePath": str(source), "worktreePath": str(target), "branch": branch, "baseRef": base_ref, "baseSha": git.resolve_commit(base_ref), "mode": "managed", "role": repo.role}
        plans.append((git, plan))
    for git, plan in plans:
        journal[plan["id"]] = plan
        provider._write_record(workspace)  # Intent precedes Git; retry can reconcile a timed-out response.
        target = Path(plan["worktreePath"])
        try:
            if not provider._creation_was_completed(git, target, plan["branch"], plan["baseSha"]):
                if target.exists():
                    raise WorkbenchError("unfinished worktree changed; preserved for inspection", code="worktree_identity_changed")
                branch = git.run(["show-ref", "--verify", f"refs/heads/{plan['branch']}"], check=False)
                if branch.returncode == 0:
                    if branch.stdout.split()[0] != plan["baseSha"]:
                        raise WorkbenchError("branch changed; preserved", code="worktree_identity_changed")
                    args = ["worktree", "add", str(target), plan["branch"]]
                else:
                    args = ["worktree", "add", "-b", plan["branch"], str(target), plan["baseSha"]]
                try:
                    git.run(args)
                except GitCommandError as error:
                    if error.code != "git_timeout" or not provider._creation_was_completed(git, target, plan["branch"], plan["baseSha"]):
                        raise
            workspace["repositories"].append(dict(plan))
            workspace["repositoryIds"] = [item["id"] for item in workspace["repositories"]]
            del journal[plan["id"]]
            workspace.pop("repositoryAdditionError", None)
            provider._write_record(workspace)
        except Exception as error:
            workspace["repositoryAdditionError"] = {"code": getattr(error, "code", "repository_add_failed"), "message": str(error)}
            provider._write_record(workspace)
            raise
    # Reconcile a manifest write failure even when every requested repo is already present.
    saved = provider._write_record(workspace)
    manifest_path = Path(workspace["treePath"]) / ".workspace" / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("repositories") != workspace["repositories"]:
            raise ValueError("manifest repositories differ")
    except (OSError, ValueError) as error:
        raise WorkbenchError("repositories added but manifest sync failed; retry the same request", code="workspace_manifest_sync_failed") from error
    return saved
