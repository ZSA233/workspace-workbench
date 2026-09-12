from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping


@dataclass(frozen=True)
class RepositoryConfig:
    id: str
    path: str
    display_name: str | None = None
    enabled: bool = True
    role: str | None = None
    default_base: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @property
    def name(self) -> str:
        return self.display_name or self.id


@dataclass(frozen=True)
class WorkspaceTarget:
    id: str
    display_name: str
    kind: str
    managed: bool
    description: str = ""
    source_root: Path | None = None
    tree_path: Path | None = None
    repositories: tuple[dict[str, Any], ...] = ()
    created_at: str | None = None
    updated_at: str | None = None


@dataclass(frozen=True)
class RepositoryTarget:
    workspace_id: str
    repository: RepositoryConfig
    path: Path
    base_ref: str | None = None
    base_sha: str | None = None
    branch: str | None = None
    source_path: Path | None = None
