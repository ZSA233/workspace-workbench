from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import threading
import hashlib
from contextlib import contextmanager
import fcntl
from typing import Any, Mapping, Sequence

from ..core.config import ProjectConfig
from ..core.errors import GitCommandError, WorkbenchError
from ..core.git import GitClient
from ..core.models import RepositoryConfig


MANIFEST_VERSION = 1


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _slug(value: str) -> str:
    result = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip()).strip("-.")
    return result[:80] or "workspace"


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


class GitWorktreeProvider:
    """Default provider for ordinary multi-repository Git projects."""

    def __init__(self, config: ProjectConfig) -> None:
        self.config = config
        self.records_root = (config.records_root or config.workspace_root / "records").resolve()
        self.trees_root = (config.trees_root or config.workspace_root / "trees").resolve()
        if self.records_root == self.trees_root or _inside(self.records_root, self.trees_root) or _inside(self.trees_root, self.records_root):
            raise WorkbenchError("record and tree directories must be separate", code="config_invalid")
        self.records_root.mkdir(parents=True, exist_ok=True)
        self.trees_root.mkdir(parents=True, exist_ok=True)
        self._mutation_lock = threading.RLock()

    def capabilities(self) -> dict[str, bool]:
        return {
            "observe": True,
            "create": self.config.management_enabled,
            "prepare": self.config.management_enabled and self.config.toolchain is not None,
            "agent": self.config.agent_enabled,
            "cleanup": self.config.management_enabled,
        }

    @contextmanager
    def _mutation(self):
        with self._mutation_lock:
            with (self.config.workspace_root / ".workspace.lock").open("a") as stream:
                os.chmod(stream.name, 0o600)
                fcntl.flock(stream, fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(stream, fcntl.LOCK_UN)

    def _enabled_repositories(self) -> list[RepositoryConfig]:
        return [repository for repository in self.config.repositories if repository.enabled]

    def _main_repositories(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for repository in self._enabled_repositories():
            path = self.config.repository_path(repository)
            result.append({
                "id": repository.id,
                "name": repository.name,
                "repoPath": repository.path,
                "sourcePath": str(path),
                "worktreePath": str(path),
                "baseRef": None,
                "baseSha": None,
                "branch": None,
                "mode": "live",
                "role": repository.role,
            })
        return result

    @staticmethod
    def _canonical_path(value: Any, root: Path | None = None) -> str | None:
        raw = str(value or "").strip()
        if not raw:
            return None
        candidate = Path(raw).expanduser()
        if not candidate.is_absolute() and root is not None:
            candidate = root / candidate
        try:
            return str(candidate.resolve())
        except OSError:
            return str(candidate.absolute())

    def _repository_aliases(self, repository: Mapping[str, Any], *, source_root: Path | None = None) -> set[str]:
        aliases = {
            str(repository.get(key)).strip()
            for key in ("id", "name", "repoPath", "sourcePath", "worktreePath")
            if str(repository.get(key) or "").strip()
        }
        for key in ("repoPath", "sourcePath", "worktreePath"):
            path = self._canonical_path(repository.get(key), source_root)
            if path:
                aliases.add(path)
        return aliases

    def _repository_reference_matches(self, repository: Mapping[str, Any], requested: Any, *, source_root: Path | None = None) -> bool:
        raw = str(requested or "").strip()
        aliases = self._repository_aliases(repository, source_root=source_root)
        if raw in aliases:
            return True
        canonical = self._canonical_path(raw, source_root)
        return bool(canonical and canonical in aliases)

    def _configured_repository_record(self, repository: RepositoryConfig) -> dict[str, Any]:
        return {
            "id": repository.id,
            "name": repository.name,
            "repoPath": repository.path,
            "sourcePath": str(self.config.repository_path(repository)),
        }

    def _record_paths(self) -> list[Path]:
        if not self.records_root.is_dir():
            return []
        return sorted(self.records_root.glob("*.json"))

    def _read_record(self, path: Path) -> dict[str, Any] | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(value, dict) or value.get("schemaVersion") != MANIFEST_VERSION or value.get("id") != path.stem or not isinstance(value.get("repositories"), list):
            return None
        tree = Path(str(value.get("treePath") or "")).resolve()
        if tree == self.trees_root or not _inside(tree, self.trees_root):
            return None
        for item in value["repositories"]:
            if not isinstance(item, dict):
                return None
            try:
                configured = self.config.repository_by_id(str(item.get("id") or ""))
                if Path(str(item.get("sourcePath") or "")).resolve() != self.config.repository_path(configured):
                    return None
                target = Path(str(item.get("worktreePath") or "")).resolve()
                if target == tree or not _inside(target, tree):
                    return None
            except WorkbenchError:
                return None
        return value

    def list(self) -> list[dict[str, Any]]:
        main = {
            "id": "main",
            "displayName": self.config.main_workspace_name,
            "kind": "live",
            "managed": False,
            "description": "Current source checkouts",
            "state": "active",
            "sourceRoot": str(self.config.source_root),
            "treePath": str(self.config.source_root),
            "repositories": self._main_repositories(),
            "createdAt": None,
            "updatedAt": None,
        }
        records: list[dict[str, Any]] = []
        for path in self._record_paths():
            record = self._read_record(path)
            if record is None:
                records.append({"id": path.stem, "displayName": path.stem, "kind": "managed", "managed": True, "state": "record_invalid", "repositories": []})
                continue
            records.append(record)
        records.sort(key=lambda item: str(item.get("updatedAt") or item.get("createdAt") or ""), reverse=True)
        return [main, *records]

    def get(self, workspace_id: str) -> dict[str, Any]:
        value = str(workspace_id).strip()
        if value == "main":
            return self.list()[0]
        path = self.records_root / f"{_slug(value)}.json"
        record = self._read_record(path)
        if record is None or str(record.get("id")) != value:
            raise WorkbenchError(f"workspace unavailable: {value}", code="record_invalid" if path.exists() else "workspace_missing")
        return record

    def identify(self, directory: str | Path) -> dict[str, Any]:
        candidate = Path(directory).expanduser().resolve()
        for workspace in sorted(self.list(), key=lambda item: (not item.get("managed", False), -len(str(item.get("treePath") or "")))):
            if workspace.get("state") == "removed":
                continue
            tree = workspace.get("treePath")
            if tree and _inside(candidate, Path(str(tree))):
                return {"matched": True, "workspaceId": workspace.get("id"), "repoPath": None}
            for repository in workspace.get("repositories", []):
                if not isinstance(repository, Mapping):
                    continue
                worktree = repository.get("worktreePath")
                if worktree and _inside(candidate, Path(str(worktree))):
                    return {"matched": True, "workspaceId": workspace.get("id"), "repoPath": repository.get("repoPath")}
        return {"matched": False, "workspaceId": None, "repoPath": None}

    def repository(self, workspace_id: str, repository_id: str) -> dict[str, Any]:
        workspace = self.get(workspace_id)
        requested = str(repository_id).strip()
        source_root = Path(str(workspace.get("sourceRoot") or "")).resolve() if workspace.get("sourceRoot") else None
        matches = [
            repository for repository in workspace.get("repositories", [])
            if isinstance(repository, Mapping) and self._repository_reference_matches(repository, requested, source_root=source_root)
        ]
        if len(matches) == 1:
            return dict(matches[0])
        if len(matches) > 1:
            raise WorkbenchError(f"repository reference is ambiguous in workspace: {requested}", code="repository_ambiguous", details=[item.get("id") for item in matches])
        raise WorkbenchError(f"repository does not exist in workspace: {requested}", code="repository_missing")

    def create(self, params: Mapping[str, Any]) -> dict[str, Any]:
        if not self.capabilities()["create"]:
            raise WorkbenchError("creation is disabled", code="capability_unavailable")
        with self._mutation():
            return self._create(params)

    def _create(self, params: Mapping[str, Any]) -> dict[str, Any]:
        request_hash = hashlib.sha256(json.dumps(dict(params), sort_keys=True).encode()).hexdigest()
        name = str(params.get("name") or "").strip()
        if not name:
            raise WorkbenchError("workspace name is required", code="workspace_name_required")
        workspace_id = _slug(str(params.get("id") or name))
        if workspace_id == "main":
            raise WorkbenchError("reserved workspace id", code="workspace_id_reserved")
        record_path = self.records_root / f"{workspace_id}.json"
        if record_path.exists():
            existing = self._read_record(record_path)
            if existing and existing.get("requestHash") == request_hash and existing.get("state") == "active":
                return existing
            raise WorkbenchError(f"workspace already exists: {workspace_id}", code="workspace_exists")
        requested_repositories = params.get("repositories")
        if requested_repositories is not None and not isinstance(requested_repositories, list):
            raise WorkbenchError("repositories must be an array", code="request_invalid")
        branch_template = str(params.get("branchTemplate") or "obs/{workspace}/{repository}")
        bases = params.get("baseRefs") if isinstance(params.get("baseRefs"), Mapping) else {}
        if "baseRefs" in params and not isinstance(params["baseRefs"], Mapping):
            raise WorkbenchError("baseRefs must be an object", code="request_invalid")
        configured = [(repository, self._configured_repository_record(repository)) for repository in self._enabled_repositories()]
        if requested_repositories is None:
            selected = [repository for repository, _ in configured]
        else:
            selected = []
            for requested in requested_repositories:
                value = str(requested).strip()
                matches = [repository for repository, record in configured if self._repository_reference_matches(record, value, source_root=self.config.source_root)]
                if not matches:
                    raise WorkbenchError("unknown or disabled repositories", code="repository_invalid", details=[value])
                if len(matches) > 1:
                    raise WorkbenchError("repository reference is ambiguous", code="repository_ambiguous", details=[repository.id for repository in matches])
                if matches[0] not in selected:
                    selected.append(matches[0])
        if any(not isinstance(value, str) or not value.strip() for value in bases.values()):
            raise WorkbenchError("baseRefs must reference selected repositories with non-empty refs", code="request_invalid")
        if not selected:
            raise WorkbenchError("workspace must contain at least one configured repository", code="repositories_empty")
        selected_records = [(repository, self._configured_repository_record(repository)) for repository in selected]
        for key in bases:
            matches = [
                repository for repository, record in selected_records
                if self._repository_reference_matches(record, key, source_root=self.config.source_root)
            ]
            if not matches:
                raise WorkbenchError("baseRefs must reference selected repositories", code="request_invalid", details=[key])
            if len(matches) > 1:
                raise WorkbenchError("baseRefs repository reference is ambiguous", code="repository_ambiguous", details=[repository.id for repository in matches])
        # Resolve every starting point before creating any directories or branches.
        resolved_bases: dict[str, tuple[str, str]] = {}
        for repository in selected:
            git = GitClient(self.config.repository_path(repository), timeout=self.config.git_timeout_seconds)
            if not git.is_repository():
                raise WorkbenchError(f"configured repository is not a Git checkout: {repository.id}", code="repository_invalid")
            record = self._configured_repository_record(repository)
            matching_bases = [
                value for key, value in bases.items()
                if self._repository_reference_matches(record, key, source_root=self.config.source_root)
            ]
            if len(set(matching_bases)) > 1:
                raise WorkbenchError(f"conflicting base refs for repository: {repository.id}", code="request_invalid")
            ref = str((matching_bases[0] if matching_bases else None) or repository.default_base or git.branch() or "HEAD")
            resolved_bases[repository.id] = (ref, git.resolve_commit(ref))
        tree_root = (self.trees_root / workspace_id).resolve()
        if not _inside(tree_root, self.trees_root):
            raise WorkbenchError("workspace tree path is invalid", code="path_invalid")
        tree_root.mkdir(parents=True, exist_ok=False)
        created: list[tuple[GitClient, Path, str]] = []
        repositories: list[dict[str, Any]] = []
        journal = {"schemaVersion": MANIFEST_VERSION, "id": workspace_id, "displayName": name, "kind": "managed", "managed": True, "state": "creating", "treePath": str(tree_root), "sourceRoot": str(self.config.source_root), "repositories": repositories, "requestHash": request_hash}
        def save_journal() -> None:
            temporary = record_path.with_suffix(f".{os.getpid()}.tmp")
            temporary.write_text(json.dumps(journal, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.chmod(0o600)
            os.replace(temporary, record_path)
        save_journal()
        try:
            for repository in selected:
                source = self.config.repository_path(repository)
                git = GitClient(source, timeout=self.config.git_timeout_seconds)
                if not git.is_repository():
                    raise WorkbenchError(f"configured repository is not a Git checkout: {repository.id}", code="repository_invalid")
                base_ref, base_sha = resolved_bases[repository.id]
                try:
                    branch = branch_template.format(workspace=workspace_id, repository=repository.id)
                except (KeyError, ValueError) as exc:
                    raise WorkbenchError("branchTemplate must use {workspace} and {repository}", code="branch_template_invalid") from exc
                if not re.fullmatch(r"[A-Za-z0-9._/-]+", branch) or branch.startswith("/") or branch.endswith("/") or ".." in branch:
                    raise WorkbenchError(f"invalid branch name generated for {repository.id}", code="branch_invalid")
                worktree = (tree_root / repository.id).resolve()
                if not _inside(worktree, tree_root):
                    raise WorkbenchError("repository worktree path is invalid", code="path_invalid")
                git.run(["check-ref-format", "--branch", branch])
                if git.run(["show-ref", "--verify", f"refs/heads/{branch}"], check=False).returncode == 0:
                    raise WorkbenchError("workspace branch already exists", code="branch_exists")
                created.append((git, worktree, branch))
                repositories.append({
                    "id": repository.id,
                    "name": repository.name,
                    "repoPath": repository.path,
                    "sourcePath": str(source),
                    "worktreePath": str(worktree),
                    "baseRef": base_ref,
                    "baseSha": base_sha,
                    "branch": branch,
                    "mode": "managed",
                    "role": repository.role,
                })
                save_journal()
                git.run(["worktree", "add", "-b", branch, str(worktree), base_sha])
        except Exception as cause:
            rollback_issues = []
            for git, worktree, branch in reversed(created):
                try:
                    if worktree.exists():
                        git.run(["worktree", "remove", str(worktree)])
                    if git.run(["show-ref", "--verify", f"refs/heads/{branch}"], check=False).returncode == 0:
                        git.run(["branch", "-d", branch])
                except Exception as error:
                    rollback_issues.append({"code": "rollback_incomplete", "path": str(worktree), "message": str(error)})
            if tree_root.exists() and not any(tree_root.iterdir()):
                tree_root.rmdir()
            journal.update(state="create_failed", issues=[{"code": getattr(cause, "code", "create_failed"), "message": str(cause)}, *rollback_issues])
            save_journal()
            raise WorkbenchError("workspace creation failed; recovery record retained", code="create_failed", details=journal["issues"]) from cause
        record = {
            "schemaVersion": MANIFEST_VERSION,
            "requestHash": request_hash,
            "id": workspace_id,
            "displayName": name,
            "kind": "managed",
            "managed": True,
            "description": str(params.get("description") or ""),
            "state": "active",
            "sourceRoot": str(self.config.source_root),
            "treePath": str(tree_root),
            "repositories": repositories,
            "createdAt": _now(),
            "updatedAt": _now(),
        }
        manifest_root = tree_root / ".workspace"
        manifest_root.mkdir(mode=0o700)
        (manifest_root / "manifest.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        journal.update(record)
        save_journal()
        return record

    def cleanup(self, workspace_id: str, *, confirm: bool = False) -> dict[str, Any]:
        if not self.capabilities()["cleanup"]:
            raise WorkbenchError("cleanup is disabled", code="capability_unavailable")
        with self._mutation():
            return self._cleanup(workspace_id, confirm=confirm)

    def _cleanup(self, workspace_id: str, *, confirm: bool) -> dict[str, Any]:
        workspace = self.get(workspace_id)
        if not workspace.get("managed"):
            raise WorkbenchError("live workspace cannot be cleaned up", code="workspace_not_managed")
        tree_value = workspace.get("treePath")
        tree_path = Path(str(tree_value)).expanduser().resolve() if tree_value else None
        if tree_path is None or tree_path == self.trees_root or not _inside(tree_path, self.trees_root):
            raise WorkbenchError("workspace tree path is outside the provider root", code="path_invalid")
        targets: list[tuple[GitClient, Path]] = []
        for repository in workspace.get("repositories", []):
            if not isinstance(repository, Mapping):
                continue
            source = repository.get("sourcePath")
            worktree = repository.get("worktreePath")
            if source and worktree:
                source_path = Path(str(source)).expanduser().resolve()
                worktree_path = Path(str(worktree)).expanduser().resolve()
                if not _inside(source_path, self.config.source_root) or not _inside(worktree_path, tree_path):
                    raise WorkbenchError("workspace repository path is outside the provider root", code="path_invalid")
                target = GitClient(worktree_path, timeout=self.config.git_timeout_seconds)
                if target.root() != worktree_path or target.branch() != repository.get("branch"):
                    raise WorkbenchError("worktree identity changed", code="worktree_identity_changed")
                if target.status_porcelain():
                    raise WorkbenchError("worktree has uncommitted files", code="workspace_dirty")
                source_git = GitClient(source_path, timeout=self.config.git_timeout_seconds)
                registered = source_git.run(["worktree", "list", "--porcelain"]).stdout
                if f"worktree {worktree_path}\n" not in registered:
                    raise WorkbenchError("worktree registration changed", code="worktree_identity_changed")
                targets.append((source_git, worktree_path))
        if not confirm:
            return {"workspaceId": workspace_id, "preview": True, "removed": False, "repositories": len(targets)}
        for source_git, worktree_path in targets:
            source_git.run(["worktree", "remove", str(worktree_path)])
        manifest_path = tree_path / ".workspace" / "manifest.json"
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text())
            if manifest.get("requestHash") == workspace.get("requestHash"):
                manifest_path.unlink()
                if not any(manifest_path.parent.iterdir()):
                    manifest_path.parent.rmdir()
        if tree_path.exists() and not any(tree_path.iterdir()):
            tree_path.rmdir()
        record_path = self.records_root / f"{_slug(workspace_id)}.json"
        workspace.update(state="removed", updatedAt=_now())
        temporary = record_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(workspace, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, record_path)
        return {"workspaceId": workspace_id, "removed": True}
