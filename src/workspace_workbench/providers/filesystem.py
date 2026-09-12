from __future__ import annotations

from .git_worktree import GitWorktreeProvider


class FilesystemProvider(GitWorktreeProvider):
    """Explicit-directory provider alias for configuration-driven projects.

    It deliberately shares the safe Git worktree implementation. A project
    with a different manifest or remote workspace layout can implement the
    same provider surface without changing the observation core.
    """
