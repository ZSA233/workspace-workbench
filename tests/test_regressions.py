from __future__ import annotations

import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

from test_workbench import make_repository, run_git, write_config
from workspace_workbench.core.cache import ObservationCache
from workspace_workbench.core.config import load_config
from workspace_workbench.core.errors import WorkbenchError
from workspace_workbench.core.git import GitClient
from workspace_workbench.core.service import ObserverService


class Regressions(unittest.TestCase):
    def test_failed_multi_repository_creation_rolls_back_and_retains_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = make_repository(root, "api")
            other = make_repository(root, "other")
            config = root / "project.json"
            write_config(config, root, [{"id": "api", "path": "api"}, {"id": "other", "path": "other"}])
            service = ObserverService(load_config(config))
            try:
                original = GitClient.run
                def fail_second(git, args, *positional, **keywords):
                    if git.repository == other.resolve() and args[:2] == ["worktree", "add"]:
                        raise WorkbenchError("fixture add failure", code="git_failed")
                    return original(git, args, *positional, **keywords)
                with patch.object(GitClient, "run", fail_second), self.assertRaises(WorkbenchError) as error:
                    service.handle("workspace.create", {"name": "partial"})
                self.assertEqual(error.exception.code, "create_failed")
                record = service.provider.get("partial")
                self.assertEqual(record["state"], "create_failed")
                self.assertFalse(Path(record["treePath"]).exists())
                self.assertNotIn("obs/partial/api", run_git(repo, "branch", "--list"))
            finally:
                service.close()

    def test_creation_preflight_rejects_unknown_missing_and_bad_refs_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = make_repository(root, "api")
            config = root / "project.json"
            write_config(config, root, [{"id": "api", "path": "api"}, {"id": "missing", "path": "missing"}])
            service = ObserverService(load_config(config))
            try:
                for params in [{"repositories": ["api", "unknown"]}, {"repositories": ["api", "missing"]}, {"repositories": ["api"], "baseRefs": {"api": "no-such-ref"}}]:
                    with self.assertRaises(WorkbenchError):
                        service.handle("workspace.create", {"name": "preflight", **params})
                    self.assertEqual(list(service.provider.records_root.glob("*.json")), [])
                    self.assertFalse((service.provider.trees_root / "preflight").exists())
                    self.assertNotIn("obs/preflight/api", run_git(repo, "branch", "--list"))
            finally:
                service.close()

    def test_same_cold_request_single_flight_and_corrupt_sqlite_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.sqlite3"
            path.write_bytes(b"not a database")
            cache = ObservationCache(sqlite_path=path, max_entries=20, max_bytes=4096, sqlite_max_entries=20)
            calls = []
            def produce():
                calls.append(1)
                time.sleep(0.05)
                return {"value": 1, "observation": {"state": "ready"}}
            try:
                with ThreadPoolExecutor(max_workers=6) as pool:
                    results = list(pool.map(lambda _: cache.read("same", "same", produce), range(6)))
                self.assertEqual(len(calls), 1)
                self.assertTrue(all(item["value"] == 1 for item in results))
                self.assertEqual(cache.status()["sqlite"]["code"], "index_degraded")
            finally:
                cache.close()

    def test_root_merge_rename_and_untracked_diff(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = make_repository(Path(directory), "api")
            git = GitClient(repo)
            initial = git.head()
            self.assertEqual([item.path for item in git.changed_files("commit", commit=initial)], ["README.md"])
            self.assertIn("+initial", git.diff("commit", "README.md", commit=initial)[0])
            (repo / "new.txt").write_text("untracked\n")
            self.assertIn("+untracked", git.diff("working", "new.txt")[0])
            run_git(repo, "mv", "README.md", "renamed.md")
            renamed = next(item for item in git.changed_files("working") if item.path == "renamed.md")
            self.assertEqual(renamed.old_path, "README.md")
            self.assertEqual(renamed.additions, 0)
            branch = git.branch()
            run_git(repo, "commit", "-qam", "rename")
            run_git(repo, "checkout", "-qb", "topic")
            run_git(repo, "add", "new.txt")
            run_git(repo, "commit", "-qm", "topic")
            run_git(repo, "checkout", branch)
            run_git(repo, "merge", "--no-ff", "-qm", "merge", "topic")
            self.assertEqual([item.path for item in git.changed_files("commit", commit=git.head())], ["new.txt"])
            self.assertIn("+untracked", git.diff("commit", "new.txt", commit=git.head())[0])

    def test_lifecycle_identity_preview_dirty_and_review_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_repository(root, "api")
            config = root / "project.json"
            write_config(config, root, [{"id": "api", "path": "api"}])
            service = ObserverService(load_config(config))
            try:
                created = service.handle("workspace.create", {"name": "one"})
                self.assertEqual(service.handle("workspace.create", {"name": "one"})["id"], created["id"])
                target = Path(created["repositories"][0]["worktreePath"])
                self.assertEqual(service.provider.identify(str(target))["workspaceId"], "one")
                self.assertTrue((Path(created["treePath"]) / ".workspace/manifest.json").is_file())
                (target / "untracked.txt").write_text("keep me")
                with self.assertRaises(WorkbenchError) as error:
                    service.handle("workspace.cleanup", {"workspaceId": "one", "confirm": True})
                self.assertEqual(error.exception.code, "workspace_dirty")
                self.assertTrue((target / "untracked.txt").is_file())
                review = service.handle("review-set.brief", {"workspaceIds": ["one"]})
                repository = review["repositories"][0]
                self.assertIn("aggregate", repository)
                self.assertEqual(repository["entries"][0]["relation"], "already-contained")
                self.assertIn("api", review["brief"]["byRepository"])
                invalid = service.handle("review-set.brief", {"workspaceIds": ["one"], "targetRefs": {"api": "does-not-exist"}})
                self.assertEqual(invalid["repositories"][0]["status"], "needs-review")
                self.assertEqual(invalid["observation"]["state"], "partial")
            finally:
                service.close()

    def test_cache_revalidate_partial_and_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            kwargs = dict(sqlite_path=Path(directory) / "cache.sqlite3", max_entries=20, max_bytes=4096, sqlite_max_entries=20, ttl_seconds=0.5)
            cache = ObservationCache(**kwargs)
            def good(value):
                return {"value": value, "observation": {"state": "ready", "observedAt": "2026-01-01T00:00:00Z"}}
            cache.read("repo", "one", lambda: good(1))
            finished = threading.Event()
            def changed():
                finished.set()
                return good(2)
            old = cache.read("repo", "two", changed)
            self.assertEqual(old["value"], 1)
            self.assertTrue(finished.wait(2))
            cache.close()
            reopened = ObservationCache(**kwargs)
            try:
                self.assertEqual(reopened.read("repo", "two", lambda: good(3))["value"], 2)
                reopened.read("repo", "three", lambda: {"value": 99, "observation": {"state": "partial"}})
            finally:
                reopened.close()
            self.assertEqual(reopened.sqlite.latest("repo").payload["value"], 2)

    def test_toolchain_fail_closed_without_prepare(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_repository(root, "api")
            config = root / "project.json"
            write_config(config, root, [{"id": "api", "path": "api"}])
            raw = json.loads(config.read_text())
            raw["toolchain"] = {"manager": "mise", "repositories": {"api": {"go": "1.26"}}}
            config.write_text(json.dumps(raw))
            service = ObserverService(load_config(config))
            try:
                service.handle("workspace.create", {"name": "one"})
                with self.assertRaises(WorkbenchError) as error:
                    service.handle("workspace.runtime", {"workspaceId": "one"})
                self.assertEqual(error.exception.code, "toolchain_not_ready")
                self.assertEqual(service.handle("workspace.detail", {"workspaceId": "one"})["workspace"]["toolchain"]["status"], "needs_prepare")
                install_path = root / "runtime" / "1.26.4"
                install_path.mkdir(parents=True)
                (install_path / "bin").mkdir()
                (install_path / "bin" / "go").touch()
                from subprocess import CompletedProcess
                def installed(command, **kwargs):
                    return CompletedProcess(command, 0, "go version go1.26.4 fixture" if command[-1] == "version" else str(install_path), "")
                with patch("workspace_workbench.providers.toolchain.shutil.which", return_value="/fixture/mise"), patch("workspace_workbench.providers.toolchain.subprocess.run", side_effect=installed):
                    prepared = service.handle("workspace.prepare", {"workspaceId": "one", "repositoryId": "api"})
                self.assertEqual(prepared["resolved"]["go"], "1.26.4")
                self.assertEqual(service.handle("workspace.runtime", {"workspaceId": "one"})["toolchain"]["status"], "ready")
            finally:
                service.close()
