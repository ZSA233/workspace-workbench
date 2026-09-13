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
from workspace_workbench.core.errors import GitCommandError, WorkbenchError
from workspace_workbench.core.git import GitClient
from workspace_workbench.core.service import ObserverService


class Regressions(unittest.TestCase):
    def test_observer_reload_applies_runtime_settings_without_changing_project_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_repository(root, "api")
            config = root / "project.json"
            write_config(config, root, [{"id": "api", "path": "api"}])
            service = ObserverService(load_config(config))
            try:
                self.assertIsNone(service.toolchain)
                raw = json.loads(config.read_text(encoding="utf-8"))
                raw["toolchain"] = {"mode": "system", "manager": "system", "repositories": {"api": {}}}
                raw["cache"] = {"enabled": False}
                config.write_text(json.dumps(raw), encoding="utf-8")
                self.assertEqual(service.handle("observer.reload")["reloaded"], True)
                self.assertIsNotNone(service.toolchain)
                self.assertEqual(service.toolchain.mode, "system")
                self.assertFalse(service.config.cache_enabled)
            finally:
                service.close()

    def test_auto_toolchain_uses_matching_system_runtime_and_project_caches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_repository(root, "api")
            make_repository(root, "web")
            runtime_bin = root / "runtime-bin"
            runtime_bin.mkdir()
            go = runtime_bin / "go"
            go.write_text("#!/bin/sh\nprintf 'go version go1.26.8 fixture\\n'\n", encoding="utf-8")
            go.chmod(go.stat().st_mode | 0o111)
            config = root / "project.json"
            write_config(config, root, [{"id": "api", "path": "api"}, {"id": "web", "path": "web"}])
            raw = json.loads(config.read_text(encoding="utf-8"))
            raw["toolchain"] = {
                "manager": "mise",
                "mode": "auto",
                "runtimePaths": [str(runtime_bin)],
                "repositories": {"api": {"go": "1.26"}, "web": {"python": "3.12"}},
            }
            raw["cache"] = {"enabled": True}
            config.write_text(json.dumps(raw), encoding="utf-8")
            service = ObserverService(load_config(config))
            workspaces = []
            try:
                workspace = service.handle("workspace.create", {"name": "system-runtime", "repositories": ["api"]})
                workspaces.append(workspace)
                with patch("workspace_workbench.providers.toolchain.shutil.which", return_value=None):
                    prepared = service.handle("workspace.prepare", {"workspaceId": workspace["id"], "repositoryId": "api"})
                self.assertEqual(prepared["status"], "ready")
                self.assertEqual(prepared["sources"]["go"], "system")
                environment = service.toolchain.environment(workspace, "api")
                self.assertEqual(environment["GOCACHE"], str((root / ".state" / "cache" / "go-build").resolve()))
                self.assertEqual(environment["GOMODCACHE"], str((root / ".state" / "cache" / "go-mod").resolve()))
                self.assertNotIn("PIP_CACHE_DIR", environment)
                self.assertTrue(environment["PATH"].startswith(str(runtime_bin.resolve())))
                runtime = service.handle("workspace.runtime", {"workspaceId": workspace["id"]})
                self.assertEqual(runtime["toolchain"]["environment"]["variables"]["GOCACHE"], environment["GOCACHE"])
                second = service.handle("workspace.create", {"name": "system-runtime-two", "repositories": ["api"]})
                workspaces.append(second)
                with patch("workspace_workbench.providers.toolchain.shutil.which", return_value=None):
                    service.handle("workspace.prepare", {"workspaceId": second["id"], "repositoryId": "api"})
                self.assertEqual(service.toolchain.environment(second, "api")["GOCACHE"], environment["GOCACHE"])
            finally:
                for workspace in workspaces:
                    service.handle("workspace.cleanup", {"workspaceId": workspace["id"], "confirm": True})
                    service.handle("workspace.delete", {"workspaceId": workspace["id"], "confirm": True})
                service.close()

    def test_missing_manager_is_saved_with_actionable_details_when_system_runtime_is_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_repository(root, "api")
            config = root / "project.json"
            write_config(config, root, [{"id": "api", "path": "api"}])
            raw = json.loads(config.read_text(encoding="utf-8"))
            raw["toolchain"] = {
                "manager": "mise",
                "mode": "auto",
                "managerPath": str(root / "missing" / "mise"),
                "runtimePaths": [str(root / "missing" / "runtime")],
                "repositories": {"api": {"go": "9.99"}},
            }
            config.write_text(json.dumps(raw), encoding="utf-8")
            service = ObserverService(load_config(config))
            try:
                workspace = service.handle("workspace.create", {"name": "missing-runtime"})
                with patch("workspace_workbench.providers.toolchain.shutil.which", return_value=None):
                    prepared = service.handle("workspace.prepare", {"workspaceId": workspace["id"], "repositoryId": "api"})
                self.assertEqual(prepared["status"], "prepare_failed")
                self.assertEqual(prepared["issues"][0]["code"], "missing_manager")
                self.assertIn("Install mise", prepared["issues"][0]["message"])
                self.assertEqual(service.handle("workspace.detail", {"workspaceId": workspace["id"], "summary": True})["workspace"]["toolchain"]["issues"][0]["code"], "missing_manager")
            finally:
                service.close()

    def test_workspace_operation_timeout_is_separate_from_observation_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_repository(root, "api")
            config = root / "project.json"
            write_config(config, root, [{"id": "api", "path": "api"}])
            value = json.loads(config.read_text(encoding="utf-8"))
            value["limits"] = {"gitTimeoutSeconds": 3, "workspaceOperationTimeoutSeconds": 180}
            config.write_text(json.dumps(value), encoding="utf-8")

            loaded = load_config(config)
            self.assertEqual(loaded.git_timeout_seconds, 3)
            self.assertEqual(loaded.workspace_operation_timeout_seconds, 180)

    def test_timeout_after_worktree_add_is_reconciled_as_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = make_repository(root, "api")
            config = root / "project.json"
            write_config(config, root, [{"id": "api", "path": "api"}])
            service = ObserverService(load_config(config))
            original = GitClient.run

            def timeout_after_add(git, args, *positional, **keywords):
                result = original(git, args, *positional, **keywords)
                if tuple(args[:2]) == ("worktree", "add"):
                    raise GitCommandError("simulated timeout after Git completed", code="git_timeout")
                return result

            try:
                with patch.object(GitClient, "run", timeout_after_add):
                    created = service.handle("workspace.create", {"name": "slow-create"})
                self.assertEqual(created["state"], "active")
                worktree = Path(created["repositories"][0]["worktreePath"])
                self.assertTrue(worktree.is_dir())
                self.assertIn(str(worktree), run_git(repo, "worktree", "list", "--porcelain"))
                self.assertIn(created["repositories"][0]["branch"], run_git(repo, "branch", "--list"))
            finally:
                service.close()

    def test_same_request_recovers_a_complete_failed_creation_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_repository(root, "api")
            config = root / "project.json"
            write_config(config, root, [{"id": "api", "path": "api"}])
            service = ObserverService(load_config(config))
            try:
                params = {"name": "recoverable"}
                created = service.handle("workspace.create", params)
                failed = dict(service.provider.get("recoverable"))
                failed["state"] = "create_failed"
                failed["issues"] = [{"code": "git_timeout", "message": "simulated"}]
                service.provider._write_record(failed)

                recovered = service.handle("workspace.create", params)
                self.assertEqual(recovered["state"], "active")
                self.assertEqual(recovered["id"], created["id"])
                self.assertNotIn("issues", service.provider.get("recoverable"))
                self.assertEqual(json.loads((Path(created["treePath"]) / ".workspace/manifest.json").read_text())["state"], "active")
            finally:
                service.close()

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
                removed = service.handle("workspace.remove", {"workspaceId": "partial"})
                self.assertEqual(removed["state"], "removed")
                deleted = service.handle("workspace.delete", {"workspaceId": "partial", "confirm": True})
                self.assertTrue(deleted["deleted"])
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

    def test_safe_workspace_removal_supports_dirty_restore_pending_and_explicit_delete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = make_repository(root, "api")
            config = root / "project.json"
            write_config(config, root, [{"id": "api", "path": "api"}])
            service = ObserverService(load_config(config))
            try:
                created = service.handle("workspace.create", {"name": "safe-delete"})
                target = Path(created["repositories"][0]["worktreePath"])
                branch = created["repositories"][0]["branch"]
                (target / "keep.txt").write_text("retain until explicit deletion\n", encoding="utf-8")

                removed = service.handle("workspace.remove", {"workspaceId": "safe-delete"})
                self.assertEqual(removed["state"], "removed")
                self.assertTrue(target.is_dir())
                self.assertEqual(service.provider.get("safe-delete")["state"], "removed")
                self.assertEqual([item["id"] for item in service.handle("workspace.list")["workspaces"]], ["main"])
                self.assertIn("safe-delete", [item["id"] for item in service.handle("workspace.list", {"includeRemoved": True})["workspaces"]])

                restored = service.handle("workspace.restore", {"workspaceId": "safe-delete"})
                self.assertEqual(restored["state"], "active")
                pending = service.handle("workspace.remove", {"workspaceId": "safe-delete", "activeTasks": [{"kind": "agent", "id": "agent-1", "status": "running"}]})
                self.assertEqual(pending["state"], "deletion_pending")
                with self.assertRaises(WorkbenchError) as error:
                    service.handle("workspace.delete", {"workspaceId": "safe-delete", "confirm": True})
                self.assertEqual(error.exception.code, "workspace_task_active")
                self.assertEqual(service.handle("workspace.restore", {"workspaceId": "safe-delete"})["state"], "active")

                service.handle("workspace.remove", {"workspaceId": "safe-delete"})
                preview = service.handle("workspace.delete", {"workspaceId": "safe-delete"})
                self.assertTrue(preview["preview"])
                self.assertEqual(preview["dirtyRepositories"], 1)
                deleted = service.handle("workspace.delete", {"workspaceId": "safe-delete", "confirm": True})
                self.assertTrue(deleted["deleted"])
                self.assertFalse(target.exists())
                self.assertIn(branch, run_git(repo, "branch", "--list"))
                with self.assertRaises(WorkbenchError):
                    service.provider.get("safe-delete")
            finally:
                service.close()

    def test_permanent_delete_recovers_from_a_missing_worktree_git_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = make_repository(root, "api")
            config = root / "project.json"
            write_config(config, root, [{"id": "api", "path": "api"}])
            service = ObserverService(load_config(config))
            try:
                created = service.handle("workspace.create", {"name": "stale-worktree"})
                target = Path(created["repositories"][0]["worktreePath"])
                branch = created["repositories"][0]["branch"]
                marker = target / ".git"
                self.assertTrue(marker.is_file())
                marker.unlink()

                service.handle("workspace.remove", {"workspaceId": "stale-worktree"})
                deleted = service.handle("workspace.delete", {"workspaceId": "stale-worktree", "confirm": True})

                self.assertTrue(deleted["deleted"])
                self.assertFalse(target.exists())
                self.assertIn(branch, run_git(repo, "branch", "--list"))
                self.assertNotIn(str(target), run_git(repo, "worktree", "list", "--porcelain"))
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
            self.assertEqual(reopened.sqlite.latest("repo").payload["value"], 99)
            self.assertEqual(reopened.sqlite.latest("repo").payload["observation"]["state"], "partial")

    def test_partial_refresh_is_completed_and_does_not_reenter_refresh_loop(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = ObservationCache(
                sqlite_path=Path(directory) / "cache.sqlite3",
                max_entries=20,
                max_bytes=4096,
                sqlite_max_entries=20,
                ttl_seconds=0.05,
            )
            finished = threading.Event()

            try:
                cache.read("repo", "one", lambda: {"value": 1, "observation": {"state": "ready", "observedAt": "2026-01-01T00:00:00Z"}})
                time.sleep(0.06)
                pending = cache.read(
                    "repo",
                    "two",
                    lambda: (
                        finished.set(),
                        {"value": 2, "observation": {"state": "partial", "observedAt": "2026-01-01T00:00:01Z", "issues": [{"code": "git_timeout"}]}}
                    )[1],
                )
                self.assertEqual(pending["observation"]["cacheState"], "refreshing")
                self.assertTrue(finished.wait(2))
                completed = cache.read("repo", "two", lambda: {"value": 3, "observation": {"state": "ready"}})
                self.assertEqual(completed["value"], 2)
                self.assertEqual(completed["observation"]["cacheState"], "degraded")
                self.assertFalse(completed["observation"]["refreshing"])
            finally:
                cache.close()

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
                    prepared_alias = service.handle("workspace.prepare", {"workspaceId": "one", "repoPath": str((root / "api").resolve())})
                self.assertEqual(prepared["resolved"]["go"], "1.26.4")
                self.assertEqual(prepared_alias["repositoryId"], "api")
                self.assertEqual(service.handle("workspace.runtime", {"workspaceId": "one"})["toolchain"]["status"], "ready")
            finally:
                service.close()
