from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
from typing import Any, Mapping, Protocol

from ..core.errors import WorkbenchError


class ToolchainProvider(Protocol):
    def summary(self, workspace: Mapping[str, Any]) -> dict[str, Any]: ...
    def prepare(self, workspace: Mapping[str, Any], repository_id: str) -> dict[str, Any]: ...


class MiseToolchainProvider:
    def prepared_repository(self, workspace: Mapping[str, Any], repository_id: str) -> dict[str, Any]:
        return dict(self._load(workspace).get(repository_id, {}))

    def __init__(self, config: Mapping[str, Any], state_root: Path) -> None:
        self.requirements = dict(config.get("repositories") or {})
        self.root = state_root / "toolchains"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        for tools in self.requirements.values():
            if not isinstance(tools, dict):
                raise WorkbenchError("runtime requirements must be objects", code="config_invalid")
            for tool, version in tools.items():
                if tool not in {"go", "python", "node"} or not isinstance(version, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,2}", version):
                    raise WorkbenchError("unsupported runtime requirement", code="config_invalid")

    def _path(self, workspace: Mapping[str, Any]) -> Path:
        import hashlib
        return self.root / (hashlib.sha256(str(workspace["id"]).encode()).hexdigest() + ".json")

    def _load(self, workspace: Mapping[str, Any]) -> dict[str, Any]:
        try:
            return json.loads(self._path(workspace).read_text())
        except (OSError, ValueError):
            return {}

    def summary(self, workspace: Mapping[str, Any]) -> dict[str, Any]:
        if not workspace.get("managed"):
            return {"manager": "mise", "status": "not_applicable", "requirements": {}, "preparedRepositories": {}, "issues": []}
        saved = self._load(workspace)
        repositories = {}
        requirements = {}
        for repository in workspace.get("repositories", []):
            repo_id = repository["id"]
            requested = self.requirements.get(repo_id, {})
            previous = saved.get(repo_id, {})
            valid = previous.get("requested") == requested and all(Path(path).is_dir() for path in previous.get("paths", {}).values())
            status = previous.get("status", "needs_prepare") if valid else "needs_prepare"
            if not requested:
                status = "not_applicable"
            repositories[repo_id] = {"status": status, "tools": list(requested), "issues": previous.get("issues", []) if valid else []}
            for tool, version in requested.items():
                item = requirements.setdefault(tool, {"requested": [], "resolved": []})
                item["requested"].append(version)
                if valid and previous.get("resolved", {}).get(tool):
                    item["resolved"].append(previous["resolved"][tool])
        states = [item["status"] for item in repositories.values()]
        status = "ready" if all(item in {"ready", "not_applicable"} for item in states) else "partial" if "ready" in states else "prepare_failed" if "prepare_failed" in states else "needs_prepare"
        return {"manager": "mise", "status": status, "requirements": requirements, "preparedRepositories": repositories, "issues": [issue for item in repositories.values() for issue in item["issues"]]}

    def prepare(self, workspace: Mapping[str, Any], repository_id: str, *, verify_only: bool = False) -> dict[str, Any]:
        if not workspace.get("managed"):
            raise WorkbenchError("live workspace is read only", code="workspace_not_managed")
        repository = next((item for item in workspace.get("repositories", []) if repository_id in {item["id"], item["repoPath"]}), None)
        if repository is None:
            raise WorkbenchError("repository is unavailable", code="repository_missing")
        requested = self.requirements.get(repository["id"], {})
        executable = shutil.which("mise")
        if requested and not executable:
            raise WorkbenchError("mise is unavailable", code="missing_manager")
        with self.lock:
            entry: dict[str, Any] = {"requested": requested, "resolved": {}, "paths": {}, "status": "ready", "issues": []}
            try:
                for tool, version in requested.items():
                    spec = f"{tool}@{version}"
                    if not verify_only:
                        subprocess.run([executable, "install", spec, "--yes"], cwd=self.root, capture_output=True, check=True, timeout=300)
                    path = subprocess.run([executable, "where", spec], cwd=self.root, capture_output=True, check=True, text=True, timeout=10).stdout.strip()
                    if not Path(path).is_dir():
                        raise WorkbenchError("runtime install missing", code="toolchain_not_ready")
                    executable_path = Path(path) / "bin" / tool
                    if not executable_path.is_file():
                        raise WorkbenchError("runtime executable missing", code="toolchain_not_ready")
                    version_output = subprocess.run([str(executable_path), "version" if tool == "go" else "--version"], cwd=self.root, env={**os.environ, "GOTOOLCHAIN": "local"}, capture_output=True, check=True, text=True, timeout=10).stdout
                    match = re.search(r"\b(?:go|v)?(\d+\.\d+(?:\.\d+)?)", version_output)
                    resolved = match.group(1) if match else ""
                    if not (resolved == version or resolved.startswith(version + ".")):
                        raise WorkbenchError("runtime version mismatch", code="toolchain_not_ready")
                    entry["paths"][tool] = path
                    entry["resolved"][tool] = resolved
            except (OSError, subprocess.SubprocessError, WorkbenchError):
                entry.update(status="prepare_failed", issues=[{"code": "prepare_failed", "message": "runtime preparation failed"}])
            saved = self._load(workspace)
            saved[repository["id"]] = entry
            path = self._path(workspace)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(saved), encoding="utf-8")
            temporary.chmod(0o600)
            os.replace(temporary, path)
            return {"workspaceId": workspace["id"], "repositoryId": repository["id"], **entry}
