from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import subprocess
from typing import Iterable, Sequence

from .errors import GitCommandError, WorkbenchError


@dataclass(frozen=True)
class GitResult:
    args: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str


@dataclass(frozen=True)
class GitFile:
    path: str
    status: str
    old_path: str | None = None
    additions: int | None = None
    deletions: int | None = None
    binary: bool = False


def _decode(value: bytes) -> str:
    return value.decode("utf-8", errors="replace")


class GitClient:
    """Small, bounded, read-mostly wrapper around the Git CLI.

    No method accepts a shell string. Arguments are passed directly to Git so
    a project config or UI cannot turn an observation into arbitrary command
    execution.
    """

    def __init__(self, repository: str | Path, *, timeout: float = 3.0) -> None:
        self.repository = Path(repository).expanduser().resolve()
        self.timeout = max(0.5, float(timeout))

    def run(
        self,
        args: Sequence[str],
        *,
        timeout: float | None = None,
        check: bool = True,
    ) -> GitResult:
        normalized = tuple(str(value) for value in args)
        try:
            completed = subprocess.run(
                ["git", "-c", "core.fsmonitor=false", "-C", str(self.repository), *normalized],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=timeout if timeout is not None else self.timeout,
                env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"},
            )
        except subprocess.TimeoutExpired as exc:
            raise GitCommandError(
                f"git command timed out after {timeout if timeout is not None else self.timeout:g}s",
                code="git_timeout",
                details={"repository": str(self.repository), "args": list(normalized)},
            ) from exc
        except OSError as exc:
            raise GitCommandError(
                f"git command could not start: {exc}",
                code="git_unavailable",
                details={"repository": str(self.repository)},
            ) from exc
        result = GitResult(normalized, completed.returncode, _decode(completed.stdout), _decode(completed.stderr))
        if check and result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "git command failed"
            raise GitCommandError(
                detail,
                code="git_command_failed",
                details={"repository": str(self.repository), "args": list(normalized), "returncode": result.returncode},
            )
        return result

    def is_repository(self) -> bool:
        if not self.repository.is_dir():
            return False
        result = self.run(["rev-parse", "--is-inside-work-tree"], check=False)
        return result.returncode == 0 and result.stdout.strip() == "true"

    def root(self) -> Path:
        value = self.run(["rev-parse", "--show-toplevel"]).stdout.strip()
        return Path(value).resolve()

    def head(self) -> str | None:
        result = self.run(["rev-parse", "--verify", "HEAD"], check=False)
        return result.stdout.strip() if result.returncode == 0 else None

    def branch(self) -> str | None:
        result = self.run(["symbolic-ref", "--quiet", "--short", "HEAD"], check=False)
        value = result.stdout.strip()
        return value or None

    def upstream(self) -> tuple[str | None, str | None]:
        name = self.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], check=False).stdout.strip()
        sha = self.run(["rev-parse", "--verify", "@{upstream}"], check=False).stdout.strip()
        return name or None, sha or None

    def refs(self, *, head: str | None = None) -> list[dict[str, str | bool]]:
        args = ["for-each-ref"]
        if head:
            args.append(f"--merged={head}")
        args.extend(["--format=%(objectname)\t%(refname)\t%(symref)\t%(*objectname)", "refs/heads", "refs/remotes", "refs/tags"])
        output = self.run(args).stdout
        result: list[dict[str, str | bool]] = []
        for line in output.splitlines():
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            sha, name = parts[0].strip(), parts[1].strip()
            if not sha or not name:
                continue
            short_name = name.removeprefix("refs/heads/").removeprefix("refs/remotes/").removeprefix("refs/tags/")
            kind = "tag" if name.startswith("refs/tags/") else "remote" if name.startswith("refs/remotes/") else "local"
            if kind == "tag" and len(parts) > 3 and parts[3].strip():
                sha = parts[3].strip()
            result.append({"name": name, "shortName": short_name, "sha": sha, "kind": kind})
        result.sort(key=lambda item: (str(item["kind"]), str(item["shortName"])))
        return result

    def status_porcelain(self) -> list[tuple[str, str]]:
        output = self.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout
        values = output.split("\x00")
        result: list[tuple[str, str]] = []
        index = 0
        while index < len(values):
            value = values[index]
            index += 1
            if not value:
                continue
            status = value[:2]
            path = value[3:] if len(value) > 3 else ""
            if status and status[0] in {"R", "C"} and index < len(values) and values[index]:
                old_path = path
                path = values[index]
                index += 1
                result.append((status, f"{old_path}\x00{path}"))
            elif path:
                result.append((status, path))
        return result

    def _numstat(self, args: Sequence[str]) -> dict[str, tuple[int | None, int | None, bool]]:
        output = self.run([*args, "--numstat", "-z"]).stdout
        result: dict[str, tuple[int | None, int | None, bool]] = {}
        values = output.split("\x00")
        index = 0
        while index < len(values):
            value = values[index]
            index += 1
            if not value:
                continue
            parts = value.split("\t", 2)
            if len(parts) != 3:
                continue
            additions_raw, deletions_raw, path = parts
            if not path and index + 1 < len(values):
                path = values[index + 1]
                index += 2
            try:
                additions = int(additions_raw)
                deletions = int(deletions_raw)
                binary = False
            except ValueError:
                additions = deletions = None
                binary = True
            result[path] = (additions, deletions, binary)
        return result

    def changed_files(self, scope: str, *, base: str | None = None, commit: str | None = None) -> list[GitFile]:
        if scope == "working":
            head = self.head()
            names = self.run(["diff", "--name-status", "-z", "--find-renames", "HEAD"], check=False) if head else GitResult((), 0, "", "")
            stats = self._numstat(["diff", "HEAD"]) if head else {}
            entries = self._parse_name_status(names.stdout)
            known = {entry.path for entry in entries}
            for status, path in self.status_porcelain():
                if status == "??" and path not in known:
                    entries.append(GitFile(path=path, status="A"))
                    known.add(path)
            for entry in entries:
                values = stats.get(entry.path)
                if values:
                    entry_index = entries.index(entry)
                    entries[entry_index] = GitFile(
                        path=entry.path,
                        status=entry.status,
                        old_path=entry.old_path,
                        additions=values[0],
                        deletions=values[1],
                        binary=values[2],
                    )
            return self._with_untracked_stats(entries)
        if scope == "commit":
            if not commit:
                raise WorkbenchError("commit is required", code="commit_required")
            commit = self.resolve_commit(commit)
            parents = self.run(["rev-list", "--parents", "-n", "1", commit]).stdout.split()[1:]
            args = ["diff", parents[0], commit] if parents else ["diff-tree", "--root", "--no-commit-id", "-r", commit]
            names = self.run([*args, "--name-status", "-z", "--find-renames"])
            stats = self._numstat(args)
        elif scope == "branch":
            if not base:
                raise WorkbenchError("base is required for branch changes", code="base_missing")
            head = self.head()
            if not head:
                return []
            names = self.run(["diff", "--name-status", "-z", "--find-renames", base, head])
            stats = self._numstat(["diff", base, head])
        else:
            raise WorkbenchError(f"unsupported change scope: {scope}", code="scope_invalid")
        entries = self._parse_name_status(names.stdout)
        return [
            GitFile(
                path=entry.path,
                status=entry.status,
                old_path=entry.old_path,
                additions=stats.get(entry.path, (None, None, False))[0],
                deletions=stats.get(entry.path, (None, None, False))[1],
                binary=stats.get(entry.path, (None, None, False))[2],
            )
            for entry in entries
        ]

    @staticmethod
    def _parse_name_status(output: str) -> list[GitFile]:
        values = output.split("\x00")
        result: list[GitFile] = []
        index = 0
        while index < len(values):
            value = values[index]
            index += 1
            if not value:
                continue
            if "\t" in value:
                raw_status, path = value.split("\t", 1)
            elif index < len(values):
                # `--name-status -z` uses NUL between the status and path,
                # unlike its line-oriented form which uses a tab.
                raw_status, path = value, values[index]
                index += 1
            else:
                continue
            status = raw_status[:1]
            old_path: str | None = None
            if status in {"R", "C"} and index < len(values):
                old_path, path = path, values[index]
                index += 1
            result.append(GitFile(path=path, status=status, old_path=old_path))
        return result

    def _with_untracked_stats(self, entries: list[GitFile]) -> list[GitFile]:
        result: list[GitFile] = []
        for entry in entries:
            if entry.status != "A" or entry.additions is not None or not (self.repository / entry.path).is_file():
                result.append(entry)
                continue
            try:
                candidate = self.repository / entry.path
                if candidate.is_symlink():
                    additions = 1
                else:
                    with candidate.open("r", encoding="utf-8") as stream:
                        additions = sum(1 for _ in stream)
            except (OSError, UnicodeDecodeError):
                additions = None
            result.append(GitFile(path=entry.path, status=entry.status, additions=additions, deletions=0, binary=additions is None))
        return result

    def diff(self, scope: str, path: str, *, base: str | None = None, commit: str | None = None, old_path: str | None = None) -> tuple[str, str | None, str | None]:
        relative = Path(path)
        if relative.is_absolute() or ".." in relative.parts:
            raise WorkbenchError("file path must stay inside the repository", code="path_invalid")
        files = self.changed_files(scope, base=base, commit=commit)
        selected = next((item for item in files if item.path == path), None)
        if selected is None:
            raise WorkbenchError("file is not in the selected changes", code="file_not_changed")
        paths = [selected.old_path, path] if selected.old_path else [path]
        if scope == "working":
            left, right = "HEAD", None
            if not self.head() or any(status == "??" and item == path for status, item in self.status_porcelain()):
                command = ["diff", "--no-ext-diff", "--no-index", "--unified=80", "/dev/null", path]
                left = None
            else:
                command = ["diff", "--no-ext-diff", "--unified=80", "HEAD", "--", *paths]
        elif scope == "branch":
            if not base:
                raise WorkbenchError("base is required for branch diff", code="base_missing")
            left, right = base, self.head()
            command = ["diff", "--no-ext-diff", "--unified=80", base, right or "HEAD", "--", *paths]
        elif scope == "commit":
            if not commit:
                raise WorkbenchError("commit is required", code="commit_required")
            commit = self.resolve_commit(commit)
            parent = self.run(["rev-list", "--parents", "-n", "1", commit]).stdout.strip().split()[1:2]
            left, right = (parent[0] if parent else None), commit
            command = (["diff", left, commit] if left else ["diff-tree", "--root", "--no-commit-id", "-r", commit]) + ["--no-ext-diff", "--unified=80", "--", *paths]
        else:
            raise WorkbenchError(f"unsupported diff scope: {scope}", code="scope_invalid")
        result = self.run(command, check=False)
        if result.returncode not in {0, 1}:
            detail = result.stderr.strip() or result.stdout.strip() or "git diff failed"
            raise GitCommandError(detail, code="git_diff_failed", details={"repository": str(self.repository), "path": path})
        return result.stdout, left, right

    def resolve_commit(self, value: str) -> str:
        result = self.run(["rev-parse", "--verify", "--end-of-options", f"{value}^{{commit}}"], check=False)
        if result.returncode:
            raise WorkbenchError("commit is unavailable", code="commit_missing")
        return result.stdout.strip()

    def graph(self, *, mode: str = "branch", base: str | None = None, max_commits: int = 50) -> dict[str, object]:
        head = self.head()
        if not head:
            return {"historyMode": mode, "nodes": [], "refs": [], "hasOlder": False, "loadedCount": 0, "baseLoaded": False}
        limit = max(1, min(int(max_commits), 200))
        args = ["log", "--topo-order", "--date-order", f"--max-count={limit + 1}", "--pretty=format:%H%x00%P%x00%h%x00%s%x00%an%x00%aI"]
        if mode == "branch":
            if not base:
                raise WorkbenchError("base is required for branch graph", code="base_missing")
            args.append(f"{base}..{head}")
        elif mode != "full":
            raise WorkbenchError(f"unsupported graph history mode: {mode}", code="history_mode_invalid")
        output = self.run(args).stdout
        raw_nodes = [line for line in output.splitlines() if line.strip()]
        has_older = len(raw_nodes) > limit
        raw_nodes = raw_nodes[:limit]
        nodes: list[dict[str, object]] = []
        seen: set[str] = set()
        for line in raw_nodes:
            fields = line.split("\x00")
            if len(fields) < 6:
                continue
            sha, parents, short_sha, subject, author, authored_at = fields[:6]
            if not sha or sha in seen:
                continue
            seen.add(sha)
            nodes.append({
                "sha": sha,
                "shortSha": short_sha,
                "parents": [value for value in parents.split() if value],
                "subject": subject,
                "author": author,
                "authoredAt": authored_at,
                "isBase": bool(base and sha == base),
            })
        if mode == "branch" and base and base not in seen:
            base_subject = self.run(["show", "-s", "--format=%s", base], check=False).stdout.strip() or "base"
            nodes.append({"sha": base, "shortSha": base[:8], "parents": [], "subject": base_subject, "author": "", "authoredAt": "", "isBase": True})
            seen.add(base)
        refs = [ref for ref in self.refs(head=head) if str(ref.get("sha")) in seen]
        decorations: dict[str, list[dict[str, object]]] = {}
        for ref in refs:
            decorations.setdefault(str(ref["sha"]), []).append(ref)
        for node in nodes:
            node_refs = decorations.get(str(node["sha"]), [])
            node["refs"] = node_refs
            node["decorations"] = [str(ref.get("shortName") or ref.get("name") or "") for ref in node_refs]
            if node["sha"] == head:
                node["decorations"] = ["HEAD", *[value for value in node["decorations"] if value != "HEAD"]]
            if len(node.get("parents", [])) > 1:
                node["mergeSources"] = [
                    {"parentSha": parent, "refs": decorations.get(str(parent), [])}
                    for parent in node["parents"][1:]
                ]
        return {
            "historyMode": mode,
            "nodes": nodes,
            "refs": refs,
            "hasOlder": has_older,
            "loadedCount": len(nodes) if mode == "full" else len([node for node in nodes if not node.get("isBase")]),
            "baseLoaded": any(bool(node.get("isBase")) for node in nodes),
        }

    def fingerprint(self) -> str:
        if not self.is_repository():
            return "missing"
        head = self.head() or ""
        branch = self.branch() or ""
        upstream, upstream_sha = self.upstream()
        status = "\x00".join(f"{code}:{path}" for code, path in self.status_porcelain())
        refs = "\x00".join(f"{item['name']}:{item['sha']}" for item in self.refs(head=head))
        return hashlib.sha256("\x00".join([head, branch, upstream or "", upstream_sha or "", status, refs]).encode()).hexdigest()
