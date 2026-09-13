from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any, Iterable, Mapping

from .errors import WorkbenchError
from .models import RepositoryConfig


CONFIG_SCHEMA_VERSION = 1
DEFAULT_EXCLUDES = (".git", "node_modules", "vendor", ".venv", "__pycache__", "dist", "build")
DEFAULT_GIT_TIMEOUT_SECONDS = 3.0
DEFAULT_WORKSPACE_OPERATION_TIMEOUT_SECONDS = 120.0


@dataclass(frozen=True)
class DiscoveryConfig:
    mode: str = "hybrid"
    roots: tuple[Path, ...] = ()
    max_depth: int = 3
    exclude: tuple[str, ...] = DEFAULT_EXCLUDES
    follow_symlinks: bool = False


@dataclass(frozen=True)
class ProjectConfig:
    project_id: str
    display_name: str
    config_path: Path
    source_root: Path
    workspace_root: Path
    state_root: Path
    socket_path: Path
    repositories: tuple[RepositoryConfig, ...]
    discovery: DiscoveryConfig = field(default_factory=DiscoveryConfig)
    main_workspace_name: str = "Main workspace"
    management_enabled: bool = True
    toolchain: Mapping[str, Any] | None = None
    agent_enabled: bool = False
    git_timeout_seconds: float = DEFAULT_GIT_TIMEOUT_SECONDS
    workspace_operation_timeout_seconds: float = DEFAULT_WORKSPACE_OPERATION_TIMEOUT_SECONDS
    max_diff_bytes: int = 256 * 1024
    cache_max_entries: int = 500
    cache_max_bytes: int = 32 * 1024 * 1024
    sqlite_max_entries: int = 5000
    cache_ttl_seconds: float = 3.0
    records_root: Path | None = None
    trees_root: Path | None = None

    @property
    def digest(self) -> str:
        value = {
            "projectId": self.project_id,
            "sourceRoot": str(self.source_root),
            "workspaceRoot": str(self.workspace_root),
            "recordsRoot": str(self.records_root),
            "treesRoot": str(self.trees_root),
            "repositories": [repository.__dict__ for repository in self.repositories],
            "managementEnabled": self.management_enabled,
            "toolchain": self.toolchain,
            "agentEnabled": self.agent_enabled,
            "mainWorkspaceName": self.main_workspace_name,
            "maxDiffBytes": self.max_diff_bytes,
            "discovery": {
                "mode": self.discovery.mode,
                "roots": [str(root) for root in self.discovery.roots],
                "maxDepth": self.discovery.max_depth,
                "exclude": list(self.discovery.exclude),
            },
        }
        return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:16]

    def repository_by_id(self, repository_id: str) -> RepositoryConfig:
        value = str(repository_id).strip()
        for repository in self.repositories:
            if repository.id == value or repository.path == value:
                return repository
        raise WorkbenchError(f"repository does not exist: {value}", code="repository_missing")

    def repository_path(self, repository: RepositoryConfig, *, root: Path | None = None) -> Path:
        base = (root or self.source_root).resolve()
        candidate = Path(repository.path).expanduser()
        if not candidate.is_absolute():
            candidate = base / candidate
        candidate = candidate.resolve()
        try:
            candidate.relative_to(base)
        except ValueError as exc:
            raise WorkbenchError(
                f"repository path is outside the configured source root: {repository.path}",
                code="path_outside_root",
            ) from exc
        return candidate


def _string(value: Any, *, field_name: str, default: str | None = None) -> str | None:
    if value is None:
        return default
    if not isinstance(value, str) or not value.strip():
        raise WorkbenchError(f"{field_name} must be a non-empty string", code="config_invalid")
    return value.strip()


def _path(value: Any, *, base: Path, field_name: str, default: Path | None = None) -> Path:
    raw = _string(value, field_name=field_name, default=str(default) if default else None)
    if raw is None:
        raise WorkbenchError(f"{field_name} is required", code="config_invalid")
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = base / candidate
    return candidate.resolve()


def _safe_id(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip()).strip("-.")
    return slug or "repository"


def repository_id_for_path(path: Path, root: Path, *, used: Iterable[str] = ()) -> str:
    relative = str(path.resolve().relative_to(root.resolve()))
    candidate = _safe_id(relative.replace(os.sep, "-"))
    used_ids = set(used)
    if candidate not in used_ids:
        return candidate
    suffix = hashlib.sha1(relative.encode()).hexdigest()[:8]
    return f"{candidate}-{suffix}"


def discover_git_repositories(config: ProjectConfig) -> list[RepositoryConfig]:
    """Find Git checkouts only inside configured roots.

    Discovery never mutates the config. Callers can present the returned list
    as candidates and explicitly accept them in a later operation.
    """

    if config.discovery.mode == "manual":
        return []
    found: list[RepositoryConfig] = []
    used = {repository.id for repository in config.repositories}
    explicit_paths = {str(config.repository_path(repository)) for repository in config.repositories}
    for root in config.discovery.roots:
        root = root.resolve()
        if not root.is_dir():
            continue
        stack: list[tuple[Path, int]] = [(root, 0)]
        visited: set[Path] = set()
        while stack:
            current, depth = stack.pop()
            resolved = current.resolve()
            if resolved in visited or not resolved.is_relative_to(root) or not resolved.is_relative_to(config.source_root):
                continue
            visited.add(resolved)
            if current.name in config.discovery.exclude and current != root:
                continue
            git_marker = current / ".git"
            if git_marker.is_dir() or git_marker.is_file():
                if str(current) not in explicit_paths:
                    repository_id = repository_id_for_path(current, root, used=used)
                    used.add(repository_id)
                    found.append(RepositoryConfig(id=repository_id, path=str(current), display_name=current.name, enabled=False))
                continue
            if depth >= config.discovery.max_depth:
                continue
            try:
                entries = list(os.scandir(current))
            except OSError:
                continue
            for entry in reversed(entries):
                if entry.name in config.discovery.exclude or entry.name.startswith("."):
                    continue
                if entry.is_dir(follow_symlinks=config.discovery.follow_symlinks):
                    stack.append((Path(entry.path), depth + 1))
    found.sort(key=lambda repository: (repository.path.casefold(), repository.id))
    return found


def load_config(config_path: str | Path) -> ProjectConfig:
    path = Path(config_path).expanduser().resolve()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise WorkbenchError(f"config does not exist: {path}", code="config_missing") from exc
    except json.JSONDecodeError as exc:
        raise WorkbenchError(f"config is not valid JSON: {path}", code="config_invalid") from exc
    if not isinstance(raw, Mapping):
        raise WorkbenchError("config must contain an object", code="config_invalid")
    if int(raw.get("schemaVersion", CONFIG_SCHEMA_VERSION)) != CONFIG_SCHEMA_VERSION:
        raise WorkbenchError("unsupported config schema version", code="config_invalid")
    base = path.parent
    project = raw.get("project") if isinstance(raw.get("project"), Mapping) else {}
    project_id = _string(project.get("id"), field_name="project.id") or _safe_id(path.stem)
    display_name = _string(project.get("displayName"), field_name="project.displayName") or project_id
    source_root = _path(raw.get("sourceRoot"), base=base, field_name="sourceRoot", default=base)
    workspace_root = _path(raw.get("workspaceRoot"), base=base, field_name="workspaceRoot", default=source_root / ".workspace-workbench" / "workspaces")
    state_root = _path(raw.get("stateRoot"), base=base, field_name="stateRoot", default=source_root / ".workspace-workbench")
    socket_value = raw.get("socketPath")
    if socket_value == "auto":
        socket_value = Path.home() / ".config" / "workspace-workbench" / (hashlib.sha256(str(path).encode()).hexdigest()[:12] + ".sock")
        socket_value = str(socket_value)
    socket_path = _path(socket_value, base=base, field_name="socketPath", default=state_root / "observer.sock")
    discovery_raw = raw.get("discovery") if isinstance(raw.get("discovery"), Mapping) else {}
    mode = _string(discovery_raw.get("mode"), field_name="discovery.mode", default="hybrid") or "hybrid"
    if mode not in {"manual", "auto", "hybrid"}:
        raise WorkbenchError("discovery.mode must be manual, auto, or hybrid", code="config_invalid")
    roots_raw = discovery_raw.get("roots", [str(source_root)])
    if not isinstance(roots_raw, list):
        raise WorkbenchError("discovery.roots must be an array", code="config_invalid")
    roots = tuple(_path(value, base=source_root, field_name="discovery.root") for value in roots_raw)
    exclude_raw = discovery_raw.get("exclude", list(DEFAULT_EXCLUDES))
    if not isinstance(exclude_raw, list) or not all(isinstance(value, str) and value for value in exclude_raw):
        raise WorkbenchError("discovery.exclude must be an array of strings", code="config_invalid")
    try:
        max_depth = max(0, min(int(discovery_raw.get("maxDepth", 3)), 12))
    except (TypeError, ValueError) as exc:
        raise WorkbenchError("discovery.maxDepth must be an integer", code="config_invalid") from exc
    repositories_raw = raw.get("repositories", [])
    if not isinstance(repositories_raw, list):
        raise WorkbenchError("repositories must be an array", code="config_invalid")
    repositories: list[RepositoryConfig] = []
    used_ids: set[str] = set()
    for item in repositories_raw:
        if not isinstance(item, Mapping):
            raise WorkbenchError("each repository must be an object", code="config_invalid")
        repository_id = _string(item.get("id"), field_name="repository.id")
        repository_path = _string(item.get("path"), field_name="repository.path")
        if not repository_id or not repository_path or repository_id in used_ids:
            raise WorkbenchError("repository ids must be unique and non-empty", code="config_invalid")
        used_ids.add(repository_id)
        metadata = item.get("metadata") if isinstance(item.get("metadata"), Mapping) else {}
        repositories.append(
            RepositoryConfig(
                id=repository_id,
                path=repository_path,
                display_name=_string(item.get("displayName"), field_name="repository.displayName", default=None),
                enabled=bool(item.get("enabled", True)),
                role=_string(item.get("role"), field_name="repository.role", default=None),
                default_base=_string(item.get("defaultBase"), field_name="repository.defaultBase", default=None),
                metadata=dict(metadata),
            )
        )
    limits = raw.get("limits") if isinstance(raw.get("limits"), Mapping) else {}
    try:
        git_timeout = max(0.5, min(float(limits.get("gitTimeoutSeconds", DEFAULT_GIT_TIMEOUT_SECONDS)), 30.0))
        workspace_operation_timeout = max(
            5.0,
            min(
                float(limits.get("workspaceOperationTimeoutSeconds", DEFAULT_WORKSPACE_OPERATION_TIMEOUT_SECONDS)),
                600.0,
            ),
        )
        max_diff = max(16 * 1024, min(int(limits.get("maxDiffBytes", 256 * 1024)), 4 * 1024 * 1024))
        cache_entries = max(20, min(int(limits.get("cacheMaxEntries", 500)), 10_000))
        cache_bytes = max(1 * 1024 * 1024, min(int(limits.get("cacheMaxBytes", 32 * 1024 * 1024)), 512 * 1024 * 1024))
        sqlite_entries = max(100, min(int(limits.get("sqliteMaxEntries", 5000)), 100_000))
        cache_ttl = max(0.5, min(float(limits.get("cacheTtlSeconds", 3.0)), 60.0))
    except (TypeError, ValueError) as exc:
        raise WorkbenchError("limits must contain numeric values", code="config_invalid") from exc
    main = raw.get("mainWorkspace") if isinstance(raw.get("mainWorkspace"), Mapping) else {}
    main_name = _string(main.get("displayName"), field_name="mainWorkspace.displayName", default="Main workspace") or "Main workspace"
    management = raw.get("management") if isinstance(raw.get("management"), Mapping) else {}
    return ProjectConfig(
        project_id=project_id,
        display_name=display_name,
        config_path=path,
        source_root=source_root,
        workspace_root=workspace_root,
        records_root=_path(raw.get("recordsRoot"), base=base, field_name="recordsRoot", default=workspace_root / "records"),
        trees_root=_path(raw.get("treesRoot"), base=base, field_name="treesRoot", default=workspace_root / "trees"),
        state_root=state_root,
        socket_path=socket_path,
        repositories=tuple(repositories),
        discovery=DiscoveryConfig(
            mode=mode,
            roots=roots,
            max_depth=max_depth,
            exclude=tuple(exclude_raw),
            follow_symlinks=bool(discovery_raw.get("followSymlinks", False)),
        ),
        main_workspace_name=main_name,
        management_enabled=bool(management.get("enabled", True)),
        toolchain=raw.get("toolchain") if isinstance(raw.get("toolchain"), Mapping) else None,
        agent_enabled=isinstance(raw.get("agent"), Mapping) and raw["agent"].get("provider") == "paseo",
        git_timeout_seconds=git_timeout,
        workspace_operation_timeout_seconds=workspace_operation_timeout,
        max_diff_bytes=max_diff,
        cache_max_entries=cache_entries,
        cache_max_bytes=cache_bytes,
        sqlite_max_entries=sqlite_entries,
        cache_ttl_seconds=cache_ttl,
    )
