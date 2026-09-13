from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import socket
import socketserver
import stat
import threading
import time
from typing import Any, Callable, Mapping

from .. import __version__
from .cache import ObservationCache
from .config import ProjectConfig, discover_git_repositories, load_config
from .errors import WorkbenchError
from .git import GitClient, GitFile
from ..providers.git_worktree import GitWorktreeProvider
from ..providers.protocols import WorkspaceProvider


PROTOCOL_VERSION = "workspace.workbench/v1"
READ_METHODS = frozenset({
    "observer.health",
    "workspace.list",
    "workspace.detail",
    "workspace.identify",
    "workspace.runtime",
    "repository.graph",
    "repository.changes",
    "repository.diff",
    "review-set.compare",
    "review-set.brief",
})
MANAGEMENT_METHODS = frozenset({
    "observer.reload",
    "workspace.create",
    "workspace.addRepositories",
    "workspace.prepare",
    "workspace.cleanup",
    "workspace.remove",
    "workspace.restore",
    "workspace.delete",
})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _json(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Mapping):
        return {str(key): _json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json(item) for item in value]
    return str(value)


def _count(files: list[dict[str, Any]]) -> dict[str, int]:
    additions = sum(value.get("additions") or 0 for value in files)
    deletions = sum(value.get("deletions") or 0 for value in files)
    binary_files = sum(1 for value in files if value.get("binary"))
    return {
        "files": len(files),
        "additions": additions,
        "deletions": deletions,
        "binaryFiles": binary_files,
    }


def _status_label(status: str) -> str:
    return {
        "A": "Added",
        "M": "Modified",
        "D": "Deleted",
        "R": "Renamed",
        "C": "Copied",
    }.get(status, "Changed")


def _partial(items: list[dict[str, Any]]) -> bool:
    durable = {"worktree_missing", "repository_invalid", "record_invalid", "base_missing", "workspace_dirty", "unpushed"}
    # Lifecycle failures belong to the affected Workspace. They must remain
    # visible on that row without making the entire Workspace roster look like
    # an observer that is still running forever.
    return any(
        issue.get("code") not in durable
        for item in items
        if str(item.get("state") or "active") in {"active", "live"}
        for issue in [*item.get("issues", []), *item.get("changeIssues", [])]
    )


def _file_dict(file: GitFile) -> dict[str, Any]:
    return {
        "path": file.path,
        "status": file.status,
        "statusLabel": _status_label(file.status),
        "oldPath": file.old_path,
        "additions": file.additions,
        "deletions": file.deletions,
        "binary": file.binary,
        "truncated": False,
        "missing": False,
    }


class ObserverService:
    """Project-scoped service shared by stdio and Unix Socket transports."""

    def __init__(self, config: ProjectConfig, *, provider: WorkspaceProvider | None = None) -> None:
        self.config = config
        self.provider = provider or GitWorktreeProvider(config)
        self.toolchain = self._build_toolchain(config)
        self.cache = ObservationCache(
            sqlite_path=config.state_root / "observer.sqlite3",
            max_entries=config.cache_max_entries,
            max_bytes=config.cache_max_bytes,
            sqlite_max_entries=config.sqlite_max_entries,
            ttl_seconds=config.cache_ttl_seconds,
        )
        self.started_at = time.time()
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="workbench")
        self._repository_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="repository")
        self._detail_slots = threading.BoundedSemaphore(2)
        self._closed = False

    @staticmethod
    def _build_toolchain(config: ProjectConfig):
        from ..providers.toolchain import ProjectRuntimeManager
        if config.toolchain and str(config.toolchain.get("manager") or "mise") not in {"mise", "system"}:
            raise WorkbenchError("unsupported toolchain provider", code="config_invalid")
        return (
            ProjectRuntimeManager(
                config.toolchain,
                config.state_root,
                cache_root=config.cache_root,
                cache_enabled=config.cache_enabled,
                config_root=config.config_path.parent,
            )
            if config.toolchain
            else None
        )

    def reload_config(self) -> dict[str, Any]:
        next_config = load_config(self.config.config_path)
        stable_fields = ("project_id", "source_root", "workspace_root", "state_root", "socket_path", "records_root", "trees_root", "repositories", "management_enabled", "agent_enabled")
        if any(getattr(self.config, field) != getattr(next_config, field) for field in stable_fields):
            raise WorkbenchError("project layout changes require a backend restart", code="config_reload_required")
        next_toolchain = self._build_toolchain(next_config)
        self.config = next_config
        if hasattr(self.provider, "config"):
            self.provider.config = next_config  # type: ignore[attr-defined]
        self.toolchain = next_toolchain
        return {"reloaded": True, "project": {"id": self.config.project_id, "displayName": self.config.display_name}}

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._executor.shutdown(wait=False, cancel_futures=True)
        self.cache.close()
        self._repository_executor.shutdown(wait=True)

    def handle(self, method: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        method = str(method or "").strip()
        values = dict(params or {})
        if method == "observer.health":
            return self.health()
        if method == "observer.reload":
            return self.reload_config()
        if method == "workspace.list":
            return self.workspace_list(values)
        if method == "workspace.detail":
            return self.workspace_detail(values)
        if method == "workspace.identify":
            return self.provider.identify(str(values.get("directory") or self.config.source_root))
        if method == "workspace.runtime":
            return self.workspace_runtime(values)
        if method == "workspace.addRepositories":
            workspace = self.provider.add_repositories(values)
            preparations = []
            if self.toolchain:
                for requested in values.get("repositories", []):
                    repository = self.provider.repository(workspace["id"], requested)
                    preparations.append(self.toolchain.prepare(workspace, repository["id"]))
            return {**workspace, "preparations": preparations}
        if method == "workspace.create":
            if not self.config.management_enabled or not self.provider.capabilities().get("create"):
                raise WorkbenchError("workspace management is disabled for this project", code="capability_unavailable")
            return self.provider.create(values)
        if method == "workspace.prepare":
            if not self.config.management_enabled or self.toolchain is None:
                raise WorkbenchError("prepare is unavailable", code="capability_unavailable")
            workspace_id = str(values.get("workspaceId") or "")
            workspace = self._workspace(workspace_id)
            requested_repository = str(values.get("repositoryId") or values.get("repoPath") or "")
            repository = self.provider.repository(workspace_id, requested_repository)
            return self.toolchain.prepare(workspace, str(repository.get("id") or ""))
        if method == "workspace.cleanup":
            if not self.config.management_enabled or not self.provider.capabilities().get("cleanup"):
                raise WorkbenchError("workspace management is disabled for this project", code="capability_unavailable")
            return self.provider.cleanup(str(values.get("workspaceId") or ""), confirm=values.get("confirm") is True)
        if method == "workspace.remove":
            if not self.config.management_enabled or not self.provider.capabilities().get("remove"):
                raise WorkbenchError("workspace removal is disabled for this project", code="capability_unavailable")
            raw_tasks = values.get("activeTasks")
            active_tasks = [dict(task) for task in raw_tasks if isinstance(task, Mapping)] if isinstance(raw_tasks, list) else None
            return self.provider.remove(str(values.get("workspaceId") or ""), active_tasks=active_tasks, lock_only=values.get("lockOnly") is True)
        if method == "workspace.restore":
            if not self.config.management_enabled or not self.provider.capabilities().get("restore"):
                raise WorkbenchError("workspace restore is disabled for this project", code="capability_unavailable")
            return self.provider.restore(str(values.get("workspaceId") or ""))
        if method == "workspace.delete":
            if not self.config.management_enabled or not self.provider.capabilities().get("permanentDelete"):
                raise WorkbenchError("permanent workspace deletion is disabled for this project", code="capability_unavailable")
            return self.provider.permanent_delete(str(values.get("workspaceId") or ""), confirm=values.get("confirm") is True)
        if method == "repository.graph":
            return self.repository_graph(values)
        if method == "repository.changes":
            return self.repository_changes(values)
        if method == "repository.diff":
            return self.repository_diff(values)
        if method == "review-set.compare":
            return self.review_compare(values)
        if method == "review-set.brief":
            return self.review_brief(values)
        if method.startswith("agent."):
            raise WorkbenchError("Agent operations are provided by the Paseo AgentProvider", code="agent_provider_required")
        raise WorkbenchError(f"method is not supported: {method}", code="method_not_allowed")

    def health(self) -> dict[str, Any]:
        capabilities = self.provider.capabilities()
        return {
            "schemaVersion": PROTOCOL_VERSION,
            "service": "workspace-workbench",
            "version": __version__,
            "project": {"id": self.config.project_id, "displayName": self.config.display_name},
            "capabilities": {
                **capabilities,
                "workspaceCreate": capabilities.get("create", False),
                "workspacePrepare": capabilities.get("prepare", False),
                "workspaceCleanup": capabilities.get("cleanup", False),
                "agentProvider": "paseo" if self.config.agent_enabled else None,
            },
            "cache": self.cache.status(),
            "uptimeMs": max(0, round((time.time() - self.started_at) * 1000)),
            "observedAt": _now(),
        }

    def _workspace(self, workspace_id: str) -> dict[str, Any]:
        return self.provider.get(str(workspace_id or ""))

    def _target(self, workspace: Mapping[str, Any], repository_id: str) -> dict[str, Any]:
        return self.provider.repository(str(workspace.get("id") or ""), repository_id)

    def _git(self, repository: Mapping[str, Any]) -> GitClient:
        path = repository.get("worktreePath") or repository.get("sourcePath")
        return GitClient(str(path), timeout=self.config.git_timeout_seconds)

    def _base(
        self,
        repository: Mapping[str, Any],
        git: GitClient,
        *,
        upstream: tuple[str | None, str | None] | None = None,
    ) -> tuple[str | None, str | None]:
        configured_ref = str(repository.get("baseRef") or "").strip() or None
        configured_sha = str(repository.get("baseSha") or "").strip() or None
        if configured_ref or configured_sha:
            return configured_ref, configured_sha
        upstream, upstream_sha = upstream if upstream is not None else git.upstream()
        return upstream, upstream_sha

    def _repository_fingerprint(self, repository: Mapping[str, Any]) -> str:
        """Return a cheap invalidation token for stale-while-revalidate reads.

        Full Git fingerprints execute several subprocesses and used to run
        serially before every detail cache lookup. File-system markers are
        sufficient for deciding whether a snapshot should be refreshed; the
        producer still reads Git as the source of truth. The cache TTL also
        guarantees a refresh for edits that do not change a marker mtime.
        """

        path = Path(str(repository.get("worktreePath") or repository.get("sourcePath") or "")).expanduser().resolve()
        markers: list[str] = [str(path), f"exists:{path.is_dir()}"]
        git_marker = path / ".git"
        git_dir = git_marker
        if git_marker.is_file():
            try:
                line = git_marker.read_text(encoding="utf-8").splitlines()[0]
                if line.startswith("gitdir:"):
                    git_dir = (path / line.split(":", 1)[1].strip()).resolve()
            except (OSError, IndexError):
                pass
        common_dir = git_dir
        try:
            common_dir = (git_dir / (git_dir / "commondir").read_text().strip()).resolve()
        except OSError:
            pass
        for candidate in (
            git_dir / "HEAD",
            git_dir / "packed-refs",
            git_dir / "refs" / "heads",
            git_dir / "refs" / "remotes",
            common_dir / "packed-refs",
            common_dir / "refs" / "heads",
            common_dir / "refs" / "remotes",
        ):
            try:
                value = candidate.stat()
                markers.append(f"{candidate}:{value.st_mtime_ns}:{value.st_size}")
            except OSError:
                markers.append(f"{candidate}:missing")
        value = hashlib.sha256("\x00".join(markers).encode()).hexdigest()
        return f"{self.config.digest}:{path}:{value}"

    def _observe_repository(
        self,
        workspace: Mapping[str, Any],
        repository: Mapping[str, Any],
        *,
        summary_only: bool = False,
    ) -> dict[str, Any]:
        started = time.monotonic()
        result: dict[str, Any] = {
            "id": repository.get("id"),
            "name": repository.get("name") or repository.get("id"),
            "repoPath": repository.get("repoPath") or repository.get("path"),
            "sourcePath": repository.get("sourcePath"),
            "worktreePath": repository.get("worktreePath"),
            "role": repository.get("role"),
            "mode": repository.get("mode") or workspace.get("kind"),
            "branch": "",
            "head": None,
            "headShort": None,
            "baseRef": None,
            "baseSha": None,
            "baseShaShort": None,
            "upstream": None,
            "upstreamSha": None,
            "ahead": None,
            "behind": None,
            "pushed": None,
            "dirty": False,
            "unpushed": False,
            "dirtyPaths": [],
            "branchScopeAvailable": False,
            "worktreeExists": False,
            "issues": [],
            "changeIssues": [],
            "changesLoaded": False,
            "workingChanges": {"files": 0, "additions": 0, "deletions": 0, "binaryFiles": 0},
            "changes": {"files": 0, "additions": 0, "deletions": 0, "binaryFiles": 0},
        }
        path = Path(str(repository.get("worktreePath") or repository.get("sourcePath") or ""))
        if not path.is_dir():
            result.update({"status": "missing", "branch": "", "head": None, "headShort": None, "dirty": False, "unpushed": False, "worktreeExists": False})
            result["issues"].append({"code": "worktree_missing", "message": "configured worktree does not exist", "path": str(path)})
            return result
        result["worktreeExists"] = True
        git = self._git(repository)
        try:
            repository_valid = git.is_repository()
        except WorkbenchError as exc:
            return self._repository_error(result, started, exc)
        if not repository_valid:
            result.update({"status": "invalid", "branch": "", "head": None, "headShort": None, "dirty": False, "unpushed": False, "worktreeExists": True})
            result["issues"].append({"code": "repository_invalid", "message": "path is not a Git checkout"})
            return result
        try:
            head = git.head()
            branch = git.branch()
            upstream, upstream_sha = git.upstream()
            base_ref, base_sha = self._base(repository, git, upstream=(upstream, upstream_sha))
            status_items = git.status_porcelain()
        except WorkbenchError as exc:
            return self._repository_error(result, started, exc)
        dirty = bool(status_items)
        result.update({
            "status": "dirty" if dirty else "detached" if not branch else "clean",
            "branch": branch or "",
            "head": head,
            "headShort": head[:8] if head else None,
            "upstream": upstream,
            "upstreamSha": upstream_sha,
            "baseRef": base_ref,
            "baseSha": base_sha,
            "baseShaShort": base_sha[:8] if base_sha else None,
            "dirty": dirty,
            "unpushed": bool(head and upstream_sha and head != upstream_sha),
            "pushed": None if not upstream_sha else head == upstream_sha,
            "branchScopeAvailable": bool(base_sha),
            "worktreeExists": True,
        })
        if summary_only:
            if upstream_sha and head:
                try:
                    behind, ahead = map(int, git.run(["rev-list", "--left-right", "--count", f"{upstream_sha}...{head}"]).stdout.split())
                    result.update(ahead=ahead, behind=behind, unpushed=ahead > 0, pushed=ahead == 0)
                except WorkbenchError as error:
                    return self._repository_error(result, started, error)
            result["observedAt"] = _now()
            result["durationMs"] = max(0, round((time.monotonic() - started) * 1000))
            return result
        if dirty:
            try:
                working = [_file_dict(item) for item in git.changed_files("working")]
                result["workingChanges"] = _count(working)
                result["dirtyPaths"] = [item["path"] for item in working]
            except WorkbenchError as exc:
                result["issues"].append(exc.as_dict())
        if base_sha and head and base_sha != head:
            try:
                branch_files = [_file_dict(item) for item in git.changed_files("branch", base=base_sha)]
                result["changes"] = _count(branch_files)
            except WorkbenchError as exc:
                result["changeIssues"] = [exc.as_dict()]
        result["changesLoaded"] = True
        if upstream_sha and head:
            try:
                ahead_behind = git.run(["rev-list", "--left-right", "--count", f"{upstream_sha}...{head}"], check=False).stdout.strip().split()
                if len(ahead_behind) == 2:
                    result["behind"] = int(ahead_behind[0])
                    result["ahead"] = int(ahead_behind[1])
                    result["unpushed"] = result["ahead"] > 0
                    result["pushed"] = result["ahead"] == 0
            except WorkbenchError as exc:
                result["issues"].append(exc.as_dict())
                result["status"] = "error"
        result["observedAt"] = _now()
        result["durationMs"] = max(0, round((time.monotonic() - started) * 1000))
        return result

    @staticmethod
    def _repository_error(result: dict[str, Any], started: float, error: WorkbenchError) -> dict[str, Any]:
        result["status"] = "error"
        result["issues"].append(error.as_dict())
        result["observedAt"] = _now()
        result["durationMs"] = max(0, round((time.monotonic() - started) * 1000))
        return result

    def _summary(
        self,
        workspace: Mapping[str, Any],
        *,
        observed: list[dict[str, Any]] | None = None,
        summary_only: bool = False,
    ) -> dict[str, Any]:
        repositories = list(workspace.get("repositories") or [])
        if observed is None:
            observed = []
            for repository in repositories:
                if not isinstance(repository, Mapping):
                    continue
                try:
                    observed.append(self._observe_repository(workspace, repository, summary_only=summary_only))
                except Exception as exc:
                    observed.append({
                        "id": repository.get("id"),
                        "name": repository.get("name") or repository.get("id"),
                        "repoPath": repository.get("repoPath") or repository.get("path"),
                        "status": "error",
                        "branch": None,
                        "head": None,
                        "headShort": None,
                        "baseRef": None,
                        "baseSha": None,
                        "baseShaShort": None,
                        "upstream": None,
                        "upstreamSha": None,
                        "ahead": None,
                        "behind": None,
                        "pushed": None,
                        "dirty": False,
                        "unpushed": False,
                        "dirtyPaths": [],
                        "branchScopeAvailable": False,
                        "worktreeExists": False,
                        "changeIssues": [],
                        "changesLoaded": False,
                        "workingChanges": {"files": 0, "additions": 0, "deletions": 0, "binaryFiles": 0},
                        "changes": {"files": 0, "additions": 0, "deletions": 0, "binaryFiles": 0},
                        "issues": [{"code": "repository_observation_failed", "message": str(exc)}],
                    })
        dirty = sum(1 for repository in observed if repository.get("dirty"))
        unpushed = sum(1 for repository in observed if repository.get("unpushed"))
        issues = [*workspace.get("issues", []), *[issue for repository in observed for issue in repository.get("issues", []) if isinstance(issue, Mapping)]]
        blockers = [
            issue for repository in observed
            for issue in repository.get("issues", [])
            if isinstance(issue, Mapping) and str(issue.get("code") or "") not in {"git_timeout", "observation_timeout"}
        ]
        attention_reasons: list[str] = []
        if dirty:
            attention_reasons.append("dirty")
        if unpushed:
            attention_reasons.append("unpushed")
        if blockers:
            attention_reasons.append("needs-review")
        return {
            "id": workspace.get("id"),
            "displayName": workspace.get("displayName") or workspace.get("name") or workspace.get("id"),
            "kind": workspace.get("kind") or "managed",
            "managed": bool(workspace.get("managed", True)),
            "description": workspace.get("description") or "",
            "state": workspace.get("state") or "active",
            **({"deletion": _json(workspace.get("deletion"))} if isinstance(workspace.get("deletion"), Mapping) else {}),
            "sourceRoot": workspace.get("sourceRoot"),
            "treePath": workspace.get("treePath"),
            "repositoryCount": len(observed),
            "dirty": dirty > 0,
            "dirtyRepositoryCount": dirty,
            "dirtyRepositories": dirty,
            "unpushed": unpushed > 0,
            "unpushedRepositoryCount": unpushed,
            "unpushedRepositories": unpushed,
            "claim": workspace.get("claim"),
            "blockerCount": len(blockers),
            "attentionReasons": attention_reasons,
            "issues": issues,
            "createdAt": workspace.get("createdAt"),
            "updatedAt": workspace.get("updatedAt"),
            "observedAt": _now(),
            "observationStale": False,
            **({"toolchain": self.toolchain.summary(workspace)} if self.toolchain else {}),
        }

    def _roster_summary(self, workspace: Mapping[str, Any]) -> dict[str, Any]:
        summary = self._summary(workspace, observed=[])
        summary.update(
            repositoryCount=len(workspace.get("repositories", [])),
            dirty=None,
            dirtyRepositoryCount=None,
            dirtyRepositories=0,
            unpushed=None,
            unpushedRepositoryCount=None,
            unpushedRepositories=0,
            observedAt=None,
            observationStale=True,
        )
        return summary

    def _list_fingerprint(self) -> str:
        parts = [self.config.digest]
        for workspace in self.provider.list():
            parts.append(str(workspace.get("id")))
            parts.append(str(workspace.get("state") or "active"))
            parts.append(str(workspace.get("updatedAt") or ""))
            parts.append(json.dumps(_json(workspace.get("deletion")), sort_keys=True))
            for repository in workspace.get("repositories", []):
                if not isinstance(repository, Mapping):
                    continue
                path = Path(str(repository.get("worktreePath") or repository.get("sourcePath") or ""))
                parts.append(f"{repository.get('id')}:{path}:{path.is_dir()}")
        return hashlib.sha256("\n".join(parts).encode()).hexdigest()

    def workspace_list(self, params: Mapping[str, Any]) -> dict[str, Any]:
        # The roster is intentionally independent from Git observation. A
        # project can contain many historical Workspaces, so the selector
        # must not wait for every repository before it can render anything.
        key = f"{self.config.digest}:workspace.list.roster.v2:{json.dumps(_json(params), sort_keys=True)}"
        fingerprint = self._list_fingerprint()

        def produce() -> dict[str, Any]:
            started = time.monotonic()
            targets = [workspace for workspace in self.provider.list() if params.get("includeRemoved") or workspace.get("state") != "removed"]
            workspaces = [self._roster_summary(workspace) for workspace in targets]
            candidates = discover_git_repositories(self.config) if self.config.discovery.mode in {"auto", "hybrid"} else []
            return {
                "schemaVersion": PROTOCOL_VERSION,
                "project": {"id": self.config.project_id, "displayName": self.config.display_name},
                "workspaces": workspaces,
                "capabilities": self.provider.capabilities(),
                "discoveredCandidates": [repository.__dict__ for repository in candidates],
                "observation": {"state": "ready", "observedAt": _now(), "durationMs": round((time.monotonic() - started) * 1000), "deferred": True},
            }

        return self.cache.read(key, fingerprint, produce)

    def workspace_detail(self, params: Mapping[str, Any]) -> dict[str, Any]:
        workspace_id = str(params.get("workspaceId") or "")
        workspace = self._workspace(workspace_id)
        key = f"{self.config.digest}:workspace.detail:{workspace_id}:{json.dumps(_json(params), sort_keys=True)}"
        fingerprints = [
            f"state:{workspace.get('state') or 'active'}:{workspace.get('updatedAt') or ''}:{json.dumps(_json(workspace.get('deletion')), sort_keys=True)}",
            *[self._repository_fingerprint(repository) for repository in workspace.get("repositories", []) if isinstance(repository, Mapping)],
        ]
        fingerprint = hashlib.sha256("\n".join(fingerprints).encode()).hexdigest()

        def produce() -> dict[str, Any]:
            started = time.monotonic()
            repositories: list[dict[str, Any]] = []
            with self._detail_slots:
                executor = self._repository_executor
                futures = {executor.submit(self._observe_repository, workspace, repository): repository for repository in workspace.get("repositories", []) if isinstance(repository, Mapping)}
                for future in as_completed(futures):
                    try:
                        repositories.append(future.result())
                    except Exception as exc:
                        target = futures[future]
                        repositories.append({
                            "name": target.get("name") or target.get("id"), "repoPath": target.get("repoPath"),
                            "status": "error", "branch": "", "headShort": "", "baseRef": "", "baseShaShort": "",
                            "dirty": False, "dirtyPaths": [], "ahead": None, "behind": None, "pushed": None,
                            "workingChanges": _count([]), "changes": _count([]), "changeIssues": [],
                            "issues": [{"code": "repository_observation_failed", "message": str(exc)}],
                        })
            repositories.sort(key=lambda repository: str(repository.get("repoPath") or repository.get("id") or ""))
            summary = self._summary({**workspace, "repositories": repositories}, observed=repositories)
            return {
                "schemaVersion": PROTOCOL_VERSION,
                "workspace": summary,
                "repositories": repositories,
                "observation": {"state": "partial" if _partial(repositories) else "ready", "observedAt": _now(), "durationMs": round((time.monotonic() - started) * 1000)},
            }

        return self.cache.read(key, fingerprint, produce)

    def workspace_runtime(self, params: Mapping[str, Any]) -> dict[str, Any]:
        workspace = self._workspace(str(params.get("workspaceId") or ""))
        if not workspace.get("managed"):
            raise WorkbenchError("live workspace is not managed", code="workspace_not_managed")
        if workspace.get("repositoryAdditions"):
            raise WorkbenchError("finish or recover repository additions before starting a task", code="repository_addition_pending")
        runtime_repositories: list[dict[str, Any]] = []
        for repository in workspace.get("repositories", []):
            path = Path(str(repository.get("worktreePath") or "")).resolve()
            if not path.is_dir():
                raise WorkbenchError("worktree is unavailable", code="worktree_missing")
            git = self._git(repository)
            if git.root() != path or git.branch() != repository.get("branch"):
                raise WorkbenchError("worktree Git identity changed", code="worktree_identity_changed")
            head = git.head()
            branch = git.branch()
            base_ref, base_sha = self._base(repository, git)
            status_result = git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], check=False)
            staged_result = git.run(["diff", "--no-ext-diff", "--cached", "--binary"], check=False)
            if status_result.returncode != 0 or staged_result.returncode != 0:
                raise WorkbenchError("Git status is unavailable", code="git_runtime_unavailable")
            status = status_result.stdout
            staged = staged_result.stdout
            if head:
                working_result = git.run(["diff", "--no-ext-diff", "--binary", "HEAD"], check=False)
                if working_result.returncode != 0:
                    raise WorkbenchError("Git working-tree diff is unavailable", code="git_runtime_unavailable")
                working = working_result.stdout
            else:
                working = ""
            dirty_paths: list[str] = []
            file_digests: list[str] = []
            for item_status, item_path in git.status_porcelain():
                path_value = str(item_path).split("\x00")[-1]
                if not path_value:
                    continue
                relative_path = Path(path_value)
                if relative_path.is_absolute() or ".." in relative_path.parts:
                    dirty_paths.append(path_value)
                    file_digests.append(f"{path_value}:outside")
                    continue
                dirty_paths.append(path_value)
                candidate = path.joinpath(*relative_path.parts)
                resolved_candidate = candidate.resolve()
                try:
                    resolved_candidate.relative_to(path)
                except ValueError:
                    file_digests.append(f"{path_value}:outside")
                    continue
                try:
                    item = candidate.lstat()
                    symlink = False
                    current = path
                    for segment in relative_path.parts:
                        current = current / segment
                        segment_stat = current.lstat()
                        if stat.S_ISLNK(segment_stat.st_mode):
                            symlink = True
                            break
                    if symlink or stat.S_ISLNK(item.st_mode):
                        link = os.readlink(current if symlink else candidate)
                        file_digests.append(f"{path_value}:symlink:{link}")
                    elif stat.S_ISREG(item.st_mode):
                        hasher = hashlib.sha256()
                        with candidate.open("rb") as stream:
                            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                                hasher.update(chunk)
                        file_digests.append(f"{path_value}:file:{item.st_size}:{hasher.hexdigest()}")
                    else:
                        file_digests.append(f"{path_value}:special:{item.st_mode}")
                except OSError:
                    file_digests.append(f"{path_value}:unreadable")
            dirty_paths.sort()
            file_digests.sort()
            index_digest = hashlib.sha256(staged.encode("utf-8", errors="replace")).hexdigest()
            worktree_digest = hashlib.sha256((working + "\x00".join(file_digests)).encode("utf-8", errors="replace")).hexdigest()
            status_digest = hashlib.sha256(status.encode("utf-8", errors="replace")).hexdigest()
            runtime_repositories.append({
                "id": repository.get("id"),
                "repoPath": repository.get("repoPath"),
                "worktreePath": str(path),
                "branch": branch,
                "baseRef": base_ref,
                "baseSha": base_sha,
                "head": head,
                "indexDigest": index_digest,
                "worktreeDigest": worktree_digest,
                "statusDigest": status_digest,
                "dirtyPaths": dirty_paths,
            })
        toolchain = self.toolchain.summary(workspace) if self.toolchain else None
        if toolchain and toolchain["status"] != "ready":
            raise WorkbenchError("prepare runtimes before execution", code="toolchain_not_ready", details=toolchain)
        return {
            "schemaVersion": PROTOCOL_VERSION,
            "workspaceId": workspace.get("id"),
            "managed": bool(workspace.get("managed", True)),
            "treePath": workspace.get("treePath"),
            "sourceRoot": workspace.get("sourceRoot"),
            "repositories": runtime_repositories,
            "capabilities": self.provider.capabilities(),
            "toolchain": toolchain,
        }

    def _repository_result(self, params: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any], GitClient]:
        workspace = self._workspace(str(params.get("workspaceId") or ""))
        repository = self._target(workspace, str(params.get("repoPath") or params.get("repositoryId") or ""))
        git = self._git(repository)
        if not git.repository.is_dir():
            raise WorkbenchError("repository worktree is unavailable", code="worktree_missing")
        return workspace, repository, git

    def repository_graph(self, params: Mapping[str, Any]) -> dict[str, Any]:
        workspace, repository, git = self._repository_result(params)
        mode = str(params.get("historyMode") or ("full" if workspace.get("kind") == "live" else "branch"))
        max_commits = max(1, min(int(params.get("maxCommits", 50)), 200))
        key = f"{self.config.digest}:repository.graph:{workspace.get('id')}:{repository.get('id')}:{mode}:{max_commits}"
        fingerprint = self._repository_fingerprint(repository) + f":{mode}:{repository.get('baseSha') or ''}"

        def produce() -> dict[str, Any]:
            _, base_sha = self._base(repository, git)
            result = git.graph(mode=mode, base=base_sha, max_commits=max_commits)
            branch = git.branch()
            head = git.head()
            upstream_ref, _ = git.upstream()
            refs = []
            for ref in result.get("refs", []):
                if not isinstance(ref, Mapping):
                    continue
                decorated = {
                    **dict(ref),
                    "isHead": bool(branch and ref.get("kind") == "local" and ref.get("shortName") == branch),
                    "isUpstream": bool(upstream_ref and ref.get("shortName") == upstream_ref),
                }
                refs.append(decorated)
            refs_by_sha: dict[str, list[dict[str, Any]]] = {}
            for ref in refs:
                refs_by_sha.setdefault(str(ref.get("sha") or ""), []).append(ref)
            for node in result.get("nodes", []):
                if not isinstance(node, dict):
                    continue
                node_refs = refs_by_sha.get(str(node.get("sha") or ""), [])
                node["refs"] = node_refs
                node["decorations"] = [str(ref.get("shortName") or ref.get("name") or "") for ref in node_refs]
                if node.get("sha") == head:
                    node["decorations"] = ["HEAD", *[value for value in node["decorations"] if value != "HEAD"]]
            return {
                "schemaVersion": PROTOCOL_VERSION,
                "workspaceId": workspace.get("id"),
                "repoPath": repository.get("repoPath"),
                "branch": branch,
                "head": head,
                "historyMode": mode,
                "baseSha": base_sha,
                "truncated": bool(result.get("hasOlder")),
                **result,
                "refs": refs,
                "observation": {"state": "ready", "observedAt": _now()},
            }

        return self.cache.read(key, fingerprint, produce)

    def repository_changes(self, params: Mapping[str, Any]) -> dict[str, Any]:
        workspace, repository, git = self._repository_result(params)
        scope = str(params.get("scope") or "branch")
        commit = str(params.get("commitSha") or "") or None
        key = f"{self.config.digest}:repository.changes:{workspace.get('id')}:{repository.get('id')}:{scope}:{commit or ''}"
        fingerprint = self._repository_fingerprint(repository) + f":{scope}:{repository.get('baseSha') or ''}:{commit or ''}"

        def produce() -> dict[str, Any]:
            _, base_sha = self._base(repository, git)
            files = [_file_dict(item) for item in git.changed_files(scope, base=base_sha, commit=commit)]
            return {
                "schemaVersion": PROTOCOL_VERSION,
                "workspaceId": workspace.get("id"),
                "repoPath": repository.get("repoPath"),
                "scope": scope,
                "baseSha": base_sha,
                "head": git.head(),
                "files": files,
                "summary": _count(files),
                "issues": [],
                "observation": {"state": "ready", "observedAt": _now()},
            }

        return self.cache.read(key, fingerprint, produce)

    def repository_diff(self, params: Mapping[str, Any]) -> dict[str, Any]:
        workspace, repository, git = self._repository_result(params)
        path = str(params.get("path") or "")
        if not path:
            raise WorkbenchError("path is required", code="path_required")
        scope = str(params.get("scope") or "branch")
        commit = str(params.get("commitSha") or "") or None
        key = f"{self.config.digest}:repository.diff:{workspace.get('id')}:{repository.get('id')}:{scope}:{commit or ''}:{path}"
        relative = Path(path)
        if relative.is_absolute() or ".." in relative.parts:
            raise WorkbenchError("invalid diff path", code="path_invalid")
        try:
            marker = (git.repository / relative).lstat()
            file_marker = f"{marker.st_mtime_ns}:{marker.st_size}"
        except OSError:
            file_marker = "missing"
        fingerprint = self._repository_fingerprint(repository) + f":{scope}:{repository.get('baseSha') or ''}:{commit or ''}:{path}:{file_marker}"

        def produce() -> dict[str, Any]:
            _, base_sha = self._base(repository, git)
            patch, left, right = git.diff(scope, path, base=base_sha, commit=commit)
            return {
                "schemaVersion": PROTOCOL_VERSION,
                "workspaceId": workspace.get("id"),
                "repoPath": repository.get("repoPath"),
                "path": path,
                "scope": scope,
                "baseSha": left,
                "left": left,
                "right": right,
                "patch": patch.encode("utf-8")[: self.config.max_diff_bytes].decode("utf-8", errors="ignore"),
                "head": right or git.head(),
                "binary": "Binary files " in patch or "GIT binary patch" in patch,
                "truncated": len(patch.encode("utf-8")) > self.config.max_diff_bytes,
                "observation": {"state": "ready", "observedAt": _now()},
            }

        return self.cache.read(key, fingerprint, produce)

    def review_compare(self, params: Mapping[str, Any]) -> dict[str, Any]:
        from .review import aggregate, compare_entry
        raw_ids = params.get("workspaceIds")
        if not isinstance(raw_ids, list) or not raw_ids:
            raise WorkbenchError("workspaceIds are required", code="workspace_required")
        ids = list(dict.fromkeys(str(value) for value in raw_ids))
        targets = params.get("targetRefs") or {}
        if not isinstance(targets, Mapping):
            raise WorkbenchError("targetRefs must be an object", code="request_invalid")
        entries: dict[str, list[dict[str, Any]]] = {}
        for workspace_id in ids:
            workspace = self._workspace(workspace_id)
            if not workspace.get("managed"):
                raise WorkbenchError("live workspace is not reviewable", code="live_workspace_not_reviewable")
            for repository in workspace.get("repositories", []):
                repo_path = repository["repoPath"]
                target = str(targets.get(repo_path) or repository.get("baseRef") or "")
                entries.setdefault(repo_path, []).append(compare_entry(self._git(repository), repository, workspace_id, target))
        repositories = aggregate(entries)
        issues = [issue for repository in repositories for entry in repository["entries"] for issue in entry["issues"]]
        return {
            "schemaVersion": PROTOCOL_VERSION, "workspaceIds": ids, "repositories": repositories,
            "overlaps": [{"repoPath": repository["repoPath"], **item} for repository in repositories for item in repository["overlaps"]],
            "testEvidence": None, "issues": issues,
            "observation": {"state": "partial" if issues else "ready", "observedAt": _now(), "issues": issues},
        }

    def review_brief(self, params: Mapping[str, Any]) -> dict[str, Any]:
        from .review import brief
        result = self.review_compare(params)
        return {**result, "brief": brief(result["repositories"])}


class JsonLineHandler(socketserver.StreamRequestHandler):
    """Request handler shared by the Unix Socket server."""

    def handle(self) -> None:
        service: ObserverService = self.server.observer_service  # type: ignore[attr-defined]
        for raw_line in self.rfile:
            if not raw_line.strip():
                continue
            request_id: Any = None
            try:
                request = json.loads(raw_line.decode("utf-8"))
                if not isinstance(request, Mapping):
                    raise WorkbenchError("request must be an object", code="request_invalid")
                request_id = request.get("id")
                result = service.handle(str(request.get("method") or ""), request.get("params") if isinstance(request.get("params"), Mapping) else {})
                response = {"id": request_id, "ok": True, "result": _json(result)}
            except WorkbenchError as exc:
                response = {"id": request_id, "ok": False, "error": exc.as_dict()}
            except Exception as exc:
                response = {"id": request_id, "ok": False, "error": {"code": "observer_internal_error", "message": str(exc)}}
            try:
                self.wfile.write((json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return


class ThreadingUnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, socket_path: str, service: ObserverService) -> None:
        self.observer_service = service
        super().__init__(socket_path, JsonLineHandler)


def remove_stale_socket(path: Path) -> None:
    if not path.exists():
        return
    if not stat.S_ISSOCK(path.stat().st_mode):
        raise WorkbenchError(f"socket path is not a Unix Socket: {path}", code="socket_path_invalid")
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.settimeout(0.2)
        probe.connect(str(path))
    except (ConnectionRefusedError, FileNotFoundError):
        path.unlink(missing_ok=True)
    except socket.timeout as error:
        raise WorkbenchError("existing service did not answer; socket retained", code="observer_busy") from error
    finally:
        probe.close()


def serve_socket(service: ObserverService, socket_path: Path) -> None:
    socket_path = socket_path.expanduser().resolve()
    socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    remove_stale_socket(socket_path)
    old_umask = os.umask(0o077)
    try:
        server = ThreadingUnixServer(str(socket_path), service)
    finally:
        os.umask(old_umask)
    try:
        socket_path.chmod(0o600)
        server.serve_forever(poll_interval=0.5)
    finally:
        server.shutdown()
        server.server_close()
        socket_path.unlink(missing_ok=True)
        service.close()


def serve_stdio(service: ObserverService, input_stream: Any, output_stream: Any) -> None:
    try:
        for line in input_stream:
            if not line.strip():
                continue
            request_id: Any = None
            try:
                request = json.loads(line)
                if not isinstance(request, Mapping):
                    raise WorkbenchError("request must be an object", code="request_invalid")
                request_id = request.get("id")
                result = service.handle(str(request.get("method") or ""), request.get("params") if isinstance(request.get("params"), Mapping) else {})
                response = {"id": request_id, "ok": True, "result": _json(result)}
            except WorkbenchError as exc:
                response = {"id": request_id, "ok": False, "error": exc.as_dict()}
            except Exception as exc:
                response = {"id": request_id, "ok": False, "error": {"code": "observer_internal_error", "message": str(exc)}}
            output_stream.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            output_stream.flush()
    finally:
        service.close()
