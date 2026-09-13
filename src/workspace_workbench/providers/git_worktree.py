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
            "remove": self.config.management_enabled,
            "restore": self.config.management_enabled,
            "permanentDelete": self.config.management_enabled,
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

    def _record_path(self, workspace_id: str) -> Path:
        return self.records_root / f"{_slug(workspace_id)}.json"

    def _write_record(self, workspace: Mapping[str, Any]) -> dict[str, Any]:
        value = dict(workspace)
        value["updatedAt"] = _now()
        record_path = self._record_path(str(value.get("id") or ""))
        temporary = record_path.with_suffix(f".{os.getpid()}.tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, record_path)
        self._write_manifest(value)
        return value

    def _write_manifest(self, workspace: Mapping[str, Any]) -> None:
        tree_value = workspace.get("treePath")
        if not tree_value:
            return
        tree_path = Path(str(tree_value)).expanduser().resolve()
        if tree_path == self.trees_root or not _inside(tree_path, self.trees_root):
            return
        manifest_path = tree_path / ".workspace" / "manifest.json"
        if not manifest_path.is_file():
            return
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if not isinstance(manifest, dict) or manifest.get("id") != workspace.get("id"):
            return
        manifest["state"] = workspace.get("state")
        if "deletion" in workspace:
            manifest["deletion"] = workspace["deletion"]
        else:
            manifest.pop("deletion", None)
        temporary = manifest_path.with_suffix(f".{os.getpid()}.tmp")
        try:
            temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.chmod(0o600)
            os.replace(temporary, manifest_path)
        except OSError:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _parse_worktree_entries(output: str) -> list[dict[str, str]]:
        entries: list[dict[str, str]] = []
        current: dict[str, str] = {}
        for line in [*output.splitlines(), ""]:
            if not line.strip():
                if current:
                    entries.append(current)
                current = {}
                continue
            key, separator, value = line.partition(" ")
            if separator:
                current[key] = value.strip()
        return entries

    def _worktree_entries(self, git: GitClient) -> list[dict[str, str]]:
        result = git.run(["worktree", "list", "--porcelain"], check=False)
        if result.returncode != 0:
            raise GitCommandError(
                result.stderr.strip() or "Git worktree registrations could not be checked",
                code="git_worktree_check_failed",
                details={"repository": str(git.repository), "returncode": result.returncode},
            )
        return self._parse_worktree_entries(result.stdout)

    def _registered_worktree(self, git: GitClient, worktree_path: Path) -> dict[str, str] | None:
        target = worktree_path.resolve()
        for entry in self._worktree_entries(git):
            value = entry.get("worktree")
            if value and Path(value).expanduser().resolve() == target:
                return entry
        return None

    def _creation_was_completed(self, git: GitClient, worktree_path: Path, branch: str, base_sha: str) -> bool:
        try:
            entry = self._registered_worktree(git, worktree_path)
        except WorkbenchError:
            return False
        return bool(
            worktree_path.is_dir()
            and entry
            and not entry.get("locked")
            and entry.get("branch") == f"refs/heads/{branch}"
            and entry.get("HEAD") == base_sha
        )

    def _rollback_creation_entry(self, operation: Mapping[str, Any]) -> list[dict[str, Any]]:
        git = operation["git"]
        worktree = operation["worktree"]
        branch = str(operation["branch"])
        base_sha = str(operation["baseSha"])
        branch_ref = f"refs/heads/{branch}"
        issues: list[dict[str, Any]] = []

        def issue(code: str, message: str) -> None:
            issues.append({"code": code, "path": str(worktree), "message": message})

        try:
            registered = self._registered_worktree(git, worktree)
            if registered is not None:
                if registered.get("branch") != branch_ref:
                    issue("rollback_identity_mismatch", "managed worktree registration changed; preserved for safety")
                    return issues
                if registered.get("locked"):
                    if registered.get("locked") != "initializing" or registered.get("HEAD") != base_sha:
                        issue("rollback_identity_mismatch", "worktree is locked for an unexpected reason; preserved for safety")
                        return issues
                    git.run(["worktree", "unlock", str(worktree)])
                try:
                    git.run(["worktree", "remove", str(worktree)])
                except GitCommandError as error:
                    if error.code != "git_timeout":
                        raise
                remaining = self._registered_worktree(git, worktree)
                if remaining is not None or worktree.exists():
                    issue("rollback_incomplete", "managed worktree could not be confirmed removed; preserved for safety")
                    return issues
            elif worktree.exists():
                issue("rollback_incomplete", "unregistered worktree path exists; preserved for safety")
                return issues

            branch_result = git.run(["show-ref", "--verify", branch_ref], check=False)
            if branch_result.returncode != 0:
                return issues
            branch_sha = branch_result.stdout.strip().split()[0] if branch_result.stdout.strip() else ""
            if branch_sha != base_sha:
                issue("branch_preserved", "branch changed after creation started; preserved for safety")
                return issues
            if any(entry.get("branch") == branch_ref for entry in self._worktree_entries(git)):
                issue("branch_preserved", "branch is still registered to another worktree; preserved for safety")
                return issues
            git.run(["branch", "-D", branch])
        except Exception as error:
            issue("rollback_incomplete", str(error))
        return issues

    def _recover_creation_record(self, workspace: Mapping[str, Any], params: Mapping[str, Any]) -> dict[str, Any] | None:
        repository_ids = workspace.get("repositoryIds")
        repositories = workspace.get("repositories")
        tree_value = workspace.get("treePath")
        if not isinstance(repository_ids, list) or not isinstance(repositories, list) or not tree_value:
            return None
        if sorted(str(value) for value in repository_ids) != sorted(
            str(item.get("id") or "") for item in repositories if isinstance(item, Mapping)
        ):
            return None
        tree_path = Path(str(tree_value)).expanduser().resolve()
        if tree_path == self.trees_root or not _inside(tree_path, self.trees_root) or not tree_path.is_dir():
            return None
        for repository in repositories:
            if not isinstance(repository, Mapping):
                return None
            source_value = repository.get("sourcePath")
            worktree_value = repository.get("worktreePath")
            branch = str(repository.get("branch") or "")
            base_sha = str(repository.get("baseSha") or "")
            if not source_value or not worktree_value or not branch or not base_sha:
                return None
            source_path = Path(str(source_value)).expanduser().resolve()
            worktree_path = Path(str(worktree_value)).expanduser().resolve()
            if not _inside(source_path, self.config.source_root) or not _inside(worktree_path, tree_path):
                return None
            try:
                git = GitClient(source_path, timeout=self.config.workspace_operation_timeout_seconds)
                if not self._creation_was_completed(git, worktree_path, branch, base_sha):
                    return None
            except (OSError, WorkbenchError):
                return None
        record = dict(workspace)
        record["state"] = "active"
        record["description"] = str(params.get("description") or record.get("description") or "")
        record["createdAt"] = str(record.get("createdAt") or _now())
        record.pop("issues", None)
        manifest_root = tree_path / ".workspace"
        manifest_root.mkdir(mode=0o700, exist_ok=True)
        manifest_path = manifest_root / "manifest.json"
        manifest_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        return self._write_record(record)

    def _deletion_impact(self, workspace: Mapping[str, Any]) -> dict[str, Any]:
        repositories: list[dict[str, Any]] = []
        dirty_repositories = 0
        external_references: list[dict[str, str]] = []
        for repository in workspace.get("repositories", []):
            if not isinstance(repository, Mapping):
                continue
            worktree_value = repository.get("worktreePath")
            worktree_path = Path(str(worktree_value)).expanduser().resolve() if worktree_value else None
            worktree_exists = bool(worktree_path and worktree_path.is_dir())
            dirty_paths: list[str] = []
            if worktree_exists and worktree_path is not None:
                try:
                    dirty_paths = [path for _, path in GitClient(worktree_path, timeout=self.config.git_timeout_seconds).status_porcelain()]
                except WorkbenchError:
                    dirty_paths = []
            dirty = bool(dirty_paths)
            if dirty:
                dirty_repositories += 1
            branch = str(repository.get("branch") or "")
            source_value = repository.get("sourcePath")
            if branch and source_value:
                try:
                    source_refs = GitClient(source_value, timeout=self.config.git_timeout_seconds).refs()
                    local_name = f"refs/heads/{branch}"
                    for ref in source_refs:
                        name = str(ref.get("name") or "")
                        if name and name != local_name and (name.endswith(f"/{branch}") or name == branch):
                            external_references.append({
                                "repository": str(repository.get("id") or repository.get("repoPath") or ""),
                                "ref": name,
                            })
                except WorkbenchError:
                    external_references.append({
                        "repository": str(repository.get("id") or repository.get("repoPath") or ""),
                        "ref": "unavailable",
                    })
            repositories.append({
                "id": repository.get("id"),
                "repoPath": repository.get("repoPath"),
                "branch": branch or None,
                "worktreePath": str(worktree_path) if worktree_path else None,
                "worktreeExists": worktree_exists,
                "dirty": dirty,
                "dirtyPaths": dirty_paths,
                "branchPreserved": bool(branch),
            })
        losses = ["workspace record"]
        if any(item.get("worktreeExists") for item in repositories):
            losses.append("managed worktree files")
        if dirty_repositories:
            losses.append("uncommitted changes")
        return {
            "workspaceId": workspace.get("id"),
            "preview": True,
            "irreversible": True,
            "repositories": repositories,
            "dirtyRepositories": dirty_repositories,
            "externalReferences": external_references,
            "branchesPreserved": [
                item["branch"] for item in repositories if item.get("branch")
            ],
            "preserves": ["commits", "local branches", "external references"],
            "loses": losses,
        }

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
            if existing and existing.get("requestHash") == request_hash and existing.get("state") in {"creating", "create_failed"}:
                recovered = self._recover_creation_record(existing, params)
                if recovered is not None:
                    return recovered
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
            git = GitClient(
                self.config.repository_path(repository),
                timeout=self.config.workspace_operation_timeout_seconds,
            )
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
        created: list[dict[str, Any]] = []
        repositories: list[dict[str, Any]] = []
        journal = {"schemaVersion": MANIFEST_VERSION, "id": workspace_id, "displayName": name, "description": str(params.get("description") or ""), "kind": "managed", "managed": True, "state": "creating", "treePath": str(tree_root), "sourceRoot": str(self.config.source_root), "repositoryIds": [repository.id for repository in selected], "repositories": repositories, "requestHash": request_hash}
        def save_journal() -> None:
            temporary = record_path.with_suffix(f".{os.getpid()}.tmp")
            temporary.write_text(json.dumps(journal, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.chmod(0o600)
            os.replace(temporary, record_path)
        save_journal()
        try:
            for repository in selected:
                source = self.config.repository_path(repository)
                git = GitClient(source, timeout=self.config.workspace_operation_timeout_seconds)
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
                operation = {
                    "git": git,
                    "worktree": worktree,
                    "branch": branch,
                    "baseSha": base_sha,
                }
                created.append(operation)
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
                try:
                    git.run(["worktree", "add", "-b", branch, str(worktree), base_sha])
                except GitCommandError as error:
                    # Git can finish the mutation just as the process timeout
                    # fires. Confirm the exact path, branch, and base before
                    # deciding that creation failed.
                    if error.code != "git_timeout" or not self._creation_was_completed(git, worktree, branch, base_sha):
                        raise
                operation["created"] = True
        except Exception as cause:
            rollback_issues = []
            for operation in reversed(created):
                rollback_issues.extend(self._rollback_creation_entry(operation))
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
            "repositoryIds": [repository.id for repository in selected],
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
                target = GitClient(worktree_path, timeout=self.config.workspace_operation_timeout_seconds)
                if target.root() != worktree_path or target.branch() != repository.get("branch"):
                    raise WorkbenchError("worktree identity changed", code="worktree_identity_changed")
                if target.status_porcelain():
                    raise WorkbenchError("worktree has uncommitted files", code="workspace_dirty")
                source_git = GitClient(source_path, timeout=self.config.workspace_operation_timeout_seconds)
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

    def remove(self, workspace_id: str, *, active_tasks: list[Mapping[str, Any]] | None = None, lock_only: bool = False) -> dict[str, Any]:
        if not self.capabilities()["remove"]:
            raise WorkbenchError("workspace removal is disabled", code="capability_unavailable")
        with self._mutation():
            workspace = self.get(workspace_id)
            if not workspace.get("managed"):
                raise WorkbenchError("live workspace cannot be removed", code="workspace_not_managed")
            state = str(workspace.get("state") or "active")
            if state not in {"active", "create_failed", "deletion_pending", "removed"}:
                raise WorkbenchError("workspace is not removable in its current state", code="workspace_state_invalid")
            tasks = [dict(task) for task in (active_tasks or []) if isinstance(task, Mapping)]
            if lock_only:
                if state == "removed":
                    return {"workspaceId": workspace_id, "removed": True, "pending": False, "state": "removed", "activeTasks": []}
                next_workspace = dict(workspace)
                next_workspace["state"] = "deletion_pending"
                next_workspace["deletion"] = {
                    "requestedAt": str((workspace.get("deletion") or {}).get("requestedAt") or _now()),
                    "activeTasks": [],
                    "blocksNewTasks": True,
                }
                saved = self._write_record(next_workspace)
                return {"workspaceId": workspace_id, "removed": False, "pending": True, "state": saved.get("state"), "activeTasks": []}
            if state == "removed" and not tasks:
                return {"workspaceId": workspace_id, "removed": True, "pending": False, "state": "removed"}
            next_workspace = dict(workspace)
            if tasks:
                next_workspace["state"] = "deletion_pending"
                next_workspace["deletion"] = {
                    "requestedAt": str((workspace.get("deletion") or {}).get("requestedAt") or _now()),
                    "activeTasks": tasks,
                    "blocksNewTasks": True,
                }
            else:
                next_workspace["state"] = "removed"
                next_workspace.pop("deletion", None)
            saved = self._write_record(next_workspace)
            return {
                "workspaceId": workspace_id,
                "removed": saved.get("state") == "removed",
                "pending": saved.get("state") == "deletion_pending",
                "state": saved.get("state"),
                "activeTasks": tasks,
            }

    def restore(self, workspace_id: str) -> dict[str, Any]:
        if not self.capabilities()["restore"]:
            raise WorkbenchError("workspace restore is disabled", code="capability_unavailable")
        with self._mutation():
            workspace = self.get(workspace_id)
            if not workspace.get("managed"):
                raise WorkbenchError("live workspace does not need restore", code="workspace_not_managed")
            state = str(workspace.get("state") or "active")
            if state == "active":
                return {"workspaceId": workspace_id, "restored": True, "state": "active"}
            if state not in {"removed", "deletion_pending"}:
                raise WorkbenchError("workspace cannot be restored in its current state", code="workspace_state_invalid")
            tree_value = workspace.get("treePath")
            tree_path = Path(str(tree_value)).expanduser().resolve() if tree_value else None
            if tree_path is None or not tree_path.is_dir():
                raise WorkbenchError("workspace worktree is no longer available", code="workspace_restore_unavailable")
            next_workspace = dict(workspace)
            next_workspace["state"] = "active"
            next_workspace.pop("deletion", None)
            saved = self._write_record(next_workspace)
            return {"workspaceId": workspace_id, "restored": True, "state": saved.get("state")}

    @staticmethod
    def _prune_stale_worktree(source_git: GitClient, worktree_path: Path) -> None:
        """Remove a managed worktree whose linked .git marker is already gone."""
        if worktree_path.is_symlink() or worktree_path.is_file():
            worktree_path.unlink(missing_ok=True)
        elif worktree_path.is_dir():
            shutil.rmtree(worktree_path)
        pruned = source_git.run(["worktree", "prune", "--expire", "now"], check=False)
        if pruned.returncode != 0:
            raise GitCommandError(
                pruned.stderr.strip() or "stale Git worktree metadata could not be pruned",
                code="git_worktree_cleanup_failed",
                details={"worktreePath": str(worktree_path), "returncode": pruned.returncode},
            )
        remaining = source_git.run(["worktree", "list", "--porcelain"], check=False)
        if remaining.returncode != 0:
            raise GitCommandError(
                remaining.stderr.strip() or "Git worktree registrations could not be checked",
                code="git_worktree_cleanup_failed",
                details={"worktreePath": str(worktree_path), "returncode": remaining.returncode},
            )
        if f"worktree {worktree_path}\n" in remaining.stdout:
            raise WorkbenchError(
                "stale Git worktree registration could not be removed",
                code="git_worktree_cleanup_failed",
                details={"worktreePath": str(worktree_path)},
            )

    def permanent_delete(self, workspace_id: str, *, confirm: bool = False) -> dict[str, Any]:
        if not self.capabilities()["permanentDelete"]:
            raise WorkbenchError("permanent workspace deletion is disabled", code="capability_unavailable")
        with self._mutation():
            workspace = self.get(workspace_id)
            if not workspace.get("managed"):
                raise WorkbenchError("live workspace cannot be permanently deleted", code="workspace_not_managed")
            state = str(workspace.get("state") or "active")
            impact = self._deletion_impact(workspace)
            if state == "deletion_pending":
                if not confirm:
                    return {**impact, "canDelete": False, "state": state, "blockedReason": "workspace_task_active", "deleted": False}
                raise WorkbenchError("stop or finish active workspace tasks before permanent deletion", code="workspace_task_active", details=workspace.get("deletion"))
            if state != "removed":
                if not confirm:
                    return {**impact, "canDelete": False, "state": state, "requiresRemoval": True, "deleted": False}
                raise WorkbenchError("remove the workspace before permanently deleting it", code="workspace_must_be_removed")
            if not confirm:
                return {**impact, "canDelete": True, "deleted": False}
            tree_value = workspace.get("treePath")
            tree_path = Path(str(tree_value)).expanduser().resolve() if tree_value else None
            if tree_path is None or tree_path == self.trees_root or not _inside(tree_path, self.trees_root):
                raise WorkbenchError("workspace tree path is outside the provider root", code="path_invalid")
            for repository in workspace.get("repositories", []):
                if not isinstance(repository, Mapping):
                    continue
                worktree_value = repository.get("worktreePath")
                if not worktree_value:
                    continue
                worktree_path = Path(str(worktree_value)).expanduser().resolve()
                if not _inside(worktree_path, tree_path):
                    raise WorkbenchError("workspace repository path is outside the provider root", code="path_invalid")
                source_value = repository.get("sourcePath")
                if source_value:
                    source_git = GitClient(source_value, timeout=self.config.workspace_operation_timeout_seconds)
                    registered = source_git.run(["worktree", "list", "--porcelain"], check=False).stdout
                    if f"worktree {worktree_path}\n" in registered:
                        if (worktree_path / ".git").exists():
                            source_git.run(["worktree", "remove", "--force", str(worktree_path)])
                        else:
                            self._prune_stale_worktree(source_git, worktree_path)
                elif worktree_path.is_dir():
                    shutil.rmtree(worktree_path)
            if tree_path.exists():
                shutil.rmtree(tree_path)
            record_path = self._record_path(workspace_id)
            record_path.unlink(missing_ok=True)
            return {
                "workspaceId": workspace_id,
                "preview": False,
                "deleted": True,
                "branchesPreserved": impact["branchesPreserved"],
                "externalReferences": impact["externalReferences"],
            }
