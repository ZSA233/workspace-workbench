from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
from typing import Any, Iterable, Mapping, Protocol

from ..core.errors import WorkbenchError


class ToolchainProvider(Protocol):
    def summary(self, workspace: Mapping[str, Any]) -> dict[str, Any]: ...
    def prepare(self, workspace: Mapping[str, Any], repository_id: str) -> dict[str, Any]: ...
    def environment(self, workspace: Mapping[str, Any], repository_id: str | None = None) -> dict[str, str]: ...


@dataclass(frozen=True)
class RuntimeResolution:
    tool: str
    requested: str
    resolved: str
    executable: Path
    source: str


class RuntimeAdapter:
    """Tool-specific discovery and verification rules."""

    tool = ""
    command_names: tuple[str, ...] = ()
    version_args: tuple[str, ...] = ()
    version_pattern = re.compile(r"(\d+\.\d+(?:\.\d+)?)")

    def parse_version(self, output: str) -> str:
        match = self.version_pattern.search(output)
        return match.group(1) if match else ""

    def matches(self, resolved: str, requested: str) -> bool:
        return resolved == requested or resolved.startswith(requested + ".")

    def cache_paths(self, root: Path) -> dict[str, Path]:
        return {}


class GoRuntimeAdapter(RuntimeAdapter):
    tool = "go"
    command_names = ("go",)
    version_args = ("version",)
    version_pattern = re.compile(r"\bgo(\d+\.\d+(?:\.\d+)?)")

    def cache_paths(self, root: Path) -> dict[str, Path]:
        return {"GOCACHE": root / "go-build", "GOMODCACHE": root / "go-mod"}


class PythonRuntimeAdapter(RuntimeAdapter):
    tool = "python"
    command_names = ("python", "python3")
    version_args = ("--version",)
    version_pattern = re.compile(r"\bPython\s+(\d+\.\d+(?:\.\d+)?)")

    def cache_paths(self, root: Path) -> dict[str, Path]:
        return {"PIP_CACHE_DIR": root / "pip"}


class NodeRuntimeAdapter(RuntimeAdapter):
    tool = "node"
    command_names = ("node",)
    version_args = ("--version",)
    version_pattern = re.compile(r"\bv(\d+\.\d+(?:\.\d+)?)")

    def cache_paths(self, root: Path) -> dict[str, Path]:
        return {"NPM_CONFIG_CACHE": root / "npm"}


RUNTIME_ADAPTERS: dict[str, RuntimeAdapter] = {
    "go": GoRuntimeAdapter(),
    "python": PythonRuntimeAdapter(),
    "node": NodeRuntimeAdapter(),
}


class ProjectRuntimeManager:
    """Project runtime manager with system-runtime and mise backends.

    The manager name is retained for protocol compatibility. ``auto`` mode
    uses a matching system runtime first and only needs mise when a runtime is
    missing or has the wrong version.
    """

    def prepared_repository(self, workspace: Mapping[str, Any], repository_id: str) -> dict[str, Any]:
        return dict(self._load(workspace).get(repository_id, {}))

    def __init__(
        self,
        config: Mapping[str, Any],
        state_root: Path,
        *,
        cache_root: Path | None = None,
        cache_enabled: bool = True,
        config_root: Path | None = None,
    ) -> None:
        self.requirements = dict(config.get("repositories") or {})
        configured_mode = config.get("mode")
        configured_manager = config.get("manager")
        default_mode = "system" if str(configured_manager or "").strip().lower() == "system" else "auto"
        self.mode = str(configured_mode or default_mode).strip().lower()
        self.manager = str(configured_manager or ("system" if self.mode == "system" else "mise")).strip().lower()
        if self.manager not in {"mise", "system"}:
            raise WorkbenchError("toolchain.manager must be mise or system", code="config_invalid")
        if self.mode not in {"auto", "system", "mise"}:
            raise WorkbenchError("toolchain.mode must be auto, system, or mise", code="config_invalid")
        if self.mode == "mise" and self.manager != "mise":
            raise WorkbenchError("toolchain.mode mise requires the mise manager", code="config_invalid")
        if self.manager == "system" and self.mode != "system":
            raise WorkbenchError("toolchain.manager system requires toolchain.mode system", code="config_invalid")
        manager_path = config.get("managerPath")
        if manager_path is not None and (not isinstance(manager_path, str) or not manager_path.strip()):
            raise WorkbenchError("toolchain.managerPath must be a non-empty string", code="config_invalid")
        self.config_root = (config_root or Path.cwd()).expanduser().resolve()
        self.manager_path = manager_path.strip() if isinstance(manager_path, str) else None
        runtime_paths = config.get("runtimePaths") or []
        if not isinstance(runtime_paths, list) or not all(isinstance(value, str) and value.strip() for value in runtime_paths):
            raise WorkbenchError("toolchain.runtimePaths must be an array of strings", code="config_invalid")
        self.runtime_paths = tuple(self._config_path(value) for value in runtime_paths)
        self.root = state_root / "toolchains"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.cache_root = (cache_root or state_root / "cache").expanduser().resolve()
        self.cache_enabled = cache_enabled
        self.lock = threading.RLock()
        for tools in self.requirements.values():
            if not isinstance(tools, dict):
                raise WorkbenchError("runtime requirements must be objects", code="config_invalid")
            for tool, version in tools.items():
                if tool not in RUNTIME_ADAPTERS or not isinstance(version, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,2}", version):
                    raise WorkbenchError("unsupported runtime requirement", code="config_invalid")

    def _config_path(self, value: str) -> Path:
        candidate = Path(value).expanduser()
        return (self.config_root / candidate).resolve() if not candidate.is_absolute() else candidate.resolve()

    def _path(self, workspace: Mapping[str, Any]) -> Path:
        import hashlib
        return self.root / (hashlib.sha256(str(workspace["id"]).encode()).hexdigest() + ".json")

    def _load(self, workspace: Mapping[str, Any]) -> dict[str, Any]:
        try:
            value = json.loads(self._path(workspace).read_text())
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    @staticmethod
    def _unique_paths(values: list[Path]) -> list[Path]:
        result: list[Path] = []
        seen: set[str] = set()
        for value in values:
            candidate = value.expanduser()
            key = str(candidate)
            if key not in seen:
                seen.add(key)
                result.append(candidate)
        return result

    @staticmethod
    def _is_executable(path: Path) -> bool:
        return path.is_file() and os.access(path, os.X_OK)

    def _manager_candidates(self) -> list[Path]:
        candidates: list[Path] = []
        if self.manager_path:
            configured = self._config_path(self.manager_path)
            resolved = shutil.which(self.manager_path)
            candidates.append(Path(resolved) if resolved else configured)
            return self._unique_paths(candidates)
        resolved = shutil.which("mise")
        if resolved:
            candidates.append(Path(resolved))
        environment_override = os.environ.get("WORKSPACE_WORKBENCH_MISE", "").strip()
        if environment_override:
            candidates.append(Path(environment_override).expanduser())
        home = Path.home()
        candidates.extend([
            Path("/opt/homebrew/bin/mise"),
            Path("/usr/local/bin/mise"),
            Path("/usr/bin/mise"),
            home / ".local" / "bin" / "mise",
            home / ".mise" / "bin" / "mise",
            home / ".local" / "share" / "mise" / "bin" / "mise",
        ])
        return self._unique_paths(candidates)

    def _manager_executable(self) -> Path | None:
        return next((candidate for candidate in self._manager_candidates() if self._is_executable(candidate)), None)

    def _runtime_directories(self, adapter: RuntimeAdapter) -> list[Path]:
        home = Path.home()
        directories: list[Path] = list(self.runtime_paths)
        directories.extend(Path(value) for value in os.environ.get("PATH", "").split(os.pathsep) if value)
        directories.extend([
            Path("/opt/homebrew/bin"),
            Path("/usr/local/bin"),
            Path("/usr/local/go/bin"),
            home / ".local" / "bin",
            home / ".asdf" / "shims",
            home / ".pyenv" / "shims",
            home / ".local" / "share" / "mise" / "shims",
            home / ".local" / "share" / "mise" / "installs" / adapter.tool,
        ])
        for pattern in (
            home / ".nvm" / "versions" / "node",
            home / ".gvm" / "gos",
            home / ".local" / "share" / "mise" / "installs" / adapter.tool,
            self.root / "mise" / "installs" / adapter.tool,
        ):
            try:
                directories.extend(path / "bin" for path in pattern.glob("*") if path.is_dir())
            except OSError:
                continue
        return self._unique_paths(directories)

    def _is_mise_managed_path(self, executable: Path) -> bool:
        resolved = executable.expanduser().resolve()
        home = Path.home()
        for root in (home / ".local" / "share" / "mise", self.root / "mise"):
            root = root.resolve()
            if resolved == root or root in resolved.parents:
                return True
        manager = self._manager_executable()
        return manager is not None and resolved == manager.expanduser().resolve()

    def _is_mise_shim(self, executable: Path) -> bool:
        manager = self._manager_executable()
        return manager is not None and executable.expanduser().resolve() == manager.expanduser().resolve()

    def _runtime_candidates(self, adapter: RuntimeAdapter) -> list[Path]:
        candidates: list[Path] = []
        for directory in self._runtime_directories(adapter):
            if directory.is_file():
                if directory.name in adapter.command_names:
                    candidates.append(directory)
                continue
            candidates.extend(directory / name for name in adapter.command_names)
        for name in adapter.command_names:
            resolved = shutil.which(name)
            if resolved:
                candidates.append(Path(resolved))
        return self._unique_paths(candidates)

    def _workspace_tools(self, workspace: Mapping[str, Any], repository_id: str | None = None) -> set[str]:
        repository_ids = [repository_id] if repository_id else [
            str(item.get("id"))
            for item in workspace.get("repositories", [])
            if isinstance(item, Mapping) and item.get("id")
        ]
        tools: set[str] = set()
        for value in repository_ids:
            configured = self.requirements.get(value, {})
            if isinstance(configured, Mapping):
                tools.update(str(tool) for tool in configured)
        return tools

    def _cache_environment(self, tools: Iterable[str] = (), *, create: bool = True) -> dict[str, str]:
        if not self.cache_enabled:
            return {}
        values: dict[str, str] = {}
        paths: dict[str, Path] = {}
        if self.manager == "mise" and self.mode != "system":
            paths["MISE_CACHE_DIR"] = self.cache_root / "mise"
        for tool in set(str(value) for value in tools):
            adapter = RUNTIME_ADAPTERS.get(tool)
            if adapter:
                paths.update(adapter.cache_paths(self.cache_root))
        for name, path in paths.items():
            try:
                if create:
                    path.mkdir(parents=True, exist_ok=True, mode=0o700)
                if path.is_dir() and os.access(path, os.W_OK):
                    values[name] = str(path)
            except OSError:
                continue
        return values

    def _runtime_version(self, adapter: RuntimeAdapter, executable: Path) -> str:
        try:
            result = subprocess.run(
                [str(executable), *adapter.version_args],
                cwd=self.root,
                env={**os.environ, **self._cache_environment((adapter.tool,)), "GOTOOLCHAIN": "local"},
                capture_output=True,
                check=True,
                text=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        return adapter.parse_version(f"{result.stdout}\n{result.stderr}")

    def _find_system_runtime(self, adapter: RuntimeAdapter, requested: str) -> RuntimeResolution | None:
        for executable in self._runtime_candidates(adapter):
            if not self._is_executable(executable):
                continue
            if self._is_mise_managed_path(executable) and self.mode == "system":
                continue
            if self._is_mise_shim(executable):
                continue
            resolved = self._runtime_version(adapter, executable)
            if adapter.matches(resolved, requested):
                source = "mise" if self._is_mise_managed_path(executable) else "system"
                return RuntimeResolution(adapter.tool, requested, resolved, executable, source)
        return None

    @staticmethod
    def _entry_executable(entry: Mapping[str, Any], tool: str) -> Path:
        executable = entry.get("executables", {}).get(tool) if isinstance(entry.get("executables"), Mapping) else None
        if executable:
            return Path(str(executable)).expanduser()
        root = entry.get("paths", {}).get(tool) if isinstance(entry.get("paths"), Mapping) else None
        return Path(str(root or "")) / "bin" / tool

    def _entry_ready(self, entry: Mapping[str, Any], requested: Mapping[str, str]) -> bool:
        if entry.get("requested") != dict(requested):
            return False
        for tool in requested:
            executable = self._entry_executable(entry, tool)
            if not self._is_executable(executable) or self._is_mise_shim(executable):
                return False
        return True

    def _entry_bin_paths(self, entry: Mapping[str, Any], requested: Mapping[str, str]) -> list[str]:
        values: list[str] = []
        for tool in requested:
            executable = self._entry_executable(entry, tool)
            if self._is_executable(executable) and str(executable.parent) not in values:
                values.append(str(executable.parent))
        return values

    def _prepared_bin_paths(self, workspace: Mapping[str, Any], repository_id: str | None = None) -> list[str]:
        saved = self._load(workspace)
        selected = [repository_id] if repository_id else [str(item.get("id")) for item in workspace.get("repositories", []) if isinstance(item, Mapping)]
        bins: list[str] = []
        for value in selected:
            requested = self.requirements.get(value, {})
            entry = saved.get(value, {})
            if not isinstance(requested, Mapping) or not self._entry_ready(entry, requested):
                continue
            for path in self._entry_bin_paths(entry, requested):
                if path not in bins:
                    bins.append(path)
        return bins

    def environment(self, workspace: Mapping[str, Any], repository_id: str | None = None) -> dict[str, str]:
        values = self._cache_environment(self._workspace_tools(workspace, repository_id))
        values["GOTOOLCHAIN"] = "local"
        bins = self._prepared_bin_paths(workspace, repository_id)
        if bins:
            values["PATH"] = os.pathsep.join([*bins, os.environ.get("PATH", "")])
        return values

    def environment_summary(self, workspace: Mapping[str, Any]) -> dict[str, Any]:
        variables = self._cache_environment(self._workspace_tools(workspace), create=False)
        variables["GOTOOLCHAIN"] = "local"
        return {"pathEntries": self._prepared_bin_paths(workspace), "variables": variables}

    def summary(self, workspace: Mapping[str, Any]) -> dict[str, Any]:
        if not workspace.get("managed"):
            return {"manager": self.manager, "mode": self.mode, "status": "not_applicable", "requirements": {}, "preparedRepositories": {}, "issues": []}
        saved = self._load(workspace)
        repositories: dict[str, dict[str, Any]] = {}
        requirements: dict[str, dict[str, list[str]]] = {}
        for repository in workspace.get("repositories", []):
            repo_id = str(repository["id"])
            requested = self.requirements.get(repo_id, {})
            previous = saved.get(repo_id, {}) if isinstance(saved.get(repo_id, {}), Mapping) else {}
            matches = previous.get("requested") == requested
            ready_paths = self._entry_ready(previous, requested)
            status = str(previous.get("status") or "needs_prepare") if matches else "needs_prepare"
            if status == "ready" and not ready_paths:
                status = "needs_prepare"
            if not requested:
                status = "not_applicable"
            repositories[repo_id] = {
                "status": status,
                "tools": list(requested),
                "issues": list(previous.get("issues", [])) if matches and isinstance(previous.get("issues", []), list) else [],
                "sources": dict(previous.get("sources", {})) if matches and isinstance(previous.get("sources", {}), Mapping) else {},
                "binPaths": self._entry_bin_paths(previous, requested) if status == "ready" and ready_paths else [],
            }
            for tool, version in requested.items():
                item = requirements.setdefault(tool, {"requested": [], "resolved": []})
                item["requested"].append(version)
                if matches and isinstance(previous.get("resolved"), Mapping) and previous["resolved"].get(tool):
                    item["resolved"].append(previous["resolved"][tool])
        states = [item["status"] for item in repositories.values()]
        status = "ready" if all(item in {"ready", "not_applicable"} for item in states) else "partial" if "ready" in states else "prepare_failed" if "prepare_failed" in states else "needs_prepare"
        manager = self._manager_executable() if self.mode != "system" and self.manager == "mise" else None
        return {
            "manager": self.manager,
            "mode": self.mode,
            "managerAvailable": manager is not None,
            "managerPath": str(manager) if manager else None,
            "cache": {"scope": "project", "root": str(self.cache_root), "enabled": self.cache_enabled},
            "requirements": requirements,
            "preparedRepositories": repositories,
            "issues": [issue for item in repositories.values() for issue in item["issues"]],
            "status": status,
            "environment": self.environment_summary(workspace) if status == "ready" else {"pathEntries": [], "variables": self._cache_environment(self._workspace_tools(workspace), create=False)},
        }

    def _save(self, workspace: Mapping[str, Any], entry: Mapping[str, Any], repository_id: str) -> None:
        saved = self._load(workspace)
        saved[repository_id] = dict(entry)
        path = self._path(workspace)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(saved), encoding="utf-8")
        temporary.chmod(0o600)
        os.replace(temporary, path)

    def _manager_missing_error(self, missing: list[tuple[str, str]]) -> WorkbenchError:
        requested = ", ".join(f"{tool}@{version}" for tool, version in missing)
        return WorkbenchError(
            f"No compatible system runtime was found for {requested}, and mise is unavailable. Install mise, configure toolchain.managerPath, or provide matching system runtimes.",
            code="missing_manager",
            details={"missingRuntimes": [{"tool": tool, "version": version} for tool, version in missing], "manager": "mise"},
        )

    def prepare(self, workspace: Mapping[str, Any], repository_id: str, *, verify_only: bool = False) -> dict[str, Any]:
        if not workspace.get("managed"):
            raise WorkbenchError("live workspace is read only", code="workspace_not_managed")
        repository = next((item for item in workspace.get("repositories", []) if repository_id in {item["id"], item["repoPath"]}), None)
        if repository is None:
            raise WorkbenchError("repository is unavailable", code="repository_missing")
        requested = dict(self.requirements.get(repository["id"], {}))
        with self.lock:
            previous = self.prepared_repository(workspace, str(repository["id"]))
            if previous.get("status") == "ready" and self._entry_ready(previous, requested):
                return {"workspaceId": workspace["id"], "repositoryId": repository["id"], **previous}
            entry: dict[str, Any] = {"requested": requested, "resolved": {}, "paths": {}, "executables": {}, "sources": {}, "status": "ready", "issues": []}
            try:
                missing: list[tuple[str, str]] = []
                if self.mode != "mise":
                    for tool, version in requested.items():
                        resolution = self._find_system_runtime(RUNTIME_ADAPTERS[tool], version)
                        if resolution is None:
                            missing.append((tool, version))
                        else:
                            entry["resolved"][tool] = resolution.resolved
                            entry["paths"][tool] = str(resolution.executable.parent)
                            entry["executables"][tool] = str(resolution.executable)
                            entry["sources"][tool] = resolution.source
                else:
                    missing = list(requested.items())
                if missing:
                    if self.mode == "system":
                        tool, version = missing[0]
                        raise WorkbenchError(f"system runtime is unavailable: {tool}@{version}", code="runtime_missing")
                    manager = self._manager_executable() if self.manager == "mise" else None
                    if manager is None:
                        raise self._manager_missing_error(missing)
                    for tool, version in missing:
                        adapter = RUNTIME_ADAPTERS[tool]
                        spec = f"{tool}@{version}"
                        if not verify_only:
                            subprocess.run(
                                [str(manager), "install", spec, "--yes"],
                                cwd=self.root,
                                env={**os.environ, **self._cache_environment((tool,))},
                                capture_output=True,
                                check=True,
                                timeout=300,
                            )
                        install_path = subprocess.run(
                            [str(manager), "where", spec],
                            cwd=self.root,
                            env={**os.environ, **self._cache_environment((tool,))},
                            capture_output=True,
                            check=True,
                            text=True,
                            timeout=10,
                        ).stdout.strip()
                        root = Path(install_path).expanduser()
                        executable = root / "bin" / tool
                        if not root.is_dir():
                            raise WorkbenchError("runtime install missing", code="toolchain_not_ready")
                        if not self._is_executable(executable):
                            raise WorkbenchError("runtime executable missing", code="toolchain_not_ready")
                        resolved = self._runtime_version(adapter, executable)
                        if not adapter.matches(resolved, version):
                            raise WorkbenchError("runtime version mismatch", code="toolchain_not_ready")
                        entry["paths"][tool] = str(root)
                        entry["executables"][tool] = str(executable)
                        entry["resolved"][tool] = resolved
                        entry["sources"][tool] = "mise"
            except (OSError, subprocess.SubprocessError, WorkbenchError) as error:
                issue: dict[str, Any] = {"code": getattr(error, "code", "prepare_failed"), "message": str(error)}
                details = getattr(error, "details", None)
                if details is not None:
                    issue["details"] = details
                entry.update(status="prepare_failed", issues=[issue])
            self._save(workspace, entry, str(repository["id"]))
            return {"workspaceId": workspace["id"], "repositoryId": repository["id"], **entry}


# Keep the old provider name as the public integration point while the
# implementation now owns both system and mise-backed runtime strategies.
MiseToolchainProvider = ProjectRuntimeManager
