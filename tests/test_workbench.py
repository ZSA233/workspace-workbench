from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import unittest

from workspace_workbench.core.cache import BoundedMemoryCache, SQLiteCache
from workspace_workbench.core.config import discover_git_repositories, load_config
from workspace_workbench.core.diff import changed_line_ranges, parse_patch
from workspace_workbench.core.errors import WorkbenchError
from workspace_workbench.core.graph import lane_layout
from workspace_workbench.core.git import GitClient
from workspace_workbench.core.service import ObserverService, ThreadingUnixServer


def run_git(path: Path, *args: str) -> str:
    value = subprocess.run(["git", "-C", str(path), *args], check=True, capture_output=True, text=True)
    return value.stdout.strip()


def make_repository(root: Path, name: str) -> Path:
    path = root / name
    path.mkdir(parents=True)
    run_git(path, "init", "-q")
    run_git(path, "config", "user.email", "test@example.invalid")
    run_git(path, "config", "user.name", "Test User")
    (path / "README.md").write_text("initial\n", encoding="utf-8")
    run_git(path, "add", "README.md")
    run_git(path, "commit", "-qm", "initial")
    return path


def write_config(path: Path, root: Path, repositories: list[dict[str, object]]) -> None:
    path.write_text(json.dumps({
        "schemaVersion": 1,
        "project": {"id": "fixture", "displayName": "Fixture"},
        "sourceRoot": str(root),
        "workspaceRoot": str(root / ".state" / "workspaces"),
        "stateRoot": str(root / ".state"),
        "socketPath": str(root / ".state" / "observer.sock"),
        "discovery": {"mode": "hybrid", "roots": [str(root)], "maxDepth": 2},
        "repositories": repositories,
        "mainWorkspace": {"displayName": "Main"},
    }, indent=2), encoding="utf-8")


class WorkbenchTests(unittest.TestCase):
    def test_discovery_returns_candidates_without_mutating_config(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_repository(root, "api")
            config_path = root / "observer.json"
            write_config(config_path, root, [])
            config = load_config(config_path)
            candidates = discover_git_repositories(config)
            self.assertEqual([candidate.display_name for candidate in candidates], ["api"])
            self.assertEqual(json.loads(config_path.read_text(encoding="utf-8"))["repositories"], [])

    def test_root_git_checkout_can_be_discovered_and_observed_as_dot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_git(root, "init", "-q")
            run_git(root, "config", "user.email", "test@example.invalid")
            run_git(root, "config", "user.name", "Test User")
            (root / "README.md").write_text("root\n", encoding="utf-8")
            run_git(root, "add", "README.md")
            run_git(root, "commit", "-qm", "initial")
            config_path = root / "observer.json"
            write_config(config_path, root, [])
            config = load_config(config_path)
            candidates = discover_git_repositories(config)
            self.assertEqual(len(candidates), 1)
            self.assertEqual(Path(candidates[0].path).resolve(), root.resolve())
            value = json.loads(config_path.read_text(encoding="utf-8"))
            value["repositories"] = [{"id": "root", "path": ".", "enabled": True}]
            config_path.write_text(json.dumps(value), encoding="utf-8")
            service = ObserverService(load_config(config_path))
            try:
                detail = service.handle("workspace.detail", {"workspaceId": "main"})
                self.assertEqual([repository["repoPath"] for repository in detail["repositories"]], ["."])
                self.assertEqual(detail["repositories"][0]["status"], "dirty")
            finally:
                service.close()

    def test_accept_explicitly_promotes_a_discovered_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_repository(root, "api")
            config_path = root / "observer.json"
            write_config(config_path, root, [])
            result = subprocess.run(
                ["python", "-m", "workspace_workbench.cli", "accept", "--config", str(config_path), "--repository", "api"],
                check=True,
                capture_output=True,
                text=True,
                env={**os.environ, "PYTHONPATH": "src"},
            )
            self.assertIn('"accepted"', result.stdout)
            value = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(value["repositories"][0]["path"], "api")

    def test_git_observes_working_tree_and_graph(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repository = make_repository(Path(temporary), "api")
            (repository / "README.md").write_text("initial\nchanged\n", encoding="utf-8")
            (repository / "new.txt").write_text("new\n", encoding="utf-8")
            client = GitClient(repository)
            self.assertTrue(client.is_repository())
            self.assertTrue(client.branch())
            files = client.changed_files("working")
            self.assertEqual({file.path for file in files}, {"README.md", "new.txt"})
            self.assertEqual(client.graph(mode="full", max_commits=10)["loadedCount"], 1)

    def test_git_graph_keeps_merge_parents_and_visible_refs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repository = make_repository(Path(temporary), "api")
            base_branch = run_git(repository, "branch", "--show-current")
            run_git(repository, "checkout", "-qb", "feature")
            (repository / "feature.txt").write_text("feature\n", encoding="utf-8")
            run_git(repository, "add", "feature.txt")
            run_git(repository, "commit", "-qm", "feature commit")
            run_git(repository, "checkout", "-q", base_branch)
            run_git(repository, "merge", "--no-ff", "-qm", "merge feature", "feature")
            graph = GitClient(repository).graph(mode="full", max_commits=20)
            self.assertTrue(any(len(node["parents"]) > 1 for node in graph["nodes"]))
            self.assertIn("feature", {ref["shortName"] for ref in graph["refs"]})

    def test_cache_is_bounded_and_sqlite_survives_reopen(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "cache.sqlite3"
            memory = BoundedMemoryCache(max_entries=2, max_bytes=1024)
            memory.put("a", {"value": "a"}, fingerprint="a")
            memory.put("b", {"value": "b"}, fingerprint="b")
            memory.put("c", {"value": "c"}, fingerprint="c")
            self.assertIsNone(memory.get("a"))
            self.assertEqual(memory.status()["entries"], 2)
            sqlite = SQLiteCache(path, max_entries=2)
            sqlite.put("key", {"value": "persisted"}, fingerprint="fingerprint")
            reopened = SQLiteCache(path, max_entries=2)
            self.assertEqual(reopened.get("key", fingerprint="fingerprint").payload["value"], "persisted")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_service_lists_main_and_creates_managed_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_repository(root, "api")
            make_repository(root, "web")
            config_path = root / "observer.json"
            write_config(config_path, root, [
                {"id": "api", "path": "api", "enabled": True},
                {"id": "web", "path": "web", "enabled": True},
            ])
            service = ObserverService(load_config(config_path))
            try:
                listed = service.handle("workspace.list")
                self.assertEqual([item["id"] for item in listed["workspaces"]], ["main"])
                working = service.handle("repository.changes", {"workspaceId": "main", "repoPath": "api", "scope": "working"})
                self.assertEqual(working["summary"]["files"], 0)
                graph = service.handle("repository.graph", {"workspaceId": "main", "repoPath": "api", "historyMode": "full", "maxCommits": 10})
                self.assertIn("branch", graph)
                self.assertIn("head", graph)
                self.assertIn("truncated", graph)
                created = service.handle("workspace.create", {"name": "Review one", "repositories": ["api", "web"]})
                self.assertEqual(created["kind"], "managed")
                self.assertEqual(len(created["repositories"]), 2)
                self.assertTrue(Path(created["repositories"][0]["worktreePath"]).is_dir())
                detail = service.handle("workspace.detail", {"workspaceId": created["id"]})
                self.assertEqual(detail["workspace"]["repositoryCount"], 2)
                preview = service.handle("workspace.cleanup", {"workspaceId": created["id"]})
                self.assertTrue(preview["preview"])
                self.assertFalse(preview["removed"])
                cleaned = service.handle("workspace.cleanup", {"workspaceId": created["id"], "confirm": True})
                self.assertTrue(cleaned["removed"])
            finally:
                service.close()

    def test_path_outside_source_root_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "observer.json"
            write_config(config_path, root, [{"id": "outside", "path": "../outside"}])
            config = load_config(config_path)
            with self.assertRaises(WorkbenchError) as context:
                config.repository_path(config.repositories[0])
            self.assertEqual(context.exception.code, "path_outside_root")

    def test_unix_socket_returns_jsonl_response(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "observer.json"
            write_config(config_path, root, [])
            service = ObserverService(load_config(config_path))
            socket_path = root / "observer.sock"
            server = ThreadingUnixServer(str(socket_path), service)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.connect(str(socket_path))
                    client.sendall(b'{"id":7,"method":"observer.health","params":{}}\n')
                    response = json.loads(client.makefile("r", encoding="utf-8").readline())
                self.assertTrue(response["ok"])
                self.assertEqual(response["result"]["service"], "workspace-workbench")
            finally:
                server.shutdown()
                server.server_close()
                service.close()

    def test_graph_lanes_and_diff_ranges_are_renderer_neutral(self) -> None:
        rows = lane_layout([
            {"sha": "head", "parents": ["left", "right"]},
            {"sha": "left", "parents": ["base"]},
            {"sha": "right", "parents": ["base"]},
            {"sha": "base", "parents": []},
        ])
        self.assertTrue(rows[0]["merge"])
        self.assertGreaterEqual(rows[0]["laneCount"], 1)
        hunks = parse_patch("@@ -1,2 +1,3 @@\n-old\n+new\n context\n+extra\n")
        self.assertEqual(len(hunks), 1)
        self.assertEqual(changed_line_ranges(hunks), [(1, 3, "modified")])


if __name__ == "__main__":
    unittest.main()
