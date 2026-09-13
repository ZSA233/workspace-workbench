"""Local, explicitly invoked execution. Never exposed as an arbitrary-shell RPC."""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
from typing import TYPE_CHECKING

from ..core.errors import WorkbenchError
from ..core.git import GitClient

if TYPE_CHECKING:
    from ..core.service import ObserverService


def execute(service: ObserverService, workspace_id: str, repository_id: str, command: list[str]) -> int:
    if not command:
        raise WorkbenchError("an explicit command is required", code="argument_invalid")
    workspace = service.provider.get(workspace_id)
    if not workspace.get("managed"):
        raise WorkbenchError("live workspace is not managed", code="workspace_not_managed")
    repository = service.provider.repository(workspace_id, repository_id)
    cwd = Path(repository["worktreePath"]).resolve()
    if not cwd.is_dir() or not cwd.is_relative_to(Path(workspace["treePath"]).resolve()):
        raise WorkbenchError("worktree is unavailable", code="worktree_missing")
    if GitClient(cwd).root() != cwd:
        raise WorkbenchError("worktree identity changed", code="worktree_identity_changed")
    environment = {**os.environ, "GOTOOLCHAIN": "local"}
    bins = []
    if service.toolchain:
        tools = service.toolchain.requirements.get(repository["id"], {})
        saved = service.toolchain.prepared_repository(workspace, repository["id"])
        if tools and (saved.get("status") != "ready" or saved.get("requested") != tools):
            raise WorkbenchError("prepare this repository's runtimes first", code="toolchain_not_ready")
        for tool, version in tools.items():
            directory = Path(saved.get("paths", {}).get(tool, "")) / "bin"
            executable = directory / tool
            if not executable.is_file():
                raise WorkbenchError("runtime executable missing", code="toolchain_not_ready")
            try:
                result = subprocess.run([str(executable), "version" if tool == "go" else "--version"], cwd=cwd, env=environment, capture_output=True, text=True, timeout=10, check=True)
            except (OSError, subprocess.SubprocessError) as exc:
                raise WorkbenchError("runtime verification failed", code="toolchain_not_ready") from exc
            match = re.search(r"\b(?:go|v)?(\d+\.\d+(?:\.\d+)?)", result.stdout)
            resolved = match.group(1) if match else ""
            if resolved != saved.get("resolved", {}).get(tool) or not (resolved == version or resolved.startswith(version + ".")):
                raise WorkbenchError("runtime version changed", code="toolchain_not_ready")
            bins.append(str(directory))
    environment["PATH"] = os.pathsep.join([*bins, environment.get("PATH", "")])
    try:
        return subprocess.run(command, cwd=cwd, env=environment, check=False).returncode
    except OSError as exc:
        raise WorkbenchError("command could not be executed", code="command_failed") from exc
